import type { Bindings } from "../../../models/db";
import type {
  OutboxConsumer,
  StoredOutboxEvent,
} from "../../../platform/queues/outbox";
import { parsePublicStatusSnapshot } from "../domain/public-contract";
import { D1StatusRepository } from "../persistence/D1StatusRepository";
import { writeStructuredLog } from "../../../platform/observability/StructuredLogger";
import { sha256Hex } from "../../../utils/crypto";
import { getEnvNumber } from "../../../utils/env";

/** 被顶下去的发布至少留这么久再删，默认 15 分钟。 */
export const DEFAULT_STATUS_PUBLICATION_GRACE_MINUTES = 15;

/**
 * 切换 active_publication_id 之后立刻回收被顶下去的发布。
 *
 * 读路径（getActivePublication / getActiveMetricPublication）只认
 * status_publication_state.active_publication_id，非活跃的发布一行也读不到。
 * 但 status_metric_publications 每次发布都要为每台 agent 落一份 24 小时指标的
 * 完整 JSON（实测约 300 KB/行、每 5 分钟一轮），等每天一次的 cleanup 才删的话，
 * 单台 agent 就能攒出上百 MB——比它要展示的块表数据本身大两个数量级。
 *
 * 宽限期不是留给读路径的，是留给并发的 outbox 消费者：另一个消费者可能已经插入
 * 新发布但还没来得及切 active，此时把它当"非活跃"删掉，会让它切过去之后 JOIN 落空。
 */
export async function pruneSupersededPublications(
  env: Bindings,
  activePublicationId: number,
  nowMs: number = Date.now()
) {
  const graceMinutes = getEnvNumber(
    env,
    "STATUS_PUBLICATION_GRACE_MINUTES",
    DEFAULT_STATUS_PUBLICATION_GRACE_MINUTES,
    { min: 1, max: 1440 }
  );
  const cutoff = new Date(nowMs - graceMinutes * 60_000).toISOString();
  // 不依赖 ON DELETE cascade：子表先删，父表后删，两条语句合成一个 batch 走隐式事务。
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM status_metric_publications
       WHERE status_publication_id IN (
         SELECT id FROM status_publications
         WHERE id <> ? AND generated_at < ?
       )`
    ).bind(activePublicationId, cutoff),
    env.DB.prepare(
      `DELETE FROM status_publications WHERE id <> ? AND generated_at < ?`
    ).bind(activePublicationId, cutoff),
  ]);
  return { deleted: results[1]?.meta?.changes ?? 0, cutoff };
}

export class StatusPublicationConsumer implements OutboxConsumer {
  readonly consumerName = "status.publication.v1";
  readonly eventTypes = [
    "monitor.checked",
    "agent.status.changed",
    "status.rebuild.requested",
  ] as const;

  constructor(private readonly env: Bindings) {}

  async process(event: StoredOutboxEvent) {
    const existing = await this.env.DB.prepare(
      `SELECT id, payload_json, etag, generated_at
       FROM status_publications WHERE source_event_id = ? LIMIT 1`
    )
      .bind(event.event_id)
      .first<{ id: number; payload_json: string; etag: string; generated_at: string }>();
    let publicationId = existing?.id;
    let payloadJson = existing?.payload_json;
    let etag = existing?.etag;
    let generatedAt = existing?.generated_at;
    const now = new Date();
    const nowIso = now.toISOString();
    if (publicationId === undefined) {
      const data = await new D1StatusRepository(this.env).buildPublicData();
      payloadJson = JSON.stringify(data);
      if (!parsePublicStatusSnapshot(payloadJson)) {
        throw new Error("Public status publication failed the safe DTO contract");
      }
      etag = `"sha256-${await sha256Hex(payloadJson)}"`;
      generatedAt = nowIso;
      const inserted = await this.env.DB.prepare(
        `INSERT OR IGNORE INTO status_publications
         (source_event_id, payload_json, etag, generated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
        .bind(event.event_id, payloadJson, etag, generatedAt, nowIso, nowIso)
        .first<{ id: number }>();
      publicationId = inserted?.id;
      if (publicationId === undefined) {
        const conflicted =
          await this.env.DB.prepare(
            `SELECT id, payload_json, etag, generated_at
             FROM status_publications WHERE source_event_id = ? LIMIT 1`
          )
            .bind(event.event_id)
            .first<{
              id: number;
              payload_json: string;
              etag: string;
              generated_at: string;
            }>();
        publicationId = conflicted?.id;
        payloadJson = conflicted?.payload_json;
        etag = conflicted?.etag;
        generatedAt = conflicted?.generated_at;
      }
      if (publicationId === undefined) {
        throw new Error("Status publication insert conflict could not be resolved");
      }
    }

    if (!payloadJson || !etag || !generatedAt) {
      throw new Error("Status publication payload is incomplete");
    }
    const parsedSnapshot = parsePublicStatusSnapshot(payloadJson);
    if (!parsedSnapshot) {
      throw new Error("Stored status publication failed the safe DTO contract");
    }
    const agentIds = (parsedSnapshot.agents as unknown[]).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const id = Number((item as { id?: unknown }).id);
      return Number.isSafeInteger(id) && id > 0 ? [id] : [];
    });
    const metricDrafts = await new D1StatusRepository(
      this.env
    ).buildPublicAgentMetricPublications(agentIds);
    const metricRows = await Promise.all(
      metricDrafts.map(async (draft) => {
        const metricPayload = JSON.stringify({ success: true, agent: draft.metrics });
        if (!parsePublicStatusSnapshot(JSON.stringify({ monitors: [], agents: draft.metrics }))) {
          throw new Error("Public metric publication failed the safe DTO contract");
        }
        return {
          agent_id: draft.agentId,
          payload_json: metricPayload,
          etag: `"sha256-${await sha256Hex(metricPayload)}"`,
        };
      })
    );
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO status_metric_publications
       (status_publication_id, agent_id, payload_json, etag, generated_at,
        created_at, updated_at)
       SELECT ?,
              CAST(json_extract(value, '$.agent_id') AS INTEGER),
              json_extract(value, '$.payload_json'),
              json_extract(value, '$.etag'), ?, ?, ?
       FROM json_each(?)`
    )
      .bind(
        publicationId,
        generatedAt,
        nowIso,
        nowIso,
        JSON.stringify(metricRows)
      )
      .run();
    const metricCount = await this.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM status_metric_publications
       WHERE status_publication_id = ?`
    )
      .bind(publicationId)
      .first<{ count: number }>();
    if (Number(metricCount?.count ?? 0) !== agentIds.length) {
      throw new Error("Public metric publication set is incomplete");
    }

    const ttlSeconds = getEnvNumber(
      this.env,
      "STATUS_PAGE_CACHE_TTL_SECONDS",
      60,
      { min: 0, max: 3600 }
    );
    const publicationState = this.env.DB.prepare(
      `INSERT INTO status_publication_state(singleton_key, active_publication_id, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(singleton_key) DO UPDATE SET
         active_publication_id = excluded.active_publication_id,
         updated_at = excluded.updated_at`
    ).bind(publicationId, nowIso);
    await publicationState.run();

    // 回收失败不能让发布事件整体失败重放：记一条日志，交给每日 cleanup 兜底。
    try {
      const pruned = await pruneSupersededPublications(
        this.env,
        publicationId,
        now.getTime()
      );
      if (pruned.deleted > 0) {
        writeStructuredLog(this.env, {
          service: "queue",
          operation: "status_publication_prune",
          result: "success",
          eventId: event.event_id,
          fields: { deleted: pruned.deleted, cutoff: pruned.cutoff },
        });
      }
    } catch (error) {
      writeStructuredLog(this.env, {
        service: "queue",
        operation: "status_publication_prune",
        result: "failure",
        eventId: event.event_id,
        errorCode: "STATUS_PUBLICATION_PRUNE_FAILED",
        error,
      });
    }
  }
}
