import type { Bindings } from "../../../models/db";
import { getEnvNumber } from "../../../utils/env";
import { MonitorCheckSyncProcessor } from "./MonitorCheckSyncProcessor";

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
  const limit = getEnvNumber(env, "MONITOR_CHECK_BATCH_SIZE", 50, {
    min: 1,
    max: 100,
  });
  const timeBudgetMs = getEnvNumber(env, "MONITOR_SCHEDULER_TIME_BUDGET_MS", 20_000, {
    min: 100,
    max: 25_000,
  });
  const minimumInterval = getEnvNumber(env, "MIN_MONITOR_INTERVAL_SECONDS", 300, {
    min: 1,
    max: 86400,
  });
  const processor = new MonitorCheckSyncProcessor(env);
  let cursorDueMs = -1;
  let cursorId = 0;
  let scheduled = 0;
  let batches = 0;
  let budgetExhausted = false;

  for (;;) {
    if (monotonicNow() - startedAt >= timeBudgetMs) {
      budgetExhausted = true;
      break;
    }
    const due = await env.DB.prepare(
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
        .all<{ id: number; interval_ms: number; scheduled_for_ms: number | null }>();
        
    if (due.results.length === 0) break;
    batches += 1;
    
    const jobs = due.results.map((monitor) => {
      const scheduledForMs = Number.isSafeInteger(monitor.scheduled_for_ms)
        ? Number(monitor.scheduled_for_ms)
        : 0;
      const intervalMs = Math.max(monitor.interval_ms, minimumInterval * 1000);
      const nextDueMs = nowMs + intervalMs;
      return {
        monitor_id: monitor.id,
        scheduled_for_ms: scheduledForMs || nowMs,
        next_due_ms: nextDueMs,
        next_due: new Date(nextDueMs).toISOString(),
      };
    });
    
    const jobsJson = JSON.stringify(jobs);
    
    // 1. Advance next_due_at_ms first to prevent re-fetching in same loop if check fails or takes long
    const statements: D1PreparedStatement[] = [
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

    await env.DB.batch(statements);
    scheduled += jobs.length;
    
    // 2. Perform actual checks in parallel
    await Promise.allSettled(
      jobs.map(job => processor.process(job.monitor_id, job.scheduled_for_ms))
    );
    
    const last = due.results.at(-1);
    if (!last) break;
    cursorDueMs = Number(last.scheduled_for_ms ?? 0);
    cursorId = last.id;
    if (due.results.length < limit) break;
  }
  
  return {
    scheduled,
    batches,
    budget_exhausted: budgetExhausted,
    duration_ms: Math.max(0, monotonicNow() - startedAt),
  };
}

export async function scheduleMonitorCheckNow(env: Bindings, monitorId: number) {
  const monitor = await env.DB.prepare(
    `SELECT id FROM monitor_definitions
     WHERE id = ? AND deleted_at_ms IS NULL LIMIT 1`
  )
    .bind(monitorId)
    .first<{ id: number }>();
  if (!monitor) return null;
  
  const scheduledForMs = Date.now();
  const processor = new MonitorCheckSyncProcessor(env);
  // manual execution is synchronous for the API caller to await or trigger
  await processor.process(monitorId, scheduledForMs);
  
  return { manual: true, monitorId };
}
