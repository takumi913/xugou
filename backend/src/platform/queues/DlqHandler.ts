import type { Bindings } from "../../models/db";
import { isXugouQueueMessage } from "./messages";
import type { QueueBatchLike } from "./QueueDispatcher";

export async function captureDeadLetters(batch: QueueBatchLike, env: Bindings) {
  for (const message of batch.messages) {
    const body = message.body;
    const valid = isXugouQueueMessage(body);
    const sourceKind = valid ? body.kind : null;
    const sourceId = valid
      ? body.kind === "job"
        ? body.job_id
        : body.event_id
      : null;
    let lastError: string | null = null;
    let sourceAttempts = 0;
    if (sourceKind === "job" && sourceId) {
      const source = await env.DB.prepare(
        `SELECT last_error, attempts FROM async_jobs WHERE id = ? LIMIT 1`
      )
        .bind(sourceId)
        .first<{ last_error: string | null; attempts: number }>();
      lastError = source?.last_error ?? null;
      sourceAttempts = Number(source?.attempts ?? 0);
    } else if (sourceKind === "outbox" && sourceId) {
      const source = await env.DB.prepare(
        `SELECT last_error, attempts FROM domain_outbox WHERE event_id = ? LIMIT 1`
      )
        .bind(sourceId)
        .first<{ last_error: string | null; attempts: number }>();
      lastError = source?.last_error ?? null;
      sourceAttempts = Number(source?.attempts ?? 0);
    }
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO queue_failures
       (failure_id, queue_name, message_id, message_json, source_kind, source_id,
        delivery_attempts, last_error, status, replay_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)
       ON CONFLICT(queue_name, message_id) DO UPDATE SET
         delivery_attempts = excluded.delivery_attempts,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`
    )
      .bind(
        `${batch.queue}:${message.id}`,
        batch.queue,
        message.id,
        JSON.stringify(body),
        sourceKind,
        sourceId,
        Math.max(message.attempts, sourceAttempts),
        lastError,
        now,
        now
      )
      .run();
    message.ack();
  }
}
