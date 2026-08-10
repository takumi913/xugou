import type { Bindings } from "../../models/db";
import { getEnvNumber } from "../../utils/env";
import {
  canonicalMigrationJson,
  migrationSha256Hex,
} from "./MigrationEncoding";
import { claimMigrationCheckpoint } from "./MigrationLedger";

const SOURCE_TABLE = "agents";
const TARGET_TABLE = "agent_nodes";
const MIGRATION_KEY = "legacy-agent-model-v2";

type SourceRow = {
  id: number;
  name: string;
  status: string | null;
  created_at: string;
  updated_at: string;
  hostname: string | null;
  ip_addresses: string | null;
  os: string | null;
  version: string | null;
  keepalive: string | null;
  last_seen_at: string | null;
  last_state_changed_at: string | null;
  next_offline_at: string | null;
  collect_interval: number | null;
  report_interval: number | null;
  region: string | null;
  geo_latitude: number | null;
  geo_longitude: number | null;
  geo_city: string | null;
  geo_region_name: string | null;
  boot_time: number | null;
  price: number | null;
  currency: string | null;
  billing_cycle: string | null;
  expire_date: string | null;
  auto_renewal: number | null;
  is_hidden: number | null;
  traffic_limit_gb: number | null;
  traffic_reset_day: number | null;
  traffic_calc_type: string | null;
  auto_update: number | null;
  group_name: string | null;
  tags: string | null;
  sort_order: number | null;
  deleted_at: string | null;
};

type PreparedRow = {
  source_table: string;
  source_id: string;
  target_id: string;
  payload_checksum: string;
  id: number;
  name: string;
  collect_interval_ms: number;
  report_interval_ms: number;
  group_name: string | null;
  tags_json: string;
  price: number | null;
  currency: string | null;
  billing_cycle: string | null;
  expire_date: string | null;
  auto_renewal: number;
  is_hidden: number;
  traffic_limit_gb: number | null;
  traffic_reset_day: number;
  traffic_calc_type: string;
  auto_update: number;
  sort_order: number;
  status: string;
  hostname: string | null;
  ip_addresses_json: string;
  os: string | null;
  agent_version: string | null;
  keepalive_seconds: number | null;
  boot_time: number | null;
  last_seen_at_ms: number | null;
  last_state_changed_at_ms: number | null;
  next_offline_at_ms: number | null;
  region: string | null;
  geo_latitude: number | null;
  geo_longitude: number | null;
  geo_city: string | null;
  geo_region_name: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  deleted_at_ms: number | null;
};

function timestamp(value: string | null, code: string, nullable = false) {
  if (nullable && !value) return null;
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
}

function integer(value: unknown, code: string, minimum = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(code);
  return number;
}

function finiteNullable(value: unknown, code: string) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(code);
  return number;
}

function bool(value: unknown, code: string) {
  const number = Number(value ?? 0);
  if (![0, 1].includes(number)) throw new Error(code);
  return number;
}

function stringArray(value: string | null, code: string) {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(code);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(code);
  }
  return [...new Set(parsed.map((item) => item.trim()).filter(Boolean))];
}

async function prepareSource(row: SourceRow): Promise<PreparedRow> {
  if (!Number.isSafeInteger(row.id) || row.id <= 0) throw new Error("INVALID_SOURCE_ID");
  if (!row.name.trim()) throw new Error("INVALID_NAME");
  const collectSeconds = integer(row.collect_interval ?? 60, "INVALID_COLLECT_INTERVAL", 1);
  const reportSeconds = integer(row.report_interval ?? 300, "INVALID_REPORT_INTERVAL", 1);
  const keepaliveSeconds = row.keepalive
    ? integer(row.keepalive, "INVALID_KEEPALIVE", 1)
    : null;
  const status = row.status ?? "inactive";
  if (!["active", "inactive"].includes(status)) throw new Error("INVALID_STATUS");
  const autoRenewal = bool(row.auto_renewal, "INVALID_AUTO_RENEWAL");
  const hidden = bool(row.is_hidden, "INVALID_HIDDEN");
  const autoUpdate = bool(row.auto_update, "INVALID_AUTO_UPDATE");
  const trafficResetDay = integer(row.traffic_reset_day ?? 1, "INVALID_RESET_DAY", 1);
  if (trafficResetDay > 28) throw new Error("INVALID_RESET_DAY");
  const trafficCalcType = row.traffic_calc_type ?? "sum";
  if (!["sum", "rx", "tx"].includes(trafficCalcType)) {
    throw new Error("INVALID_TRAFFIC_CALC_TYPE");
  }
  const price = finiteNullable(row.price, "INVALID_PRICE");
  if (price !== null && price < 0) throw new Error("INVALID_PRICE");
  const trafficLimit = finiteNullable(row.traffic_limit_gb, "INVALID_TRAFFIC_LIMIT");
  if (trafficLimit !== null && trafficLimit < 0) throw new Error("INVALID_TRAFFIC_LIMIT");
  const latitude = finiteNullable(row.geo_latitude, "INVALID_LATITUDE");
  if (latitude !== null && (latitude < -90 || latitude > 90)) {
    throw new Error("INVALID_LATITUDE");
  }
  const longitude = finiteNullable(row.geo_longitude, "INVALID_LONGITUDE");
  if (longitude !== null && (longitude < -180 || longitude > 180)) {
    throw new Error("INVALID_LONGITUDE");
  }
  if (row.expire_date && !/^\d{4}-\d{2}-\d{2}$/.test(row.expire_date)) {
    throw new Error("INVALID_EXPIRE_DATE");
  }
  const billingCycle = row.billing_cycle;
  if (billingCycle && !["monthly", "quarterly", "yearly", "once"].includes(billingCycle)) {
    throw new Error("INVALID_BILLING_CYCLE");
  }
  const currency = row.currency?.toUpperCase() ?? null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error("INVALID_CURRENCY");
  const tags = row.tags
    ? [...new Set(row.tags.split(",").map((item) => item.trim()).filter(Boolean))]
    : [];
  const normalized = {
    id: row.id,
    name: row.name.trim(),
    collect_interval_ms: collectSeconds * 1000,
    report_interval_ms: reportSeconds * 1000,
    group_name: row.group_name?.trim() || null,
    tags_json: canonicalMigrationJson(tags),
    price,
    currency,
    billing_cycle: billingCycle,
    expire_date: row.expire_date,
    auto_renewal: autoRenewal,
    is_hidden: hidden,
    traffic_limit_gb: trafficLimit,
    traffic_reset_day: trafficResetDay,
    traffic_calc_type: trafficCalcType,
    auto_update: autoUpdate,
    sort_order: Number.isSafeInteger(row.sort_order) ? Number(row.sort_order) : 0,
    status,
    hostname: row.hostname,
    ip_addresses_json: canonicalMigrationJson(
      stringArray(row.ip_addresses, "INVALID_IP_ADDRESSES")
    ),
    os: row.os,
    agent_version: row.version,
    keepalive_seconds: keepaliveSeconds,
    boot_time: row.boot_time === null ? null : integer(row.boot_time, "INVALID_BOOT_TIME"),
    last_seen_at_ms: timestamp(row.last_seen_at, "INVALID_LAST_SEEN", true),
    last_state_changed_at_ms: timestamp(
      row.last_state_changed_at,
      "INVALID_STATE_CHANGED",
      true
    ),
    next_offline_at_ms: timestamp(row.next_offline_at, "INVALID_NEXT_OFFLINE", true),
    region: row.region,
    geo_latitude: latitude,
    geo_longitude: longitude,
    geo_city: row.geo_city,
    geo_region_name: row.geo_region_name,
    created_at_ms: timestamp(row.created_at, "INVALID_CREATED_AT")!,
    updated_at_ms: timestamp(row.updated_at, "INVALID_UPDATED_AT")!,
    deleted_at_ms: timestamp(row.deleted_at, "INVALID_DELETED_AT", true),
  };
  return {
    source_table: SOURCE_TABLE,
    source_id: String(row.id),
    target_id: String(row.id),
    payload_checksum: await migrationSha256Hex(canonicalMigrationJson(normalized)),
    ...normalized,
  };
}

const sourceColumns = `id, name, status, created_at, updated_at, hostname,
  ip_addresses, os, version, keepalive, last_seen_at, last_state_changed_at,
  next_offline_at, collect_interval, report_interval, region, geo_latitude,
  geo_longitude, geo_city, geo_region_name, boot_time, price, currency,
  billing_cycle, expire_date, auto_renewal, is_hidden, traffic_limit_gb,
  traffic_reset_day, traffic_calc_type, auto_update, group_name, tags,
  sort_order, deleted_at`;
const qualifiedSourceColumns = sourceColumns
  .split(",")
  .map((column) => `a.${column.trim()}`)
  .join(", ");

function sourceSelect(suffix: string) {
  return `SELECT ${sourceColumns} FROM agents ${suffix}`;
}

function persist(env: Bindings, rows: PreparedRow[], now: string) {
  if (rows.length === 0) return [];
  const json = JSON.stringify(rows);
  return [
    env.DB.prepare(
      `INSERT INTO agent_nodes
       (id, name, collect_interval_ms, report_interval_ms, group_name, tags_json,
        price, currency, billing_cycle, expire_date, auto_renewal, is_hidden,
        traffic_limit_gb, traffic_reset_day, traffic_calc_type, auto_update,
        sort_order, created_at_ms, updated_at_ms, deleted_at_ms)
       SELECT CAST(json_extract(value, '$.id') AS INTEGER),
              json_extract(value, '$.name'),
              CAST(json_extract(value, '$.collect_interval_ms') AS INTEGER),
              CAST(json_extract(value, '$.report_interval_ms') AS INTEGER),
              json_extract(value, '$.group_name'), json_extract(value, '$.tags_json'),
              json_extract(value, '$.price'), json_extract(value, '$.currency'),
              json_extract(value, '$.billing_cycle'), json_extract(value, '$.expire_date'),
              CAST(json_extract(value, '$.auto_renewal') AS INTEGER),
              CAST(json_extract(value, '$.is_hidden') AS INTEGER),
              json_extract(value, '$.traffic_limit_gb'),
              CAST(json_extract(value, '$.traffic_reset_day') AS INTEGER),
              json_extract(value, '$.traffic_calc_type'),
              CAST(json_extract(value, '$.auto_update') AS INTEGER),
              CAST(json_extract(value, '$.sort_order') AS INTEGER),
              CAST(json_extract(value, '$.created_at_ms') AS INTEGER),
              CAST(json_extract(value, '$.updated_at_ms') AS INTEGER),
              CAST(json_extract(value, '$.deleted_at_ms') AS INTEGER)
       FROM json_each(?) WHERE 1 = 1
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, collect_interval_ms = excluded.collect_interval_ms,
         report_interval_ms = excluded.report_interval_ms,
         group_name = excluded.group_name, tags_json = excluded.tags_json,
         price = excluded.price, currency = excluded.currency,
         billing_cycle = excluded.billing_cycle, expire_date = excluded.expire_date,
         auto_renewal = excluded.auto_renewal, is_hidden = excluded.is_hidden,
         traffic_limit_gb = excluded.traffic_limit_gb,
         traffic_reset_day = excluded.traffic_reset_day,
         traffic_calc_type = excluded.traffic_calc_type,
         auto_update = excluded.auto_update, sort_order = excluded.sort_order,
         updated_at_ms = excluded.updated_at_ms,
         deleted_at_ms = excluded.deleted_at_ms
       WHERE excluded.updated_at_ms >= agent_nodes.updated_at_ms`
    ).bind(json),
    env.DB.prepare(
      `INSERT INTO agent_runtime
       (agent_id, status, hostname, ip_addresses_json, os, agent_version,
        keepalive_seconds, boot_time, last_seen_at_ms, last_state_changed_at_ms,
        next_offline_at_ms, region, geo_latitude, geo_longitude, geo_city,
        geo_region_name, version, created_at_ms, updated_at_ms)
       SELECT CAST(json_extract(value, '$.id') AS INTEGER),
              json_extract(value, '$.status'), json_extract(value, '$.hostname'),
              json_extract(value, '$.ip_addresses_json'), json_extract(value, '$.os'),
              json_extract(value, '$.agent_version'),
              CAST(json_extract(value, '$.keepalive_seconds') AS INTEGER),
              CAST(json_extract(value, '$.boot_time') AS INTEGER),
              CAST(json_extract(value, '$.last_seen_at_ms') AS INTEGER),
              CAST(json_extract(value, '$.last_state_changed_at_ms') AS INTEGER),
              CAST(json_extract(value, '$.next_offline_at_ms') AS INTEGER),
              json_extract(value, '$.region'), json_extract(value, '$.geo_latitude'),
              json_extract(value, '$.geo_longitude'), json_extract(value, '$.geo_city'),
              json_extract(value, '$.geo_region_name'), 0,
              CAST(json_extract(value, '$.created_at_ms') AS INTEGER),
              CAST(json_extract(value, '$.updated_at_ms') AS INTEGER)
       FROM json_each(?) WHERE 1 = 1
       ON CONFLICT(agent_id) DO UPDATE SET
         status = excluded.status, hostname = excluded.hostname,
         ip_addresses_json = excluded.ip_addresses_json, os = excluded.os,
         agent_version = excluded.agent_version,
         keepalive_seconds = excluded.keepalive_seconds, boot_time = excluded.boot_time,
         last_seen_at_ms = excluded.last_seen_at_ms,
         last_state_changed_at_ms = excluded.last_state_changed_at_ms,
         next_offline_at_ms = excluded.next_offline_at_ms, region = excluded.region,
         geo_latitude = excluded.geo_latitude, geo_longitude = excluded.geo_longitude,
         geo_city = excluded.geo_city, geo_region_name = excluded.geo_region_name,
         version = agent_runtime.version + 1, updated_at_ms = excluded.updated_at_ms
       WHERE excluded.updated_at_ms >= agent_runtime.updated_at_ms`
    ).bind(json),
    env.DB.prepare(
      `INSERT INTO legacy_id_map
       (source_table, source_id, target_table, target_id, payload_checksum,
        created_at, updated_at)
       SELECT ?, json_extract(value, '$.source_id'), ?,
              json_extract(value, '$.target_id'),
              json_extract(value, '$.payload_checksum'), ?, ?
       FROM json_each(?) WHERE 1 = 1
       ON CONFLICT(source_table, source_id) DO UPDATE SET
         target_table = excluded.target_table, target_id = excluded.target_id,
         payload_checksum = excluded.payload_checksum,
         updated_at = excluded.updated_at`
    ).bind(SOURCE_TABLE, TARGET_TABLE, now, now, json),
  ];
}

/** 将单个兼容表 Agent 投影到 v2 配置/运行态表，供写路径同步调用。 */
export async function projectLegacyAgentModel(env: Bindings, agentId: number) {
  const source = await env.DB.prepare(sourceSelect("WHERE id = ? LIMIT 1"))
    .bind(agentId)
    .first<SourceRow>();
  if (!source) return false;
  const prepared = await prepareSource(source);
  await env.DB.batch(persist(env, [prepared], new Date().toISOString()));
  return true;
}

async function reconcileLegacyAgentModel(env: Bindings) {
  const source = await env.DB.prepare(
    `SELECT ${qualifiedSourceColumns},
            CASE WHEN map.source_id IS NULL OR node.id IS NULL
                       OR runtime.agent_id IS NULL THEN 1 ELSE 0 END AS target_missing
     FROM agents a
     LEFT JOIN legacy_id_map map
       ON map.source_table = ? AND map.source_id = CAST(a.id AS TEXT)
      AND map.target_table = ?
     LEFT JOIN agent_nodes node ON node.id = CAST(map.target_id AS INTEGER)
     LEFT JOIN agent_runtime runtime ON runtime.agent_id = node.id
     WHERE (
       map.source_id IS NULL OR node.id IS NULL OR runtime.agent_id IS NULL
       OR julianday(a.updated_at) > julianday(map.updated_at)
     ) AND NOT EXISTS (
       SELECT 1 FROM migration_anomalies anomaly
       WHERE anomaly.migration_key = ? AND anomaly.source_table = ?
         AND anomaly.source_pk = CAST(a.id AS TEXT)
         AND anomaly.status IN ('open', 'ignored')
     )
     ORDER BY target_missing DESC, a.updated_at ASC, a.id ASC LIMIT 1`
  )
    .bind(SOURCE_TABLE, TARGET_TABLE, MIGRATION_KEY, SOURCE_TABLE)
    .first<SourceRow & { target_missing: number }>();
  if (!source) return null;
  const checkpoint = await claimMigrationCheckpoint(env, MIGRATION_KEY);
  if (!checkpoint) {
    return {
      configured: true,
      migrated: 0,
      reconciled: 0,
      anomalies: 0,
      remaining: true,
      busy: true,
    };
  }
  const now = new Date().toISOString();
  let prepared: PreparedRow;
  try {
    prepared = await prepareSource(source);
  } catch (error) {
    const errorCode = (error instanceof Error ? error.message : String(error)).slice(
      0,
      128
    );
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
        canonicalMigrationJson(source),
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
    return {
      configured: true,
      migrated: 0,
      reconciled: 0,
      anomalies: 1,
      remaining: false,
    };
  }
  const missing = source.target_missing === 1;
  await env.DB.batch([
    ...persist(env, [prepared], now),
    env.DB.prepare(
      `UPDATE migration_checkpoints
       SET status = CASE WHEN anomaly_rows > 0 THEN 'completed_with_anomalies'
                         ELSE 'completed' END,
           rows_written = rows_written + ?, rows_skipped = rows_skipped + ?,
           lease_token = NULL, lease_expires_at = NULL,
           completed_at = ?, updated_at = ?
       WHERE migration_key = ? AND lease_token = ?`
    ).bind(
      missing ? 1 : 0,
      missing ? 0 : 1,
      now,
      now,
      MIGRATION_KEY,
      checkpoint.lease_token
    ),
  ]);
  return {
    configured: true,
    migrated: missing ? 1 : 0,
    reconciled: missing ? 0 : 1,
    anomalies: 0,
    remaining: true,
  };
}

async function retryRequested(env: Bindings) {
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
  const source = await env.DB.prepare(sourceSelect("WHERE id = ? LIMIT 1"))
    .bind(Number(anomaly.source_pk))
    .first<SourceRow>();
  let prepared: PreparedRow;
  try {
    if (!source) throw new Error("SOURCE_ROW_MISSING");
    prepared = await prepareSource(source);
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE migration_anomalies SET status = 'open', resolution_note = ?,
         resolved_at = NULL, updated_at = ? WHERE id = ?`
      ).bind((error instanceof Error ? error.message : String(error)).slice(0, 1000), now, anomaly.id),
      env.DB.prepare(
        `UPDATE migration_checkpoints SET status = 'completed_with_anomalies',
         lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE migration_key = ? AND lease_token = ?`
      ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
    ]);
    return { configured: true, migrated: 0, anomalies: 1, remaining: true };
  }
  await env.DB.batch([
    ...persist(env, [prepared], now),
    env.DB.prepare(
      `UPDATE migration_anomalies SET status = 'resolved',
       resolution_note = 'retry_succeeded', resolved_at = ?, updated_at = ?
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

export async function backfillLegacyAgentModel(env: Bindings, requestedLimit?: number) {
  const retried = await retryRequested(env);
  if (retried) return retried;
  const maximum = await env.DB.prepare(
    `SELECT COALESCE(MAX(id), 0) AS max_id FROM agents`
  ).first<{ max_id: number }>();
  const current = await env.DB.prepare(
    `SELECT status, last_pk FROM migration_checkpoints WHERE migration_key = ? LIMIT 1`
  )
    .bind(MIGRATION_KEY)
    .first<{ status: string; last_pk: string | null }>();
  const lastPk = Number(current?.last_pk ?? 0);
  if (
    current && ["completed", "completed_with_anomalies"].includes(current.status) &&
    Number(maximum?.max_id ?? 0) <= (Number.isFinite(lastPk) ? lastPk : 0)
  ) {
    return (
      (await reconcileLegacyAgentModel(env)) ?? {
        configured: true,
        migrated: 0,
        reconciled: 0,
        anomalies: 0,
        remaining: false,
      }
    );
  }
  const checkpoint = await claimMigrationCheckpoint(env, MIGRATION_KEY);
  if (!checkpoint) {
    return { configured: true, migrated: 0, anomalies: 0, remaining: true, busy: true };
  }
  const limit = Math.min(
    requestedLimit ?? getEnvNumber(env, "LEGACY_AGENT_MODEL_BACKFILL_BATCH_SIZE", 100, {
      min: 1,
      max: 500,
    }),
    500
  );
  const claimedLastPk = Number(checkpoint.last_pk ?? 0);
  const result = await env.DB.prepare(
    sourceSelect("WHERE id > ? ORDER BY id ASC LIMIT ?")
  )
    .bind(Number.isFinite(claimedLastPk) ? claimedLastPk : 0, limit + 1)
    .all<SourceRow>();
  const sourceRows = result.results.slice(0, limit);
  const remaining = result.results.length > limit;
  const prepared: PreparedRow[] = [];
  const anomalies: Array<{ source_id: string; error_code: string; raw_value_json: string }> = [];
  for (const row of sourceRows) {
    try {
      prepared.push(await prepareSource(row));
    } catch (error) {
      anomalies.push({
        source_id: String(row.id),
        error_code: (error instanceof Error ? error.message : String(error)).slice(0, 128),
        raw_value_json: canonicalMigrationJson(row),
      });
    }
  }
  const now = new Date().toISOString();
  const batchChecksum = await migrationSha256Hex(
    canonicalMigrationJson(sourceRows.map((row) => ({
      source_id: String(row.id),
      target_id: prepared.find((item) => item.id === row.id)?.target_id,
      anomaly: anomalies.find((item) => item.source_id === String(row.id))?.error_code,
    })))
  );
  const checksum = await migrationSha256Hex(`${checkpoint.checksum ?? ""}:${batchChecksum}`);
  const status = remaining
    ? "running"
    : anomalies.length > 0 || checkpoint.anomaly_rows > 0
      ? "completed_with_anomalies"
      : "completed";
  const statements = persist(env, prepared, now);
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
  return { configured: true, migrated: prepared.length, anomalies: anomalies.length, remaining, checksum };
}

export async function legacyAgentModelCoverage(env: Pick<Bindings, "DB">) {
  const [source, mapped, anomalies] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM agents`).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM legacy_id_map map
       JOIN agent_nodes node ON node.id = CAST(map.target_id AS INTEGER)
       JOIN agent_runtime runtime ON runtime.agent_id = node.id
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
