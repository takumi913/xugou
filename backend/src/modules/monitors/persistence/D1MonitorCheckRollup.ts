const FIVE_MINUTE_BUCKET_MS = 5 * 60 * 1000;

export interface TimeBucket {
  start: string;
  end: string;
}

export function monitorCheckBucket(checkedAt: Date): TimeBucket {
  const startMs =
    Math.floor(checkedAt.getTime() / FIVE_MINUTE_BUCKET_MS) *
    FIVE_MINUTE_BUCKET_MS;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + FIVE_MINUTE_BUCKET_MS).toISOString(),
  };
}

/**
 * Rebuilds one bounded bucket from immutable samples instead of incrementing a
 * lossy accumulator. The nearest-rank definition is ceil(0.95 * N).
 *
 * This statement is intentionally returned to the caller so the sample insert,
 * exact aggregate, outbox row, and job completion can share one D1 batch.
 */
export function prepareMonitorCheckRollupRebuild(
  db: D1Database,
  monitorId: number,
  bucket: TimeBucket,
  writtenAt: string
) {
  return db
    .prepare(
      `WITH bucket_samples AS (
         SELECT job_id, checked_at, status, response_time_ms
         FROM monitor_check_samples
         WHERE monitor_id = ? AND checked_at >= ? AND checked_at < ?
       ), ranked AS (
         SELECT job_id, checked_at, status, response_time_ms,
                ROW_NUMBER() OVER (
                  ORDER BY response_time_ms ASC, job_id ASC
                ) AS percentile_rank,
                COUNT(*) OVER () AS percentile_count
         FROM bucket_samples
       )
       INSERT INTO monitor_check_rollups
       (monitor_id, bucket_start, bucket_size_seconds, total_checks, up_checks,
        down_checks, last_status, response_time_avg, response_time_min,
        response_time_p95, response_time_max, created_at, updated_at)
       SELECT ?, ?, 300,
              COUNT(*),
              SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END),
              SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END),
              (SELECT status FROM bucket_samples
               ORDER BY checked_at DESC, job_id DESC LIMIT 1),
              ROUND(AVG(response_time_ms)),
              MIN(response_time_ms),
              MAX(CASE
                    WHEN percentile_rank = ((percentile_count * 95 + 99) / 100)
                    THEN response_time_ms
                  END),
              MAX(response_time_ms), ?, ?
       FROM ranked
       HAVING COUNT(*) > 0
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
    )
    .bind(
      monitorId,
      bucket.start,
      bucket.end,
      monitorId,
      bucket.start,
      writtenAt,
      writtenAt
    );
}
