import type { Bindings } from "../../../models/db";
import { writeStructuredLog } from "../../../platform/observability/StructuredLogger";
import { QueueJobPublisher } from "../../../platform/queues/QueuePublisher";

export interface StatusRebuildRequest {
  reason: string;
  aggregateType: "agent" | "monitor" | "status_page";
  aggregateId: string | number;
  coalesceSeconds?: number;
}

function eventBucket(now: Date, coalesceSeconds: number) {
  if (coalesceSeconds <= 0) return crypto.randomUUID();
  return Math.floor(now.getTime() / (coalesceSeconds * 1000)).toString(36);
}

/**
 * 将状态页重建请求与业务写入解耦。事件先持久化到 D1 outbox，Queue 暂时异常时
 * 由定时 relay 继续投递；同一聚合根在合并窗口内只生成一条事件。
 */
export async function requestStatusRebuild(
  env: Bindings,
  request: StatusRebuildRequest
) {
  const now = new Date();
  const nowIso = now.toISOString();
  const coalesceSeconds = Math.max(0, request.coalesceSeconds ?? 0);
  const eventId = [
    "status.rebuild.requested",
    request.reason,
    request.aggregateType,
    String(request.aggregateId),
    eventBucket(now, coalesceSeconds),
  ].join(":");
  const payload = JSON.stringify({
    reason: request.reason,
    aggregate_type: request.aggregateType,
    aggregate_id: String(request.aggregateId),
    requested_at: nowIso,
  });

  await env.DB.prepare(
    `INSERT OR IGNORE INTO domain_outbox
     (event_id, event_type, aggregate_type, aggregate_id, payload_json, status,
      attempts, available_at, created_at, updated_at)
     VALUES (?, 'status.rebuild.requested', ?, ?, ?, 'pending', 0, ?, ?, ?)`
  )
    .bind(
      eventId,
      request.aggregateType,
      String(request.aggregateId),
      payload,
      nowIso,
      nowIso,
      nowIso
    )
    .run();

  const pending = await env.DB.prepare(
    `SELECT event_id FROM domain_outbox
     WHERE event_id = ? AND status = 'pending' LIMIT 1`
  )
    .bind(eventId)
    .first<{ event_id: string }>();
  if (!pending) return;

  try {
    await new QueueJobPublisher(env.XUGOU_JOBS).publishOutbox(eventId);
    const publishedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE domain_outbox SET status = 'published', attempts = attempts + 1,
       published_at = ?, last_error = NULL, updated_at = ?
       WHERE event_id = ? AND status = 'pending'`
    )
      .bind(publishedAt, publishedAt, eventId)
      .run();
  } catch (error) {
    writeStructuredLog(env, {
      service: "queue",
      operation: "publish_status_rebuild_outbox",
      result: "deferred",
      eventId,
      entityType: request.aggregateType,
      entityId: request.aggregateId,
      errorCode: "STATUS_REBUILD_PUBLISH_DEFERRED",
      error,
    });
  }
}

/** Cron bootstrap: anonymous reads remain read-only while the first publication is queued. */
export async function ensureInitialStatusPublication(env: Bindings) {
  const active = await env.DB.prepare(
    `SELECT active_publication_id FROM status_publication_state
     WHERE singleton_key = 1 AND active_publication_id IS NOT NULL LIMIT 1`
  ).first<{ active_publication_id: number }>();
  if (active) return false;
  await requestStatusRebuild(env, {
    reason: "bootstrap",
    aggregateType: "status_page",
    aggregateId: 1,
    coalesceSeconds: 3600,
  });
  return true;
}
