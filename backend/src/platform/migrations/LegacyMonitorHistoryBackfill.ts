import type { Bindings } from "../../models/db";
import { getEnvNumber } from "../../utils/env";
import {
  canonicalMigrationJson,
  migrationSha256Hex,
} from "./MigrationEncoding";
import { claimMigrationCheckpoint } from "./MigrationLedger";

const SOURCE_TABLE = "monitor_status_history_24h";
const MIGRATION_KEY = "legacy-monitor-history-v1";

type SourceRow = {
  id: number;
  monitor_id: number;
  status: string;
  timestamp: string | null;
  response_time: number | null;
  status_code: number | null;
  error: string | null;
};

type PreparedRow = {
  source_table: string;
  source_id: string;
  job_id: string;
  monitor_id: number;
  scheduled_for_ms: number;
  checked_at: string;
  status: string;
  response_time_ms: number;
  status_code: number | null;
  error: string | null;
  payload_checksum: string;
  identity: string;
};

function normalizeSource(row: SourceRow) {
  if (!Number.isInteger(row.id) || row.id <= 0) throw new Error("INVALID_SOURCE_ID");
  if (!Number.isInteger(row.monitor_id) || row.monitor_id <= 0) {
    throw new Error("INVALID_MONITOR_ID");
  }
  if (!["up", "down", "pending"].includes(row.status)) {
    throw new Error("INVALID_STATUS");
  }
  const timestamp = Date.parse(String(row.timestamp ?? ""));
  if (!Number.isFinite(timestamp)) throw new Error("INVALID_TIMESTAMP");
  const responseTime = Number(row.response_time ?? 0);
  if (!Number.isFinite(responseTime) || responseTime < 0) {
    throw new Error("INVALID_RESPONSE_TIME");
  }
  if (
    row.status_code !== null &&
    (!Number.isInteger(row.status_code) || row.status_code < 100 || row.status_code > 599)
  ) {
    throw new Error("INVALID_STATUS_CODE");
  }
  if (row.error !== null && typeof row.error !== "string") {
    throw new Error("INVALID_ERROR");
  }
  const checkedAt = new Date(timestamp).toISOString();
  return {
    monitor_id: row.monitor_id,
    scheduled_for_ms: timestamp,
    checked_at: checkedAt,
    status: row.status,
    response_time_ms: Math.round(responseTime),
    status_code: row.status_code,
    error: row.error?.slice(0, 2048) ?? null,
  };
}

function identity(value: {
  monitor_id: number;
  checked_at: string;
  status: string;
  response_time_ms: number;
  status_code: number | null;
  error: string | null;
}) {
  return canonicalMigrationJson({
    monitor_id: value.monitor_id,
    checked_at: value.checked_at,
    status: value.status,
    response_time_ms: value.response_time_ms,
    status_code: value.status_code,
    error: value.error,
  });
}

async function prepareSource(row: SourceRow): Promise<PreparedRow> {
  const normalized = normalizeSource(row);
  const payloadChecksum = await migrationSha256Hex(identity(normalized));
  return {
    source_table: SOURCE_TABLE,
    source_id: String(row.id),
    job_id: `legacy-monitor:${row.id}:${payloadChecksum.slice(0, 24)}`,
    ...normalized,
    payload_checksum: payloadChecksum,
    identity: identity(normalized),
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

async function findExistingJobId(env: Bindings, row: PreparedRow) {
  const candidate = await env.DB.prepare(
    `SELECT job_id, monitor_id, checked_at, status, response_time_ms,
            status_code, error
     FROM monitor_check_samples
     WHERE monitor_id = ? AND checked_at = ?`
  )
    .bind(row.monitor_id, row.checked_at)
    .all<{
      job_id: string;
      monitor_id: number;
      checked_at: string;
      status: string;
      response_time_ms: number;
      status_code: number | null;
      error: string | null;
    }>();
  return candidate.results.find((item) => identity(item) === row.identity)?.job_id;
}

async function retryRequestedMonitorAnomaly(env: Bindings) {
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
  if (!Number.isInteger(sourceId)) return fail("INVALID_ANOMALY_SOURCE");
  const source = await env.DB.prepare(
    `SELECT id, monitor_id, status, timestamp, response_time, status_code, error
     FROM monitor_status_history_24h WHERE id = ? LIMIT 1`
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
  const existingJobId = await findExistingJobId(env, prepared);
  if (existingJobId) prepared.job_id = existingJobId;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO monitor_check_samples
       (job_id, monitor_id, scheduled_for_ms, checked_at, status,
        response_time_ms, status_code, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      prepared.job_id,
      prepared.monitor_id,
      prepared.scheduled_for_ms,
      prepared.checked_at,
      prepared.status,
      prepared.response_time_ms,
      prepared.status_code,
      prepared.error,
      now,
      now
    ),
    env.DB.prepare(
      `INSERT INTO legacy_id_map
       (source_table, source_id, target_table, target_id, payload_checksum,
        created_at, updated_at)
       VALUES (?, ?, 'monitor_check_samples', ?, ?, ?, ?)
       ON CONFLICT(source_table, source_id) DO UPDATE SET
         target_table = excluded.target_table, target_id = excluded.target_id,
         payload_checksum = excluded.payload_checksum, updated_at = excluded.updated_at`
    ).bind(
      SOURCE_TABLE,
      prepared.source_id,
      prepared.job_id,
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
           lease_token = NULL, lease_expires_at = NULL,
           completed_at = ?, updated_at = ?
       WHERE migration_key = ? AND lease_token = ?`
    ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
  ]);
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM migration_anomalies
     WHERE migration_key = ? AND status = 'retry_requested'`
  )
    .bind(MIGRATION_KEY)
    .first<{ count: number }>();
  return {
    configured: true,
    migrated: existingJobId ? 0 : 1,
    deduplicated: existingJobId ? 1 : 0,
    anomalies: 0,
    remaining: Number(pending?.count ?? 0) > 0,
  };
}

export async function backfillLegacyMonitorHistory(
  env: Bindings,
  requestedLimit?: number
) {
  const retried = await retryRequestedMonitorAnomaly(env);
  if (retried) return retried;
  const maximum = await env.DB.prepare(
    `SELECT COALESCE(MAX(id), 0) AS max_id FROM monitor_status_history_24h`
  ).first<{ max_id: number }>();
  const existingCheckpoint = await currentCheckpoint(env);
  const lastPk = Number(existingCheckpoint?.last_pk ?? 0);
  if (
    existingCheckpoint &&
    ["completed", "completed_with_anomalies"].includes(existingCheckpoint.status) &&
    Number(maximum?.max_id ?? 0) <= (Number.isFinite(lastPk) ? lastPk : 0)
  ) {
    return { configured: true, migrated: 0, deduplicated: 0, anomalies: 0, remaining: false };
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
      getEnvNumber(env, "LEGACY_MONITOR_HISTORY_BACKFILL_BATCH_SIZE", 100, {
        min: 1,
        max: 500,
      }),
    500
  );
  const claimedLastPk = Number(checkpoint.last_pk ?? 0);
  const rows = await env.DB.prepare(
    `SELECT id, monitor_id, status, timestamp, response_time, status_code, error
     FROM monitor_status_history_24h WHERE id > ? ORDER BY id ASC LIMIT ?`
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

  const checkedTimes = prepared.map((row) => row.checked_at).sort();
  const candidates = prepared.length
    ? await env.DB.prepare(
        `SELECT job_id, monitor_id, checked_at, status, response_time_ms,
                status_code, error
         FROM monitor_check_samples
         WHERE monitor_id IN (
           SELECT DISTINCT CAST(json_extract(value, '$.monitor_id') AS INTEGER)
           FROM json_each(?)
         ) AND checked_at BETWEEN ? AND ?`
      )
        .bind(
          JSON.stringify(prepared),
          checkedTimes[0],
          checkedTimes.at(-1)
        )
        .all<{
          job_id: string;
          monitor_id: number;
          checked_at: string;
          status: string;
          response_time_ms: number;
          status_code: number | null;
          error: string | null;
        }>()
    : { results: [] as Array<PreparedRow & { job_id: string }> };
  const existingByIdentity = new Map(
    candidates.results.map((row) => [identity(row), row.job_id])
  );
  let migrated = 0;
  let deduplicated = 0;
  for (const row of prepared) {
    const existingJobId = existingByIdentity.get(row.identity);
    if (existingJobId) {
      row.job_id = existingJobId;
      deduplicated += 1;
    } else {
      existingByIdentity.set(row.identity, row.job_id);
      migrated += 1;
    }
  }
  const now = new Date().toISOString();
  const batchChecksum = await migrationSha256Hex(
    canonicalMigrationJson(
      sourceRows.map((row) => ({
        source_id: String(row.id),
        target_id: prepared.find((item) => item.source_id === String(row.id))
          ?.job_id,
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
        `INSERT OR IGNORE INTO monitor_check_samples
         (job_id, monitor_id, scheduled_for_ms, checked_at, status,
          response_time_ms, status_code, error, created_at, updated_at)
         SELECT json_extract(value, '$.job_id'),
                CAST(json_extract(value, '$.monitor_id') AS INTEGER),
                CAST(json_extract(value, '$.scheduled_for_ms') AS INTEGER),
                json_extract(value, '$.checked_at'), json_extract(value, '$.status'),
                CAST(json_extract(value, '$.response_time_ms') AS INTEGER),
                CAST(json_extract(value, '$.status_code') AS INTEGER),
                json_extract(value, '$.error'), ?, ?
         FROM json_each(?)`
      ).bind(now, now, json),
      env.DB.prepare(
        `INSERT INTO legacy_id_map
         (source_table, source_id, target_table, target_id, payload_checksum,
          created_at, updated_at)
         SELECT json_extract(value, '$.source_table'),
                json_extract(value, '$.source_id'), 'monitor_check_samples',
                json_extract(value, '$.job_id'),
                json_extract(value, '$.payload_checksum'), ?, ?
         FROM json_each(?) WHERE 1 = 1
         ON CONFLICT(source_table, source_id) DO UPDATE SET
           target_table = excluded.target_table,
           target_id = excluded.target_id,
           payload_checksum = excluded.payload_checksum,
           updated_at = excluded.updated_at`
      ).bind(now, now, json)
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

export async function legacyMonitorHistoryCoverage(env: Bindings) {
  const [source, mapped, anomalies] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM monitor_status_history_24h`).first<{
      count: number;
    }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM legacy_id_map
       WHERE source_table = ? AND target_table = 'monitor_check_samples'`
    )
      .bind(SOURCE_TABLE)
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
