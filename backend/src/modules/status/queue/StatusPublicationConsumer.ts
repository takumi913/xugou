import type { Bindings } from "../../../models/db";
import type {
  OutboxConsumer,
  StoredOutboxEvent,
} from "../../../platform/queues/outbox";
import { parsePublicStatusSnapshot } from "../domain/public-contract";
import { D1StatusRepository } from "../persistence/D1StatusRepository";
import { sha256Hex } from "../../../utils/crypto";
import { getEnvNumber } from "../../../utils/env";
import { isContractMode } from "../../../platform/compatibility/CompatibilityMode";

export class StatusPublicationConsumer implements OutboxConsumer {
  readonly consumerName = "status.publication.v1";
  readonly eventTypes = [
    "monitor.checked",
    "agent.report.processed",
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
    if (isContractMode(this.env)) {
      await publicationState.run();
      return;
    }
    await this.env.DB.batch([
      publicationState,
      this.env.DB.prepare(
          `INSERT INTO public_status_snapshots
           (id, snapshot_json, etag, generated_at, expires_at, dirty_at,
            refresh_after, refreshing, last_error)
           VALUES (1, ?, ?, ?, ?, NULL, NULL, 0, NULL)
           ON CONFLICT(id) DO UPDATE SET
             snapshot_json = excluded.snapshot_json, etag = excluded.etag,
             generated_at = excluded.generated_at, expires_at = excluded.expires_at,
             dirty_at = NULL, refresh_after = NULL, refreshing = 0, last_error = NULL`
        ).bind(
          payloadJson,
          etag,
          generatedAt,
          new Date(now.getTime() + ttlSeconds * 1000).toISOString()
        ),
    ]);
  }
}
