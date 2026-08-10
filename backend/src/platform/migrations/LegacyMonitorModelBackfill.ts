import type { Bindings } from "../../models/db";
import { getEnvNumber } from "../../utils/env";
import {
  canonicalMigrationJson,
  migrationSha256Hex,
} from "./MigrationEncoding";
import { claimMigrationCheckpoint } from "./MigrationLedger";

const SOURCE_TABLE = "monitors";
const TARGET_TABLE = "monitor_definitions";
const MIGRATION_KEY = "legacy-monitor-model-v2";

type SourceRow = {
  id: number;
  name: string;
  url: string;
  method: string;
  interval: number;
  timeout: number;
  timeout_ms: number;
  expected_status: number;
  headers: string;
  body: string | null;
  active: number;
  status: string | null;
  response_time: number | null;
  last_checked: string | null;
  next_check_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  sort_order: number | null;
};

type PreparedRow = {
  source_table: string;
  source_id: string;
  target_id: string;
  id: number;
  name: string;
  url: string;
  method: string;
  headers_json: string;
  body: string | null;
  interval_ms: number;
  timeout_ms: number;
  expected_status: number;
  active: number;
  sort_order: number;
  status: string;
  response_time_ms: number;
  last_checked_at_ms: number | null;
  next_due_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  deleted_at_ms: number | null;
  payload_checksum: string;
};

function timestamp(value: string | null, code: string, nullable = false) {
  if (nullable && !value) return null;
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
}

function positiveInteger(value: unknown, code: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(code);
  return number;
}

function normalizeHeaders(value: string) {
  let candidate: unknown = value;
  for (let attempt = 0; attempt < 2 && typeof candidate === "string"; attempt += 1) {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new Error("INVALID_HEADERS_JSON");
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("INVALID_HEADERS_OBJECT");
  }
  return Object.fromEntries(
    Object.entries(candidate as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, String(item)])
  );
}

async function prepareSource(row: SourceRow): Promise<PreparedRow> {
  if (!Number.isSafeInteger(row.id) || row.id <= 0) throw new Error("INVALID_SOURCE_ID");
  if (!row.name.trim()) throw new Error("INVALID_NAME");
  let url: URL;
  try {
    url = new URL(row.url);
  } catch {
    throw new Error("INVALID_URL");
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("INVALID_URL_SCHEME");
  const method = row.method.toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) {
    throw new Error("INVALID_METHOD");
  }
  const intervalSeconds = positiveInteger(row.interval, "INVALID_INTERVAL");
  const timeoutMs = positiveInteger(
    row.timeout_ms || Number(row.timeout) * 1000,
    "INVALID_TIMEOUT"
  );
  const expectedStatus = positiveInteger(row.expected_status, "INVALID_EXPECTED_STATUS");
  if (!(expectedStatus <= 5 || (expectedStatus >= 100 && expectedStatus <= 599))) {
    throw new Error("INVALID_EXPECTED_STATUS");
  }
  if (![0, 1].includes(Number(row.active))) throw new Error("INVALID_ACTIVE");
  const responseTime = Number(row.response_time ?? 0);
  if (!Number.isFinite(responseTime) || responseTime < 0) {
    throw new Error("INVALID_RESPONSE_TIME");
  }
  const status = row.status ?? "pending";
  if (!["up", "down", "pending", "unknown", "error"].includes(status)) {
    throw new Error("INVALID_STATUS");
  }
  const normalized = {
    id: row.id,
    name: row.name.trim(),
    url: row.url,
    method,
    headers_json: canonicalMigrationJson(normalizeHeaders(row.headers)),
    body: row.body,
    interval_ms: intervalSeconds * 1000,
    timeout_ms: timeoutMs,
    expected_status: expectedStatus,
    active: Number(row.active),
    sort_order: Number.isSafeInteger(row.sort_order) ? Number(row.sort_order) : 0,
    status,
    response_time_ms: Math.round(responseTime),
    last_checked_at_ms: timestamp(row.last_checked, "INVALID_LAST_CHECKED", true),
    next_due_at_ms: timestamp(row.next_check_at, "INVALID_NEXT_CHECK", true),
    created_at_ms: timestamp(row.created_at, "INVALID_CREATED_AT")!,
    updated_at_ms: timestamp(row.updated_at, "INVALID_UPDATED_AT")!,
    deleted_at_ms: timestamp(row.deleted_at, "INVALID_DELETED_AT", true),
  };
  const payloadChecksum = await migrationSha256Hex(
    canonicalMigrationJson(normalized)
  );
  return {
    source_table: SOURCE_TABLE,
    source_id: String(row.id),
    target_id: String(row.id),
    ...normalized,
    payload_checksum: payloadChecksum,
  };
}

function sourceSelect(where: string) {
  return `SELECT id, name, url, method, interval, timeout, timeout_ms,
                 expected_status, headers, body, active, status, response_time,
                 last_checked, next_check_at, deleted_at, created_at, updated_at,
                 sort_order
          FROM monitors ${where}`;
}

function persistStatements(env: Bindings, rows: PreparedRow[], now: string) {
  if (rows.length === 0) return [];
  const json = JSON.stringify(rows);
  return [
    env.DB.prepare(
      `INSERT INTO monitor_definitions
       (id, name, url, method, headers_json, body, interval_ms, timeout_ms,
        expected_status, active, sort_order, created_at_ms, updated_at_ms,
        deleted_at_ms)
       SELECT CAST(json_extract(value, '$.id') AS INTEGER),
              json_extract(value, '$.name'), json_extract(value, '$.url'),
              json_extract(value, '$.method'), json_extract(value, '$.headers_json'),
              json_extract(value, '$.body'),
              CAST(json_extract(value, '$.interval_ms') AS INTEGER),
              CAST(json_extract(value, '$.timeout_ms') AS INTEGER),
              CAST(json_extract(value, '$.expected_status') AS INTEGER),
              CAST(json_extract(value, '$.active') AS INTEGER),
              CAST(json_extract(value, '$.sort_order') AS INTEGER),
              CAST(json_extract(value, '$.created_at_ms') AS INTEGER),
              CAST(json_extract(value, '$.updated_at_ms') AS INTEGER),
              CAST(json_extract(value, '$.deleted_at_ms') AS INTEGER)
       FROM json_each(?) WHERE 1 = 1
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, url = excluded.url, method = excluded.method,
         headers_json = excluded.headers_json, body = excluded.body,
         interval_ms = excluded.interval_ms, timeout_ms = excluded.timeout_ms,
         expected_status = excluded.expected_status, active = excluded.active,
         sort_order = excluded.sort_order, updated_at_ms = excluded.updated_at_ms,
         deleted_at_ms = excluded.deleted_at_ms
       WHERE excluded.updated_at_ms >= monitor_definitions.updated_at_ms`
    ).bind(json),
    env.DB.prepare(
      `INSERT INTO monitor_runtime
       (monitor_id, status, response_time_ms, last_checked_at_ms, next_due_at_ms,
        version, created_at_ms, updated_at_ms)
       SELECT CAST(json_extract(value, '$.id') AS INTEGER),
              json_extract(value, '$.status'),
              CAST(json_extract(value, '$.response_time_ms') AS INTEGER),
              CAST(json_extract(value, '$.last_checked_at_ms') AS INTEGER),
              CAST(json_extract(value, '$.next_due_at_ms') AS INTEGER),
              0, CAST(json_extract(value, '$.created_at_ms') AS INTEGER),
              CAST(json_extract(value, '$.updated_at_ms') AS INTEGER)
       FROM json_each(?) WHERE 1 = 1
       ON CONFLICT(monitor_id) DO UPDATE SET
         status = excluded.status, response_time_ms = excluded.response_time_ms,
         last_checked_at_ms = excluded.last_checked_at_ms,
         next_due_at_ms = excluded.next_due_at_ms,
         version = monitor_runtime.version + 1,
         updated_at_ms = excluded.updated_at_ms
       WHERE excluded.updated_at_ms >= monitor_runtime.updated_at_ms`
    ).bind(json),
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
    ).bind(TARGET_TABLE, now, now, json),
  ];
}

async function reconcileLegacyMonitorModel(env: Bindings) {
  const source = await env.DB.prepare(
    `SELECT m.id, m.name, m.url, m.method, m.interval, m.timeout, m.timeout_ms,
            m.expected_status, m.headers, m.body, m.active, m.status,
            m.response_time, m.last_checked, m.next_check_at, m.deleted_at,
            m.created_at, m.updated_at, m.sort_order,
            CASE WHEN map.source_id IS NULL OR definition.id IS NULL
                       OR runtime.monitor_id IS NULL THEN 1 ELSE 0 END AS target_missing
     FROM monitors m
     LEFT JOIN legacy_id_map map
       ON map.source_table = ? AND map.source_id = CAST(m.id AS TEXT)
      AND map.target_table = ?
     LEFT JOIN monitor_definitions definition
       ON definition.id = CAST(map.target_id AS INTEGER)
     LEFT JOIN monitor_runtime runtime ON runtime.monitor_id = definition.id
     WHERE (
       map.source_id IS NULL OR definition.id IS NULL OR runtime.monitor_id IS NULL
       OR julianday(m.updated_at) > julianday(map.updated_at)
     ) AND NOT EXISTS (
       SELECT 1 FROM migration_anomalies anomaly
       WHERE anomaly.migration_key = ? AND anomaly.source_table = ?
         AND anomaly.source_pk = CAST(m.id AS TEXT)
         AND anomaly.status IN ('open', 'ignored')
     )
     ORDER BY target_missing DESC, m.updated_at ASC, m.id ASC LIMIT 1`
  )
    .bind(SOURCE_TABLE, TARGET_TABLE, MIGRATION_KEY, SOURCE_TABLE)
    .first<SourceRow & { target_missing: number }>();
  if (!source) return null;
  const checkpoint = await claimMigrationCheckpoint(env, MIGRATION_KEY);
  if (!checkpoint) {
    return { configured: true, migrated: 0, reconciled: 0, anomalies: 0, remaining: true, busy: true };
  }
  const now = new Date().toISOString();
  let prepared: PreparedRow;
  try {
    prepared = await prepareSource(source);
  } catch (error) {
    const errorCode = (error instanceof Error ? error.message : String(error)).slice(0, 128);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO migration_anomalies
         (migration_key, source_table, source_pk, error_code, raw_value_json,
          status, resolution_note, first_seen_at, resolved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, NULL, ?, ?)
         ON CONFLICT(migration_key, source_table, source_pk, error_code) DO UPDATE SET
           status = 'open', resolution_note = NULL, resolved_at = NULL,
           updated_at = excluded.updated_at`
      ).bind(
        MIGRATION_KEY,
        SOURCE_TABLE,
        String(source.id),
        errorCode,
        canonicalMigrationJson({
          ...source,
          headers: source.headers ? "[redacted]" : source.headers,
          body: source.body ? "[redacted]" : source.body,
        }),
        now,
        now,
        now
      ),
      env.DB.prepare(
        `UPDATE migration_checkpoints
         SET status = 'completed_with_anomalies', anomaly_rows = anomaly_rows + 1,
             lease_token = NULL, lease_expires_at = NULL,
             completed_at = ?, updated_at = ?
         WHERE migration_key = ? AND lease_token = ?`
      ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
    ]);
    return { configured: true, migrated: 0, reconciled: 0, anomalies: 1, remaining: false };
  }
  const missing = source.target_missing === 1;
  await env.DB.batch([
    ...persistStatements(env, [prepared], now),
    env.DB.prepare(
      `UPDATE migration_checkpoints
       SET status = CASE WHEN anomaly_rows > 0 THEN 'completed_with_anomalies'
                         ELSE 'completed' END,
           rows_written = rows_written + ?, rows_skipped = rows_skipped + ?,
           lease_token = NULL, lease_expires_at = NULL,
           completed_at = ?, updated_at = ?
       WHERE migration_key = ? AND lease_token = ?`
    ).bind(missing ? 1 : 0, missing ? 0 : 1, now, now, MIGRATION_KEY, checkpoint.lease_token),
  ]);
  return {
    configured: true,
    migrated: missing ? 1 : 0,
    reconciled: missing ? 0 : 1,
    anomalies: 0,
    remaining: true,
  };
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
    return { configured: true, migrated: 0, anomalies: 0, remaining: true, busy: true };
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
        `UPDATE migration_checkpoints SET status = 'completed_with_anomalies',
         lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE migration_key = ? AND lease_token = ?`
      ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
    ]);
    return { configured: true, migrated: 0, anomalies: 1, remaining: true };
  };
  const sourceId = Number(anomaly.source_pk);
  if (!Number.isSafeInteger(sourceId)) return fail("INVALID_ANOMALY_SOURCE");
  const source = await env.DB.prepare(sourceSelect("WHERE id = ? LIMIT 1"))
    .bind(sourceId)
    .first<SourceRow>();
  if (!source) return fail("SOURCE_ROW_MISSING");
  let prepared: PreparedRow;
  try {
    prepared = await prepareSource(source);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  await env.DB.batch([
    ...persistStatements(env, [prepared], now),
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
           rows_written = rows_written + 1, lease_token = NULL,
           lease_expires_at = NULL, completed_at = ?, updated_at = ?
       WHERE migration_key = ? AND lease_token = ?`
    ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
  ]);
  return { configured: true, migrated: 1, anomalies: 0, remaining: false };
}

export async function backfillLegacyMonitorModel(
  env: Bindings,
  requestedLimit?: number
) {
  const retried = await retryRequestedAnomaly(env);
  if (retried) return retried;
  const maximum = await env.DB.prepare(
    `SELECT COALESCE(MAX(id), 0) AS max_id FROM monitors`
  ).first<{ max_id: number }>();
  const current = await env.DB.prepare(
    `SELECT status, last_pk FROM migration_checkpoints WHERE migration_key = ? LIMIT 1`
  )
    .bind(MIGRATION_KEY)
    .first<{ status: string; last_pk: string | null }>();
  const lastPk = Number(current?.last_pk ?? 0);
  if (
    current &&
    ["completed", "completed_with_anomalies"].includes(current.status) &&
    Number(maximum?.max_id ?? 0) <= (Number.isFinite(lastPk) ? lastPk : 0)
  ) {
    return (
      (await reconcileLegacyMonitorModel(env)) ??
      { configured: true, migrated: 0, reconciled: 0, anomalies: 0, remaining: false }
    );
  }
  const checkpoint = await claimMigrationCheckpoint(env, MIGRATION_KEY);
  if (!checkpoint) {
    return { configured: true, migrated: 0, anomalies: 0, remaining: true, busy: true };
  }
  const limit = Math.min(
    requestedLimit ??
      getEnvNumber(env, "LEGACY_MONITOR_MODEL_BACKFILL_BATCH_SIZE", 100, {
        min: 1,
        max: 500,
      }),
    500
  );
  const claimedLastPk = Number(checkpoint.last_pk ?? 0);
  const rows = await env.DB.prepare(
    sourceSelect("WHERE id > ? ORDER BY id ASC LIMIT ?")
  )
    .bind(Number.isFinite(claimedLastPk) ? claimedLastPk : 0, limit + 1)
    .all<SourceRow>();
  const sourceRows = rows.results.slice(0, limit);
  const remaining = rows.results.length > limit;
  const prepared: PreparedRow[] = [];
  const anomalies: Array<{
    source_id: string;
    error_code: string;
    raw_value_json: string;
  }> = [];
  for (const row of sourceRows) {
    try {
      prepared.push(await prepareSource(row));
    } catch (error) {
      anomalies.push({
        source_id: String(row.id),
        error_code: (error instanceof Error ? error.message : String(error)).slice(0, 128),
        raw_value_json: canonicalMigrationJson({
          ...row,
          headers: row.headers ? "[redacted]" : row.headers,
          body: row.body ? "[redacted]" : row.body,
        }),
      });
    }
  }
  const now = new Date().toISOString();
  const batchChecksum = await migrationSha256Hex(
    canonicalMigrationJson(
      sourceRows.map((row) => ({
        source_id: String(row.id),
        target_id: prepared.find((item) => item.id === row.id)?.target_id,
        anomaly: anomalies.find((item) => item.source_id === String(row.id))?.error_code,
      }))
    )
  );
  const checksum = await migrationSha256Hex(
    `${checkpoint.checksum ?? ""}:${batchChecksum}`
  );
  const status = remaining
    ? "running"
    : anomalies.length > 0 || checkpoint.anomaly_rows > 0
      ? "completed_with_anomalies"
      : "completed";
  const statements = persistStatements(env, prepared, now);
  if (anomalies.length > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO migration_anomalies
         (migration_key, source_table, source_pk, error_code, raw_value_json,
          status, resolution_note, first_seen_at, resolved_at, created_at, updated_at)
         SELECT ?, ?, json_extract(value, '$.source_id'),
                json_extract(value, '$.error_code'),
                json_extract(value, '$.raw_value_json'), 'open', NULL, ?, NULL, ?, ?
         FROM json_each(?) WHERE 1 = 1
         ON CONFLICT(migration_key, source_table, source_pk, error_code) DO UPDATE SET
           raw_value_json = excluded.raw_value_json, status = 'open',
           resolution_note = NULL, resolved_at = NULL, updated_at = excluded.updated_at`
      ).bind(MIGRATION_KEY, SOURCE_TABLE, now, now, now, JSON.stringify(anomalies))
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE migration_checkpoints SET phase = 'backfill', status = ?, last_pk = ?,
       rows_read = rows_read + ?, rows_written = rows_written + ?,
       anomaly_rows = anomaly_rows + ?, checksum = ?, last_error = NULL,
       lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
       WHERE migration_key = ? AND lease_token = ?`
    ).bind(
      status,
      String(sourceRows.at(-1)?.id ?? claimedLastPk),
      sourceRows.length,
      prepared.length,
      anomalies.length,
      checksum,
      remaining ? null : now,
      now,
      MIGRATION_KEY,
      checkpoint.lease_token
    )
  );
  await env.DB.batch(statements);
  return {
    configured: true,
    migrated: prepared.length,
    anomalies: anomalies.length,
    remaining,
    checksum,
  };
}

export async function legacyMonitorModelCoverage(env: Bindings) {
  const [source, mapped, anomalies] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM monitors`).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM legacy_id_map map
       JOIN monitor_definitions definition
         ON definition.id = CAST(map.target_id AS INTEGER)
       JOIN monitor_runtime runtime ON runtime.monitor_id = definition.id
       WHERE map.source_table = ? AND map.target_table = ?`
    )
      .bind(SOURCE_TABLE, TARGET_TABLE)
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
