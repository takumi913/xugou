import type { Bindings } from "../../../models/db";
import { legacyMonitorModelCoverage } from "../../../platform/migrations/LegacyMonitorModelBackfill";
import { writeStructuredLog } from "../../../platform/observability/StructuredLogger";
import { getEnvNumber } from "../../../utils/env";
import { QueueJobPublisher } from "../../../platform/queues/QueuePublisher";
import { isContractMode } from "../../../platform/compatibility/CompatibilityMode";

export interface MonitorSchedulerOptions {
  monotonicNow?: () => number;
}

export async function scheduleDueMonitorChecks(
  env: Bindings,
  scheduledAt = new Date(),
  options: MonitorSchedulerOptions = {}
) {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const startedAt = monotonicNow();
  const now = scheduledAt.toISOString();
  const nowMs = scheduledAt.getTime();
  const limit = getEnvNumber(env, "MONITOR_CHECK_BATCH_SIZE", 100, {
    min: 1,
    max: 100,
  });
  const timeBudgetMs = getEnvNumber(env, "MONITOR_SCHEDULER_TIME_BUDGET_MS", 5_000, {
    min: 100,
    max: 25_000,
  });
  const minimumInterval = getEnvNumber(env, "MIN_MONITOR_INTERVAL_SECONDS", 300, {
    min: 1,
    max: 86400,
  });
  const contractMode = isContractMode(env);
  const targetReady =
    contractMode || (await legacyMonitorModelCoverage(env)).read_ready;
  const publisher = new QueueJobPublisher(env.XUGOU_JOBS);
  let cursorDueMs = -1;
  let cursorId = 0;
  let scheduled = 0;
  let published = 0;
  let batches = 0;
  let budgetExhausted = false;

  for (;;) {
    if (monotonicNow() - startedAt >= timeBudgetMs) {
      budgetExhausted = true;
      break;
    }
    const due = targetReady
      ? await env.DB.prepare(
        `SELECT d.id, d.interval_ms,
                COALESCE(r.next_due_at_ms, 0) AS scheduled_for_ms
         FROM monitor_definitions d
         JOIN monitor_runtime r ON r.monitor_id = d.id
         WHERE d.active = 1 AND d.deleted_at_ms IS NULL
           AND (r.next_due_at_ms <= ? OR r.next_due_at_ms IS NULL)
           AND (COALESCE(r.next_due_at_ms, 0) > ? OR
                (COALESCE(r.next_due_at_ms, 0) = ? AND d.id > ?))
         ORDER BY r.next_due_at_ms ASC, d.id ASC LIMIT ?`
      )
        .bind(nowMs, cursorDueMs, cursorDueMs, cursorId, limit)
        .all<{ id: number; interval_ms: number; scheduled_for_ms: number | null }>()
      : await env.DB.prepare(
        `SELECT id, interval * 1000 AS interval_ms,
                COALESCE(CAST(unixepoch(next_check_at, 'subsec') * 1000 AS INTEGER), 0)
                  AS scheduled_for_ms
         FROM monitors
         WHERE active = 1 AND deleted_at IS NULL
           AND (next_check_at <= ? OR next_check_at IS NULL)
           AND (COALESCE(CAST(unixepoch(next_check_at, 'subsec') * 1000 AS INTEGER), 0) > ? OR
                (COALESCE(CAST(unixepoch(next_check_at, 'subsec') * 1000 AS INTEGER), 0) = ?
                 AND id > ?))
         ORDER BY next_check_at ASC, id ASC LIMIT ?`
      )
        .bind(now, cursorDueMs, cursorDueMs, cursorId, limit)
        .all<{ id: number; interval_ms: number; scheduled_for_ms: number | null }>();
    if (due.results.length === 0) break;
    batches += 1;
    const jobs = due.results.map((monitor) => {
      const scheduledForMs = Number.isSafeInteger(monitor.scheduled_for_ms)
        ? Number(monitor.scheduled_for_ms)
        : 0;
      const intervalMs = Math.max(monitor.interval_ms, minimumInterval * 1000);
      const nextDueMs = nowMs + intervalMs;
      const jobId = `monitor-check:${monitor.id}:${scheduledForMs || nowMs}`;
      return {
        monitor_id: monitor.id,
        job_id: jobId,
        payload_json: JSON.stringify({
          monitor_id: monitor.id,
          scheduled_for_ms: scheduledForMs || nowMs,
        }),
        next_due_ms: nextDueMs,
        next_due: new Date(nextDueMs).toISOString(),
      };
    });
    const jobsJson = JSON.stringify(jobs);
    const jobIds = jobs.map((job) => job.job_id);
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT OR IGNORE INTO async_jobs
         (id, kind, dedup_key, aggregate_type, aggregate_id, payload_json,
          status, attempts, max_attempts, available_at, created_at, updated_at)
         SELECT json_extract(value, '$.job_id'), 'monitor.check',
                json_extract(value, '$.job_id'), 'monitor',
                CAST(json_extract(value, '$.monitor_id') AS TEXT),
                json_extract(value, '$.payload_json'),
                'pending', 0, 5, ?, ?, ?
         FROM json_each(?)`
      ).bind(now, now, now, jobsJson),
      env.DB.prepare(
        `UPDATE monitor_runtime
         SET next_due_at_ms = (
               SELECT CAST(json_extract(value, '$.next_due_ms') AS INTEGER)
               FROM json_each(?)
               WHERE CAST(json_extract(value, '$.monitor_id') AS INTEGER) = monitor_id
             ),
             version = version + 1,
             updated_at_ms = ?
         WHERE monitor_id IN (
           SELECT CAST(json_extract(value, '$.monitor_id') AS INTEGER)
           FROM json_each(?)
         )`
      ).bind(jobsJson, nowMs, jobsJson),
    ];
    if (!contractMode) {
      statements.push(
        env.DB.prepare(
          `UPDATE monitors
           SET next_check_at = (
             SELECT json_extract(value, '$.next_due')
             FROM json_each(?)
             WHERE CAST(json_extract(value, '$.monitor_id') AS INTEGER) = monitors.id
           )
           WHERE deleted_at IS NULL AND id IN (
             SELECT CAST(json_extract(value, '$.monitor_id') AS INTEGER)
             FROM json_each(?)
           )`
        ).bind(jobsJson, jobsJson)
      );
    }
    await env.DB.batch(statements);
    scheduled += jobs.length;
    try {
      await publisher.publishJobs(jobIds);
      published += jobIds.length;
    } catch (error) {
      writeStructuredLog(env, {
        service: "queue",
        operation: "publish_scheduled_monitor_checks",
        result: "deferred",
        errorCode: "MONITOR_SCHEDULE_PUBLISH_DEFERRED",
        error,
        fields: { batch_size: jobIds.length },
      });
    }
    const last = due.results.at(-1);
    if (!last) break;
    cursorDueMs = Number(last.scheduled_for_ms ?? 0);
    cursorId = last.id;
    if (due.results.length < limit) break;
  }
  return {
    scheduled,
    published,
    batches,
    budget_exhausted: budgetExhausted,
    duration_ms: Math.max(0, monotonicNow() - startedAt),
  };
}

export async function scheduleMonitorCheckNow(env: Bindings, monitorId: number) {
  const contractMode = isContractMode(env);
  const monitor = await env.DB.prepare(
    contractMode
      ? `SELECT id FROM monitor_definitions
         WHERE id = ? AND deleted_at_ms IS NULL LIMIT 1`
      : `SELECT id FROM monitors WHERE id = ? AND deleted_at IS NULL LIMIT 1`
  )
    .bind(monitorId)
    .first<{ id: number }>();
  if (!monitor) return null;
  const now = new Date().toISOString();
  const scheduledForMs = Date.now();
  const jobId = `monitor-check:${monitorId}:manual:${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO async_jobs
     (id, kind, dedup_key, aggregate_type, aggregate_id, payload_json, status,
      attempts, max_attempts, available_at, created_at, updated_at)
     VALUES (?, 'monitor.check', ?, 'monitor', ?, ?, 'pending', 0, 5, ?, ?, ?)`
  )
    .bind(
      jobId,
      jobId,
      String(monitorId),
      JSON.stringify({
        monitor_id: monitorId,
        scheduled_for_ms: scheduledForMs,
        requested_at: now,
        manual: true,
      }),
      now,
      now,
      now
    )
    .run();
  try {
    await new QueueJobPublisher(env.XUGOU_JOBS).publishJob(jobId);
  } catch (error) {
    writeStructuredLog(env, {
      service: "queue",
      operation: "publish_manual_monitor_check",
      result: "deferred",
      jobId,
      entityType: "monitor",
      entityId: monitorId,
      errorCode: "MONITOR_CHECK_PUBLISH_DEFERRED",
      error,
    });
  }
  return { jobId };
}
