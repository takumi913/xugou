const FIVE_MINUTE_BUCKET_MS = 5 * 60 * 1000;

export interface AgentMetricBucket {
  start: string;
  end: string;
}

export function agentMetricBucket(collectedAt: string): AgentMetricBucket {
  const collectedAtMs = Date.parse(collectedAt);
  if (!Number.isFinite(collectedAtMs)) {
    throw new Error("Invalid Agent metric timestamp");
  }
  const startMs =
    Math.floor(collectedAtMs / FIVE_MINUTE_BUCKET_MS) * FIVE_MINUTE_BUCKET_MS;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + FIVE_MINUTE_BUCKET_MS).toISOString(),
  };
}

/**
 * Recomputes a five-minute Agent bucket from immutable samples. CPU and memory
 * p95 use nearest rank (ceil(0.95 * N)); null metrics do not participate in the
 * corresponding percentile. The latest network counters remain available so
 * adjacent rollups can still produce rate charts.
 */
export function prepareAgentMetricRollupRebuild(
  db: D1Database,
  agentId: number,
  bucket: AgentMetricBucket,
  createdAt: string
) {
  return db
    .prepare(
      `WITH bucket_samples AS (
         SELECT report_id, sample_index, collected_at, metrics_json,
                CASE
                  WHEN json_type(metrics_json, '$.cpu.usage') IN ('integer', 'real')
                  THEN CAST(json_extract(metrics_json, '$.cpu.usage') AS REAL)
                END AS cpu_value,
                CASE
                  WHEN json_type(metrics_json, '$.memory.usage_rate') IN ('integer', 'real')
                  THEN CAST(json_extract(metrics_json, '$.memory.usage_rate') AS REAL)
                END AS memory_value,
                CASE
                  WHEN json_type(metrics_json, '$.load.load1') IN ('integer', 'real')
                  THEN CAST(json_extract(metrics_json, '$.load.load1') AS REAL)
                END AS load_value
         FROM agent_report_samples
         WHERE agent_id = ? AND collected_at >= ? AND collected_at < ?
       ), cpu_ranked AS (
         SELECT cpu_value,
                ROW_NUMBER() OVER (
                  ORDER BY cpu_value ASC, report_id ASC, sample_index ASC
                ) AS percentile_rank,
                COUNT(*) OVER () AS percentile_count
         FROM bucket_samples
         WHERE cpu_value IS NOT NULL
       ), memory_ranked AS (
         SELECT memory_value,
                ROW_NUMBER() OVER (
                  ORDER BY memory_value ASC, report_id ASC, sample_index ASC
                ) AS percentile_rank,
                COUNT(*) OVER () AS percentile_count
         FROM bucket_samples
         WHERE memory_value IS NOT NULL
       ), aggregate_values AS (
         SELECT COUNT(*) AS sample_count,
                AVG(cpu_value) AS cpu_avg,
                MIN(cpu_value) AS cpu_min,
                MAX(cpu_value) AS cpu_max,
                AVG(memory_value) AS memory_avg,
                MIN(memory_value) AS memory_min,
                MAX(memory_value) AS memory_max,
                AVG(load_value) AS load_avg
         FROM bucket_samples
       )
       INSERT INTO agent_metric_rollups
       (agent_id, bucket_start, bucket_size_seconds, sample_count,
        cpu_avg, cpu_min, cpu_max, cpu_p95,
        memory_avg, memory_min, memory_max, memory_p95,
        disk_max, load_avg, network_delta_json, threshold_events_json, created_at)
       SELECT ?, ?, 300, aggregate_values.sample_count,
              aggregate_values.cpu_avg,
              aggregate_values.cpu_min,
              aggregate_values.cpu_max,
              (SELECT cpu_value FROM cpu_ranked
               WHERE percentile_rank = ((percentile_count * 95 + 99) / 100)),
              aggregate_values.memory_avg,
              aggregate_values.memory_min,
              aggregate_values.memory_max,
              (SELECT memory_value FROM memory_ranked
               WHERE percentile_rank = ((percentile_count * 95 + 99) / 100)),
              (SELECT MAX(
                        CASE
                          WHEN json_type(disk.value, '$.usage_rate') IN ('integer', 'real')
                          THEN CAST(json_extract(disk.value, '$.usage_rate') AS REAL)
                        END
                      )
               FROM bucket_samples
               JOIN json_each(bucket_samples.metrics_json, '$.disks') AS disk),
              aggregate_values.load_avg,
              (SELECT COALESCE(json_extract(metrics_json, '$.network'), '[]')
               FROM bucket_samples
               ORDER BY collected_at DESC, report_id DESC, sample_index DESC LIMIT 1),
              NULL, ?
       FROM aggregate_values
       WHERE aggregate_values.sample_count > 0
       ON CONFLICT(agent_id, bucket_start, bucket_size_seconds) DO UPDATE SET
         sample_count = excluded.sample_count,
         cpu_avg = excluded.cpu_avg,
         cpu_min = excluded.cpu_min,
         cpu_max = excluded.cpu_max,
         cpu_p95 = excluded.cpu_p95,
         memory_avg = excluded.memory_avg,
         memory_min = excluded.memory_min,
         memory_max = excluded.memory_max,
         memory_p95 = excluded.memory_p95,
         disk_max = excluded.disk_max,
         load_avg = excluded.load_avg,
         network_delta_json = excluded.network_delta_json,
         threshold_events_json = excluded.threshold_events_json`
    )
    .bind(
      agentId,
      bucket.start,
      bucket.end,
      agentId,
      bucket.start,
      createdAt
    );
}

export function uniqueAgentMetricBuckets(
  samples: Array<{ collected_at: string }>
) {
  const buckets = new Map<string, AgentMetricBucket>();
  for (const sample of samples) {
    const bucket = agentMetricBucket(sample.collected_at);
    buckets.set(bucket.start, bucket);
  }
  return [...buckets.values()].sort((left, right) =>
    left.start.localeCompare(right.start)
  );
}
