import type { Bindings } from "../../models/db";
import { getEnvNumber } from "../../utils/env";
import {
  canonicalMigrationJson,
  migrationSha256Hex,
} from "./MigrationEncoding";
import { claimMigrationCheckpoint } from "./MigrationLedger";

const SOURCE_TABLE = "monitor_daily_stats";
const TARGET_TABLE = "monitor_check_rollups";
const MIGRATION_KEY = "legacy-monitor-daily-stats-v1";
const DAILY_BUCKET_SECONDS = 86_400;

type SourceRow = {
  id: number;
  monitor_id: number;
  date: string;
  total_checks: number;
  up_checks: number;
  down_checks: number;
  avg_response_time: number | null;
  min_response_time: number | null;
  max_response_time: number | null;
  availability: number | null;
  created_at: string | null;
};

type PreparedRow = {
  source_table: string;
  source_id: string;
  target_id: string;
  monitor_id: number;
  bucket_start: string;
  total_checks: number;
  up_checks: number;
  down_checks: number;
  response_time_avg: number;
  response_time_min: number;
  response_time_max: number;
  payload_checksum: string;
};

function nonNegativeInteger(value: unknown, code: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(code);
  return number;
}

function nonNegativeMetric(value: unknown, code: string) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw new Error(code);
  return Math.round(number);
}

async function prepareSource(row: SourceRow): Promise<PreparedRow> {
  if (!Number.isSafeInteger(row.id) || row.id <= 0) throw new Error("INVALID_SOURCE_ID");
  if (!Number.isSafeInteger(row.monitor_id) || row.monitor_id <= 0) {
    throw new Error("INVALID_MONITOR_ID");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new Error("INVALID_DATE");
  const bucketStartMs = Date.parse(`${row.date}T00:00:00.000Z`);
  if (!Number.isFinite(bucketStartMs)) throw new Error("INVALID_DATE");
  const bucketStart = new Date(bucketStartMs).toISOString();
  if (bucketStart.slice(0, 10) !== row.date) throw new Error("INVALID_DATE");

  const totalChecks = nonNegativeInteger(row.total_checks, "INVALID_TOTAL_CHECKS");
  const upChecks = nonNegativeInteger(row.up_checks, "INVALID_UP_CHECKS");
  const downChecks = nonNegativeInteger(row.down_checks, "INVALID_DOWN_CHECKS");
  if (upChecks + downChecks !== totalChecks) throw new Error("CHECK_COUNT_MISMATCH");
  const responseTimeAvg = nonNegativeMetric(
    row.avg_response_time,
    "INVALID_AVG_RESPONSE_TIME"
  );
  const responseTimeMin = nonNegativeMetric(
    row.min_response_time,
    "INVALID_MIN_RESPONSE_TIME"
  );
  const responseTimeMax = nonNegativeMetric(
    row.max_response_time,
    "INVALID_MAX_RESPONSE_TIME"
  );
  if (
    totalChecks > 0 &&
    (responseTimeMin > responseTimeAvg || responseTimeAvg > responseTimeMax)
  ) {
    throw new Error("RESPONSE_TIME_ORDER_MISMATCH");
  }
  const availability = Number(row.availability ?? 0);
  if (!Number.isFinite(availability) || availability < 0 || availability > 100) {
    throw new Error("INVALID_AVAILABILITY");
  }
  const expectedAvailability = totalChecks > 0 ? (upChecks / totalChecks) * 100 : 0;
  if (Math.abs(availability - expectedAvailability) > 0.01) {
    throw new Error("AVAILABILITY_MISMATCH");
  }

  const normalized = {
    monitor_id: row.monitor_id,
    bucket_start: bucketStart,
    bucket_size_seconds: DAILY_BUCKET_SECONDS,
    total_checks: totalChecks,
    up_checks: upChecks,
    down_checks: downChecks,
    response_time_avg: responseTimeAvg,
    response_time_min: responseTimeMin,
    response_time_max: responseTimeMax,
    availability,
  };
  const payloadChecksum = await migrationSha256Hex(
    canonicalMigrationJson(normalized)
  );
  return {
    source_table: SOURCE_TABLE,
    source_id: String(row.id),
    target_id: `${row.monitor_id}:${bucketStart}:${DAILY_BUCKET_SECONDS}`,
    monitor_id: row.monitor_id,
    bucket_start: bucketStart,
    total_checks: totalChecks,
    up_checks: upChecks,
    down_checks: downChecks,
    response_time_avg: responseTimeAvg,
    response_time_min: responseTimeMin,
    response_time_max: responseTimeMax,
    payload_checksum: payloadChecksum,
  };
}

async function currentCheckpoint(env: Bindings) {
  return env.DB.prepare(
    `SELECT status, last_pk FROM migration_checkpoints
     WHERE migration_key = ? LIMIT 1`
  )
    .bind(MIGRATION_KEY)
    .first<{ status: string; last_pk: string | null }>();
}

async function targetExists(env: Bindings, row: PreparedRow) {
  const existing = await env.DB.prepare(
    `SELECT 1 AS found FROM monitor_check_rollups
     WHERE monitor_id = ? AND bucket_start = ? AND bucket_size_seconds = ? LIMIT 1`
  )
    .bind(row.monitor_id, row.bucket_start, DAILY_BUCKET_SECONDS)
    .first<{ found: number }>();
  return Boolean(existing);
}

async function retryRequestedAnomaly(env: Bindings) {
  const anomaly = await env.DB.prepare(
    `SELECT id, source_pk FROM migration_anomalies
     WHERE migration_key = ? AND status = 'retry_requested'
     ORDER BY id ASC LIMIT 1`
  )
    .bind(MIGRATION_KEY)
    .first<{ id: number; source_pk: string }>();
  if (!anomaly) return null;
  const checkpoint = await claimMigrationCheckpoint(env, MIGRATION_KEY);
  if (!checkpoint) {
    return {
      configured: true,
      migrated: 0,
      deduplicated: 0,
      anomalies: 0,
      remaining: true,
      busy: true,
    };
  }
  const now = new Date().toISOString();
  const fail = async (reason: string) => {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE migration_anomalies
         SET status = 'open', resolution_note = ?, resolved_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'retry_requested'`
      ).bind(reason.slice(0, 1000), now, anomaly.id),
      env.DB.prepare(
        `UPDATE migration_checkpoints
         SET status = 'completed_with_anomalies', lease_token = NULL,
             lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE migration_key = ? AND lease_token = ?`
      ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
    ]);
    return {
      configured: true,
      migrated: 0,
      deduplicated: 0,
      anomalies: 1,
      remaining: true,
    };
  };
  const sourceId = Number(anomaly.source_pk);
  if (!Number.isSafeInteger(sourceId)) return fail("INVALID_ANOMALY_SOURCE");
  const source = await env.DB.prepare(
    `SELECT id, monitor_id, date, total_checks, up_checks, down_checks,
            avg_response_time, min_response_time, max_response_time,
            availability, created_at
     FROM monitor_daily_stats WHERE id = ? LIMIT 1`
  )
    .bind(sourceId)
    .first<SourceRow>();
  if (!source) return fail("SOURCE_ROW_MISSING");
  const monitor = await env.DB.prepare(`SELECT id FROM monitors WHERE id = ? LIMIT 1`)
    .bind(source.monitor_id)
    .first<{ id: number }>();
  if (!monitor) return fail("ORPHAN_MONITOR");
  let prepared: PreparedRow;
  try {
    prepared = await prepareSource(source);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const existed = await targetExists(env, prepared);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO monitor_check_rollups
       (monitor_id, bucket_start, bucket_size_seconds, total_checks, up_checks,
        down_checks, last_status, response_time_avg, response_time_min,
        response_time_p95, response_time_max, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
    ).bind(
      prepared.monitor_id,
      prepared.bucket_start,
      DAILY_BUCKET_SECONDS,
      prepared.total_checks,
      prepared.up_checks,
      prepared.down_checks,
      prepared.response_time_avg,
      prepared.response_time_min,
      prepared.response_time_max,
      prepared.response_time_max,
      now,
      now
    ),
    env.DB.prepare(
      `INSERT INTO legacy_id_map
       (source_table, source_id, target_table, target_id, payload_checksum,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_table, source_id) DO UPDATE SET
         target_table = excluded.target_table, target_id = excluded.target_id,
         payload_checksum = excluded.payload_checksum, updated_at = excluded.updated_at`
    ).bind(
      SOURCE_TABLE,
      prepared.source_id,
      TARGET_TABLE,
      prepared.target_id,
      prepared.payload_checksum,
      now,
      now
    ),
    env.DB.prepare(
      `UPDATE migration_anomalies
       SET status = 'resolved', resolution_note = 'retry_succeeded',
           resolved_at = ?, updated_at = ?
       WHERE id = ? AND status = 'retry_requested'`
    ).bind(now, now, anomaly.id),
    env.DB.prepare(
      `UPDATE migration_checkpoints
       SET status = CASE WHEN anomaly_rows > 0 THEN 'completed_with_anomalies'
                         ELSE 'completed' END,
           rows_written = rows_written + ?, rows_skipped = rows_skipped + ?,
           lease_token = NULL, lease_expires_at = NULL,
           completed_at = ?, updated_at = ?
       WHERE migration_key = ? AND lease_token = ?`
    ).bind(existed ? 0 : 1, existed ? 1 : 0, now, now, MIGRATION_KEY, checkpoint.lease_token),
  ]);
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM migration_anomalies
     WHERE migration_key = ? AND status = 'retry_requested'`
  )
    .bind(MIGRATION_KEY)
    .first<{ count: number }>();
  return {
    configured: true,
    migrated: existed ? 0 : 1,
    deduplicated: existed ? 1 : 0,
    anomalies: 0,
    remaining: Number(pending?.count ?? 0) > 0,
  };
}

export async function backfillLegacyMonitorDailyStats(
  env: Bindings,
  requestedLimit?: number
) {
  const retried = await retryRequestedAnomaly(env);
  if (retried) return retried;
  const maximum = await env.DB.prepare(
    `SELECT COALESCE(MAX(id), 0) AS max_id FROM monitor_daily_stats`
  ).first<{ max_id: number }>();
  const existingCheckpoint = await currentCheckpoint(env);
  const lastPk = Number(existingCheckpoint?.last_pk ?? 0);
  if (
    existingCheckpoint &&
    ["completed", "completed_with_anomalies"].includes(existingCheckpoint.status) &&
    Number(maximum?.max_id ?? 0) <= (Number.isFinite(lastPk) ? lastPk : 0)
  ) {
    return {
      configured: true,
      migrated: 0,
      deduplicated: 0,
      anomalies: 0,
      remaining: false,
    };
  }

  const checkpoint = await claimMigrationCheckpoint(env, MIGRATION_KEY);
  if (!checkpoint) {
    return {
      configured: true,
      migrated: 0,
      deduplicated: 0,
      anomalies: 0,
      remaining: true,
      busy: true,
    };
  }
  const limit = Math.min(
    requestedLimit ??
      getEnvNumber(env, "LEGACY_MONITOR_DAILY_BACKFILL_BATCH_SIZE", 100, {
        min: 1,
        max: 500,
      }),
    500
  );
  const claimedLastPk = Number(checkpoint.last_pk ?? 0);
  const rows = await env.DB.prepare(
    `SELECT id, monitor_id, date, total_checks, up_checks, down_checks,
            avg_response_time, min_response_time, max_response_time,
            availability, created_at
     FROM monitor_daily_stats WHERE id > ? ORDER BY id ASC LIMIT ?`
  )
    .bind(Number.isFinite(claimedLastPk) ? claimedLastPk : 0, limit + 1)
    .all<SourceRow>();
  const sourceRows = rows.results.slice(0, limit);
  const remaining = rows.results.length > limit;
  const monitorIds = [...new Set(sourceRows.map((row) => row.monitor_id))];
  const monitors = monitorIds.length
    ? await env.DB.prepare(
        `SELECT id FROM monitors
         WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`
      )
        .bind(JSON.stringify(monitorIds))
        .all<{ id: number }>()
    : { results: [] as Array<{ id: number }> };
  const monitorSet = new Set(monitors.results.map((row) => row.id));
  const prepared: PreparedRow[] = [];
  const anomalies: Array<{
    source_table: string;
    source_id: string;
    error_code: string;
    raw_value_json: string;
  }> = [];
  for (const row of sourceRows) {
    try {
      if (!monitorSet.has(row.monitor_id)) throw new Error("ORPHAN_MONITOR");
      prepared.push(await prepareSource(row));
    } catch (error) {
      anomalies.push({
        source_table: SOURCE_TABLE,
        source_id: String(row.id),
        error_code: (error instanceof Error ? error.message : String(error)).slice(
          0,
          128
        ),
        raw_value_json: canonicalMigrationJson(row),
      });
    }
  }

  const existingKeys = new Set<string>();
  if (prepared.length > 0) {
    const minDate = prepared.map((row) => row.bucket_start).sort()[0];
    const maxDate = prepared.map((row) => row.bucket_start).sort().at(-1);
    const existing = await env.DB.prepare(
      `SELECT monitor_id, bucket_start FROM monitor_check_rollups
       WHERE bucket_size_seconds = ?
         AND monitor_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
         AND bucket_start BETWEEN ? AND ?`
    )
      .bind(DAILY_BUCKET_SECONDS, JSON.stringify(monitorIds), minDate, maxDate)
      .all<{ monitor_id: number; bucket_start: string }>();
    for (const row of existing.results) {
      existingKeys.add(`${row.monitor_id}:${row.bucket_start}`);
    }
  }
  let migrated = 0;
  let deduplicated = 0;
  for (const row of prepared) {
    const key = `${row.monitor_id}:${row.bucket_start}`;
    if (existingKeys.has(key)) deduplicated += 1;
    else {
      existingKeys.add(key);
      migrated += 1;
    }
  }
  const now = new Date().toISOString();
  const batchChecksum = await migrationSha256Hex(
    canonicalMigrationJson(
      sourceRows.map((row) => ({
        source_id: String(row.id),
        target_id: prepared.find((item) => item.source_id === String(row.id))
          ?.target_id,
        anomaly: anomalies.find((item) => item.source_id === String(row.id))
          ?.error_code,
      }))
    )
  );
  const cumulativeChecksum = await migrationSha256Hex(
    `${checkpoint.checksum ?? ""}:${batchChecksum}`
  );
  const status = remaining
    ? "running"
    : anomalies.length > 0 || checkpoint.anomaly_rows > 0
      ? "completed_with_anomalies"
      : "completed";
  const statements: D1PreparedStatement[] = [];
  if (prepared.length > 0) {
    const json = JSON.stringify(prepared);
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO monitor_check_rollups
         (monitor_id, bucket_start, bucket_size_seconds, total_checks, up_checks,
          down_checks, last_status, response_time_avg, response_time_min,
          response_time_p95, response_time_max, created_at, updated_at)
         SELECT CAST(json_extract(value, '$.monitor_id') AS INTEGER),
                json_extract(value, '$.bucket_start'), ?,
                CAST(json_extract(value, '$.total_checks') AS INTEGER),
                CAST(json_extract(value, '$.up_checks') AS INTEGER),
                CAST(json_extract(value, '$.down_checks') AS INTEGER), NULL,
                CAST(json_extract(value, '$.response_time_avg') AS INTEGER),
                CAST(json_extract(value, '$.response_time_min') AS INTEGER),
                CAST(json_extract(value, '$.response_time_max') AS INTEGER),
                CAST(json_extract(value, '$.response_time_max') AS INTEGER), ?, ?
         FROM json_each(?)`
      ).bind(DAILY_BUCKET_SECONDS, now, now, json),
      env.DB.prepare(
        `INSERT INTO legacy_id_map
         (source_table, source_id, target_table, target_id, payload_checksum,
          created_at, updated_at)
         SELECT json_extract(value, '$.source_table'),
                json_extract(value, '$.source_id'), ?,
                json_extract(value, '$.target_id'),
                json_extract(value, '$.payload_checksum'), ?, ?
         FROM json_each(?) WHERE 1 = 1
         ON CONFLICT(source_table, source_id) DO UPDATE SET
           target_table = excluded.target_table, target_id = excluded.target_id,
           payload_checksum = excluded.payload_checksum,
           updated_at = excluded.updated_at`
      ).bind(TARGET_TABLE, now, now, json)
    );
  }
  if (anomalies.length > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO migration_anomalies
         (migration_key, source_table, source_pk, error_code, raw_value_json,
          status, resolution_note, first_seen_at, resolved_at, created_at, updated_at)
         SELECT ?, json_extract(value, '$.source_table'),
                json_extract(value, '$.source_id'), json_extract(value, '$.error_code'),
                json_extract(value, '$.raw_value_json'), 'open', NULL, ?, NULL, ?, ?
         FROM json_each(?) WHERE 1 = 1
         ON CONFLICT(migration_key, source_table, source_pk, error_code) DO UPDATE SET
           raw_value_json = excluded.raw_value_json, status = 'open',
           resolution_note = NULL, resolved_at = NULL, updated_at = excluded.updated_at`
      ).bind(MIGRATION_KEY, now, now, now, JSON.stringify(anomalies))
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE migration_checkpoints SET
         phase = 'backfill', status = ?, last_pk = ?,
         rows_read = rows_read + ?, rows_written = rows_written + ?,
         rows_skipped = rows_skipped + ?, anomaly_rows = anomaly_rows + ?,
         checksum = ?, last_error = NULL, lease_token = NULL,
         lease_expires_at = NULL, completed_at = ?, updated_at = ?
       WHERE migration_key = ? AND lease_token = ?`
    ).bind(
      status,
      String(sourceRows.at(-1)?.id ?? claimedLastPk),
      sourceRows.length,
      migrated,
      deduplicated,
      anomalies.length,
      cumulativeChecksum,
      remaining ? null : now,
      now,
      MIGRATION_KEY,
      checkpoint.lease_token
    )
  );
  await env.DB.batch(statements);
  return {
    configured: true,
    migrated,
    deduplicated,
    anomalies: anomalies.length,
    remaining,
    checksum: cumulativeChecksum,
  };
}

export async function legacyMonitorDailyStatsCoverage(env: Bindings) {
  const [source, mapped, anomalies] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM monitor_daily_stats`).first<{
      count: number;
    }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM legacy_id_map map
       JOIN monitor_daily_stats source
         ON source.id = CAST(map.source_id AS INTEGER)
       JOIN monitor_check_rollups target
         ON target.monitor_id = source.monitor_id
        AND target.bucket_start = source.date || 'T00:00:00.000Z'
        AND target.bucket_size_seconds = ?
       WHERE map.source_table = ? AND map.target_table = ?`
    )
      .bind(DAILY_BUCKET_SECONDS, SOURCE_TABLE, TARGET_TABLE)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM migration_anomalies
       WHERE migration_key = ? AND status IN ('open', 'retry_requested', 'ignored')`
    )
      .bind(MIGRATION_KEY)
      .first<{ count: number }>(),
  ]);
  const sourceRows = Number(source?.count ?? 0);
  const mappedRows = Number(mapped?.count ?? 0);
  const anomalyRows = Number(anomalies?.count ?? 0);
  return {
    source_table: SOURCE_TABLE,
    source_rows: sourceRows,
    mapped_rows: mappedRows,
    anomaly_rows: anomalyRows,
    read_ready: sourceRows === mappedRows,
    conserved: sourceRows === mappedRows + anomalyRows,
  };
}
