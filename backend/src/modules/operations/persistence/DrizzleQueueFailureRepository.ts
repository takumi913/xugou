import { and, asc, count, eq, gt, inArray, min, sql } from "drizzle-orm";
import type { AppDatabase } from "../../../config/db";
import {
  asyncJobs,
  domainOutbox,
  notificationMessages,
  queueFailures,
} from "../../../db/schema";
import { isXugouQueueMessage } from "../../../platform/queues/messages";
import type { QueueFailureRepositoryPort } from "../application/QueueFailureUseCases";
import type { QueueFailureView } from "../domain/models";

function toView(row: typeof queueFailures.$inferSelect): QueueFailureView {
  return {
    failure_id: row.failure_id,
    queue_name: row.queue_name,
    message_id: row.message_id,
    source_kind: row.source_kind,
    source_id: row.source_id,
    delivery_attempts: row.delivery_attempts,
    last_error: row.last_error,
    status: row.status,
    replay_count: row.replay_count,
    replayed_at: row.replayed_at,
    terminated_at: row.terminated_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class DrizzleQueueFailureRepository implements QueueFailureRepositoryPort {
  constructor(private readonly db: AppDatabase) {}

  async listPage(input: { afterId?: string; status?: string; limit: number }) {
    const conditions = [];
    if (input.afterId) conditions.push(gt(queueFailures.failure_id, input.afterId));
    if (input.status) conditions.push(eq(queueFailures.status, input.status));
    const rows = await this.db
      .select()
      .from(queueFailures)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(queueFailures.failure_id))
      .limit(input.limit);
    return rows.map(toView);
  }

  async findById(id: string) {
    const rows = await this.db
      .select()
      .from(queueFailures)
      .where(eq(queueFailures.failure_id, id))
      .limit(1);
    if (!rows[0]) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rows[0].message_json);
    } catch {
      return null;
    }
    return isXugouQueueMessage(parsed)
      ? { ...toView(rows[0]), message: parsed }
      : null;
  }

  async health(now: string) {
    const [jobGroups, outboxGroups, notificationGroups, failureCount, oldestJob, oldestOutbox] =
      await Promise.all([
        this.db
          .select({ status: asyncJobs.status, value: count() })
          .from(asyncJobs)
          .groupBy(asyncJobs.status),
        this.db
          .select({ status: domainOutbox.status, value: count() })
          .from(domainOutbox)
          .groupBy(domainOutbox.status),
        this.db
          .select({ status: notificationMessages.status, value: count() })
          .from(notificationMessages)
          .groupBy(notificationMessages.status),
        this.db
          .select({ value: count() })
          .from(queueFailures)
          .where(eq(queueFailures.status, "open")),
        this.db
          .select({ value: min(asyncJobs.available_at) })
          .from(asyncJobs)
          .where(inArray(asyncJobs.status, ["pending", "retry", "processing"])),
        this.db
          .select({ value: min(domainOutbox.available_at) })
          .from(domainOutbox)
          .where(inArray(domainOutbox.status, ["pending", "published"])),
      ]);
    const counts = (rows: Array<{ status: string; value: number }>) =>
      Object.fromEntries(rows.map((row) => [row.status, Number(row.value)]));
    const lag = (value: string | null | undefined) => {
      const timestamp = value ? Date.parse(value) : Number.NaN;
      return Number.isFinite(timestamp)
        ? Math.max(0, Math.floor((Date.parse(now) - timestamp) / 1000))
        : 0;
    };
    return {
      generated_at: now,
      jobs: counts(jobGroups),
      outbox: counts(outboxGroups),
      notifications: counts(notificationGroups),
      open_failures: Number(failureCount[0]?.value ?? 0),
      oldest_job_available_at: oldestJob[0]?.value ?? null,
      oldest_outbox_available_at: oldestOutbox[0]?.value ?? null,
      job_lag_seconds: lag(oldestJob[0]?.value),
      outbox_lag_seconds: lag(oldestOutbox[0]?.value),
    };
  }

  async prepareReplay(id: string, now: string) {
    const row = await this.findById(id);
    if (!row || row.status !== "open") return false;
    if (row.message.kind === "job") {
      await this.db
        .update(asyncJobs)
        .set({
          status: "retry",
          attempts: 0,
          available_at: now,
          lease_token: null,
          lease_expires_at: null,
          last_error: null,
          completed_at: null,
          updated_at: now,
        })
        .where(eq(asyncJobs.id, row.message.job_id));
    } else {
      await this.db
        .update(domainOutbox)
        .set({
          status: "pending",
          available_at: now,
          published_at: null,
          processed_at: null,
          last_error: null,
          updated_at: now,
        })
        .where(eq(domainOutbox.event_id, row.message.event_id));
      await this.db.run(sql`
        UPDATE notification_messages
        SET status = 'retry', attempts = 0, available_at = ${now},
            lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
            sent_at = NULL, updated_at = ${now}
        WHERE event_id IN (
          SELECT event_id FROM notification_events
          WHERE source_event_id = ${row.message.event_id}
        ) AND status = 'failed'
      `);
    }
    return true;
  }

  async markReplayed(id: string, now: string) {
    await this.db
      .update(queueFailures)
      .set({
        status: "replayed",
        replay_count: 1,
        replayed_at: now,
        updated_at: now,
      })
      .where(and(eq(queueFailures.failure_id, id), eq(queueFailures.status, "open")));
  }

  async terminate(id: string, now: string) {
    const row = await this.findById(id);
    if (!row || row.status !== "open") return false;
    if (row.message.kind === "job") {
      await this.db
        .update(asyncJobs)
        .set({ status: "failed", lease_token: null, lease_expires_at: null, updated_at: now })
        .where(eq(asyncJobs.id, row.message.job_id));
    } else {
      await this.db
        .update(domainOutbox)
        .set({ status: "failed", updated_at: now })
        .where(eq(domainOutbox.event_id, row.message.event_id));
      await this.db.run(sql`
        UPDATE notification_messages
        SET status = 'terminated', lease_token = NULL, lease_expires_at = NULL,
            updated_at = ${now}
        WHERE event_id IN (
          SELECT event_id FROM notification_events
          WHERE source_event_id = ${row.message.event_id}
        ) AND status IN ('pending', 'retry', 'sending', 'failed')
      `);
    }
    const updated = await this.db
      .update(queueFailures)
      .set({ status: "terminated", terminated_at: now, updated_at: now })
      .where(and(eq(queueFailures.failure_id, id), eq(queueFailures.status, "open")))
      .returning({ id: queueFailures.failure_id });
    return updated.length > 0;
  }
}
