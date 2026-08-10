import type { Bindings } from "../models/db";
import { isContractMode } from "../platform/compatibility/CompatibilityMode";

interface DailyStatsAggregation {
  monitor_id: number;
  total_checks: number;
  up_checks: number;
  down_checks: number;
  avg_response_time: number;
  min_response_time: number;
  max_response_time: number;
  p95_response_time: number;
}

const DEFAULT_DAILY_MONITOR_BATCH_SIZE = 25;

function boundedMonitorBatchSize(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_DAILY_MONITOR_BATCH_SIZE;
  return Math.max(1, Math.min(100, Math.trunc(value as number)));
}

export async function generateDailyMonitorStats(
  env: Bindings,
  now = new Date(),
  options: { monitorBatchSize?: number } = {}
) {
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const date = yesterday.toISOString().slice(0, 10);
  const startTime = `${date}T00:00:00.000Z`;
  const endTime = new Date(Date.parse(startTime) + 86_400_000).toISOString();
  const batchSize = boundedMonitorBatchSize(options.monitorBatchSize);
  const contractMode = isContractMode(env);
  const createdAt = now.toISOString();
  let lastMonitorId = 0;
  let processed = 0;

  // 只把固定数量的 Monitor 聚合结果带入 Worker；单个 Monitor 的样本仍由 D1
  // 在窗口内完成精确 p95，避免日任务把所有 Monitor 的结果一次性装入内存。
  while (true) {
    const { results } = await env.DB.prepare(
      `WITH target_monitors AS (
         SELECT monitor_id
         FROM monitor_check_samples
         WHERE checked_at >= ? AND checked_at < ? AND monitor_id > ?
         GROUP BY monitor_id
         ORDER BY monitor_id ASC
         LIMIT ?
       ), ranked AS (
         SELECT sample.monitor_id, sample.job_id, sample.status,
                sample.response_time_ms,
                ROW_NUMBER() OVER (
                  PARTITION BY sample.monitor_id
                  ORDER BY sample.response_time_ms ASC, sample.job_id ASC
                ) AS percentile_rank,
                COUNT(*) OVER (PARTITION BY sample.monitor_id) AS percentile_count
         FROM monitor_check_samples sample
         JOIN target_monitors target ON target.monitor_id = sample.monitor_id
         WHERE sample.checked_at >= ? AND sample.checked_at < ?
       )
       SELECT monitor_id,
              COUNT(*) AS total_checks,
              SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up_checks,
              SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down_checks,
              COALESCE(AVG(response_time_ms), 0) AS avg_response_time,
              COALESCE(MIN(response_time_ms), 0) AS min_response_time,
              COALESCE(MAX(response_time_ms), 0) AS max_response_time,
              COALESCE(MAX(CASE
                WHEN percentile_rank = ((percentile_count * 95 + 99) / 100)
                THEN response_time_ms
              END), 0) AS p95_response_time
       FROM ranked
       GROUP BY monitor_id
       ORDER BY monitor_id ASC`
    )
      .bind(startTime, endTime, lastMonitorId, batchSize, startTime, endTime)
      .all<DailyStatsAggregation>();

    if (results.length === 0) break;
    const canonicalWrites = results.map((row) => {
      const totalChecks = Number(row.total_checks) || 0;
      const upChecks = Number(row.up_checks) || 0;
      return env.DB.prepare(
        `INSERT INTO monitor_check_rollups
         (monitor_id, bucket_start, bucket_size_seconds, total_checks, up_checks,
          down_checks, last_status, response_time_avg, response_time_min,
          response_time_p95, response_time_max, created_at, updated_at)
         VALUES (?, ?, 86400, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(monitor_id, bucket_start, bucket_size_seconds) DO UPDATE SET
           total_checks = excluded.total_checks,
           up_checks = excluded.up_checks,
           down_checks = excluded.down_checks,
           last_status = excluded.last_status,
           response_time_avg = excluded.response_time_avg,
           response_time_min = excluded.response_time_min,
           response_time_p95 = excluded.response_time_p95,
           response_time_max = excluded.response_time_max,
           updated_at = excluded.updated_at`
      ).bind(
        row.monitor_id,
        startTime,
        totalChecks,
        upChecks,
        Number(row.down_checks) || 0,
        upChecks === totalChecks && totalChecks > 0 ? "up" : "down",
        Math.round(Number(row.avg_response_time) || 0),
        Math.round(Number(row.min_response_time) || 0),
        Math.round(Number(row.p95_response_time) || 0),
        Math.round(Number(row.max_response_time) || 0),
        createdAt,
        createdAt
      );
    });
    const compatibilityWrites = contractMode
      ? []
      : results.map((row) => {
          const totalChecks = Number(row.total_checks) || 0;
          const upChecks = Number(row.up_checks) || 0;
          return env.DB.prepare(
            `INSERT INTO monitor_daily_stats
             (monitor_id, date, total_checks, up_checks, down_checks,
              avg_response_time, min_response_time, max_response_time,
              availability, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(monitor_id, date) DO UPDATE SET
               total_checks = excluded.total_checks,
               up_checks = excluded.up_checks,
               down_checks = excluded.down_checks,
               avg_response_time = excluded.avg_response_time,
               min_response_time = excluded.min_response_time,
               max_response_time = excluded.max_response_time,
               availability = excluded.availability,
               created_at = excluded.created_at`
          ).bind(
            row.monitor_id,
            date,
            totalChecks,
            upChecks,
            Number(row.down_checks) || 0,
            Math.round(Number(row.avg_response_time) || 0),
            Math.round(Number(row.min_response_time) || 0),
            Math.round(Number(row.max_response_time) || 0),
            totalChecks > 0 ? (upChecks / totalChecks) * 100 : 0,
            createdAt
          );
        });

    const writes = [...canonicalWrites, ...compatibilityWrites];
    for (let offset = 0; offset < writes.length; offset += 50) {
      await env.DB.batch(writes.slice(offset, offset + 50));
    }
    lastMonitorId = results[results.length - 1].monitor_id;
    processed += results.length;
  }
  // 旧样本是升级守恒与回切证据。兼容窗口内只生成日投影，不在运行时删除源行；
  // Contract 发布会在最终 Bookmark/Export 和逐行映射对账后独立清理旧表。
  return { success: true, processed, date };
}

export default {
  async scheduled(
    event: ScheduledController,
    env: Bindings,
    _ctx: ExecutionContext
  ) {
    const now = Number.isFinite(Number(event.scheduledTime))
      ? new Date(Number(event.scheduledTime))
      : new Date();
    if (now.getUTCHours() === 0 && now.getUTCMinutes() === 5) {
      await generateDailyMonitorStats(env, now);
    }
    return { success: true, message: "监控检查已由同 Worker Queue 调度" };
  },
};
