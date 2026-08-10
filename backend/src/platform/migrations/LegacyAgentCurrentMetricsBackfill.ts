import type { Bindings } from "../../models/db";
import { getEnvNumber } from "../../utils/env";
import {
  canonicalMigrationJson,
  migrationSha256Hex,
} from "./MigrationEncoding";
import { claimMigrationCheckpoint } from "./MigrationLedger";
import { legacyAgentModelCoverage } from "./LegacyAgentModelBackfill";

const SOURCE_TABLE = "agent_latest_metrics";
const TARGET_TABLE = "agent_current_metrics";
const MIGRATION_KEY = "legacy-agent-current-metrics-v1";

type SourceRow = {
  agent_id: number;
  metrics_json: string;
  collected_at: string | null;
  reported_at: string;
  cpu_usage: number | null;
  memory_usage_rate: number | null;
  disk_usage_rate: number | null;
  swap_total: number | null;
  swap_used: number | null;
  process_count: number | null;
  tcp_connections: number | null;
  udp_connections: number | null;
  ping_json: string | null;
  ipv4_reachable: number | null;
  ipv6_reachable: number | null;
  network_rx_speed: number | null;
  network_tx_speed: number | null;
  month_rx: number | null;
  month_tx: number | null;
  last_total_rx: number | null;
  last_total_tx: number | null;
  month_reset_at: string | null;
  updated_at: string;
};

type PreparedRow = {
  source_id: string;
  target_id: string;
  payload_checksum: string;
  agent_id: number;
  metrics_json: string;
  collected_at_ms: number | null;
  reported_at_ms: number;
  cpu_usage: number | null;
  memory_usage_rate: number | null;
  disk_usage_rate: number | null;
  swap_total: number | null;
  swap_used: number | null;
  process_count: number | null;
  tcp_connections: number | null;
  udp_connections: number | null;
  ping_json: string | null;
  ipv4_reachable: number | null;
  ipv6_reachable: number | null;
  network_rx_speed: number | null;
  network_tx_speed: number | null;
  month_rx: number;
  month_tx: number;
  last_total_rx: number | null;
  last_total_tx: number | null;
  traffic_period_start: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

const sourceColumns = `agent_id, metrics_json, collected_at, reported_at,
  cpu_usage, memory_usage_rate, disk_usage_rate, swap_total, swap_used,
  process_count, tcp_connections, udp_connections, ping_json,
  ipv4_reachable, ipv6_reachable, network_rx_speed, network_tx_speed,
  month_rx, month_tx, last_total_rx, last_total_tx, month_reset_at, updated_at`;
const qualifiedSourceColumns = sourceColumns
  .split(",")
  .map((column) => `source.${column.trim()}`)
  .join(", ");

function sourceSelect(suffix: string) {
  return `SELECT ${sourceColumns} FROM agent_latest_metrics ${suffix}`;
}

function timestamp(value: string | null, code: string, nullable = false) {
  if (nullable && !value) return null;
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
}

function finite(value: unknown, code: string, minimum?: number) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (minimum !== undefined && parsed < minimum)) {
    throw new Error(code);
  }
  return parsed;
}

function flag(value: unknown, code: string) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (parsed !== 0 && parsed !== 1) throw new Error(code);
  return parsed;
}

function jsonObject(value: string, code: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(code);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(code);
  }
  return canonicalMigrationJson(parsed);
}

async function prepareSource(row: SourceRow): Promise<PreparedRow> {
  if (!Number.isSafeInteger(row.agent_id) || row.agent_id <= 0) {
    throw new Error("INVALID_AGENT_ID");
  }
  const reportedAtMs = timestamp(row.reported_at, "INVALID_REPORTED_AT")!;
  const updatedAtMs = timestamp(row.updated_at, "INVALID_UPDATED_AT")!;
  const period = row.month_reset_at?.trim() || null;
  if (period && !/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    throw new Error("INVALID_TRAFFIC_PERIOD");
  }
  const normalized = {
    agent_id: row.agent_id,
    metrics_json: jsonObject(row.metrics_json, "INVALID_METRICS_JSON"),
    collected_at_ms: timestamp(row.collected_at, "INVALID_COLLECTED_AT", true),
    reported_at_ms: reportedAtMs,
    cpu_usage: finite(row.cpu_usage, "INVALID_CPU_USAGE", 0),
    memory_usage_rate: finite(row.memory_usage_rate, "INVALID_MEMORY_USAGE", 0),
    disk_usage_rate: finite(row.disk_usage_rate, "INVALID_DISK_USAGE", 0),
    swap_total: finite(row.swap_total, "INVALID_SWAP_TOTAL", 0),
    swap_used: finite(row.swap_used, "INVALID_SWAP_USED", 0),
    process_count: finite(row.process_count, "INVALID_PROCESS_COUNT", 0),
    tcp_connections: finite(row.tcp_connections, "INVALID_TCP_CONNECTIONS", 0),
    udp_connections: finite(row.udp_connections, "INVALID_UDP_CONNECTIONS", 0),
    ping_json: row.ping_json
      ? jsonObject(row.ping_json, "INVALID_PING_JSON")
      : null,
    ipv4_reachable: flag(row.ipv4_reachable, "INVALID_IPV4_REACHABLE"),
    ipv6_reachable: flag(row.ipv6_reachable, "INVALID_IPV6_REACHABLE"),
    network_rx_speed: finite(row.network_rx_speed, "INVALID_RX_SPEED", 0),
    network_tx_speed: finite(row.network_tx_speed, "INVALID_TX_SPEED", 0),
    month_rx: finite(row.month_rx ?? 0, "INVALID_MONTH_RX", 0) ?? 0,
    month_tx: finite(row.month_tx ?? 0, "INVALID_MONTH_TX", 0) ?? 0,
    last_total_rx: finite(row.last_total_rx, "INVALID_TOTAL_RX", 0),
    last_total_tx: finite(row.last_total_tx, "INVALID_TOTAL_TX", 0),
    traffic_period_start: period,
    created_at_ms: Math.min(reportedAtMs, updatedAtMs),
    updated_at_ms: updatedAtMs,
  };
  return {
    source_id: String(row.agent_id),
    target_id: String(row.agent_id),
    payload_checksum: await migrationSha256Hex(
      canonicalMigrationJson(normalized)
    ),
    ...normalized,
  };
}

function persist(env: Pick<Bindings, "DB">, rows: PreparedRow[], now: string) {
  if (rows.length === 0) return [];
  const json = JSON.stringify(rows);
  return [
    env.DB.prepare(
      `INSERT INTO agent_current_metrics
       (agent_id, metrics_json, collected_at_ms, reported_at_ms, cpu_usage,
        memory_usage_rate, disk_usage_rate, swap_total, swap_used, process_count,
        tcp_connections, udp_connections, ping_json, ipv4_reachable,
        ipv6_reachable, network_rx_speed, network_tx_speed, month_rx, month_tx,
        last_total_rx, last_total_tx, traffic_period_start, version,
        created_at_ms, updated_at_ms)
       SELECT CAST(json_extract(value, '$.agent_id') AS INTEGER),
              json_extract(value, '$.metrics_json'),
              CAST(json_extract(value, '$.collected_at_ms') AS INTEGER),
              CAST(json_extract(value, '$.reported_at_ms') AS INTEGER),
              json_extract(value, '$.cpu_usage'),
              json_extract(value, '$.memory_usage_rate'),
              json_extract(value, '$.disk_usage_rate'),
              json_extract(value, '$.swap_total'), json_extract(value, '$.swap_used'),
              json_extract(value, '$.process_count'),
              json_extract(value, '$.tcp_connections'),
              json_extract(value, '$.udp_connections'),
              json_extract(value, '$.ping_json'),
              CAST(json_extract(value, '$.ipv4_reachable') AS INTEGER),
              CAST(json_extract(value, '$.ipv6_reachable') AS INTEGER),
              json_extract(value, '$.network_rx_speed'),
              json_extract(value, '$.network_tx_speed'),
              CAST(json_extract(value, '$.month_rx') AS INTEGER),
              CAST(json_extract(value, '$.month_tx') AS INTEGER),
              CAST(json_extract(value, '$.last_total_rx') AS INTEGER),
              CAST(json_extract(value, '$.last_total_tx') AS INTEGER),
              json_extract(value, '$.traffic_period_start'), 0,
              CAST(json_extract(value, '$.created_at_ms') AS INTEGER),
              CAST(json_extract(value, '$.updated_at_ms') AS INTEGER)
       FROM json_each(?) WHERE 1 = 1
       ON CONFLICT(agent_id) DO UPDATE SET
         metrics_json = excluded.metrics_json,
         collected_at_ms = excluded.collected_at_ms,
         reported_at_ms = excluded.reported_at_ms,
         cpu_usage = excluded.cpu_usage,
         memory_usage_rate = excluded.memory_usage_rate,
         disk_usage_rate = excluded.disk_usage_rate,
         swap_total = excluded.swap_total, swap_used = excluded.swap_used,
         process_count = excluded.process_count,
         tcp_connections = excluded.tcp_connections,
         udp_connections = excluded.udp_connections, ping_json = excluded.ping_json,
         ipv4_reachable = excluded.ipv4_reachable,
         ipv6_reachable = excluded.ipv6_reachable,
         network_rx_speed = excluded.network_rx_speed,
         network_tx_speed = excluded.network_tx_speed,
         month_rx = excluded.month_rx, month_tx = excluded.month_tx,
         last_total_rx = excluded.last_total_rx,
         last_total_tx = excluded.last_total_tx,
         traffic_period_start = excluded.traffic_period_start,
         version = agent_current_metrics.version + 1,
         updated_at_ms = excluded.updated_at_ms
       WHERE COALESCE(excluded.collected_at_ms, excluded.reported_at_ms) >=
             COALESCE(agent_current_metrics.collected_at_ms,
                      agent_current_metrics.reported_at_ms)`
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
  const sourceId = Number(anomaly.source_pk);
  const source = Number.isSafeInteger(sourceId)
    ? await env.DB.prepare(sourceSelect("WHERE agent_id = ? LIMIT 1"))
        .bind(sourceId)
        .first<SourceRow>()
    : null;
  let prepared: PreparedRow;
  try {
    if (!source) throw new Error("SOURCE_ROW_MISSING");
    prepared = await prepareSource(source);
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE migration_anomalies SET status = 'open', resolution_note = ?,
         resolved_at = NULL, updated_at = ? WHERE id = ?`
      ).bind(
        (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        now,
        anomaly.id
      ),
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

async function reconcile(env: Bindings) {
  const source = await env.DB.prepare(
    `SELECT ${qualifiedSourceColumns},
            CASE WHEN map.source_id IS NULL OR target.agent_id IS NULL
                 THEN 1 ELSE 0 END AS target_missing
     FROM agent_latest_metrics source
     LEFT JOIN legacy_id_map map
       ON map.source_table = ? AND map.source_id = CAST(source.agent_id AS TEXT)
      AND map.target_table = ?
     LEFT JOIN agent_current_metrics target
       ON target.agent_id = CAST(map.target_id AS INTEGER)
     WHERE (map.source_id IS NULL OR target.agent_id IS NULL
            OR julianday(source.updated_at) > julianday(map.updated_at))
       AND NOT EXISTS (
         SELECT 1 FROM migration_anomalies anomaly
         WHERE anomaly.migration_key = ? AND anomaly.source_table = ?
           AND anomaly.source_pk = CAST(source.agent_id AS TEXT)
           AND anomaly.status IN ('open', 'ignored')
       )
     ORDER BY target_missing DESC, source.updated_at ASC, source.agent_id ASC
     LIMIT 1`
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
        String(source.agent_id),
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

export async function backfillLegacyAgentCurrentMetrics(
  env: Bindings,
  requestedLimit?: number
) {
  if (!(await legacyAgentModelCoverage(env)).read_ready) {
    return {
      configured: true,
      migrated: 0,
      anomalies: 0,
      remaining: true,
      waiting_for: "legacy-agent-model-v2",
    };
  }
  const retried = await retryRequested(env);
  if (retried) return retried;
  const maximum = await env.DB.prepare(
    `SELECT COALESCE(MAX(agent_id), 0) AS max_id FROM agent_latest_metrics`
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
      (await reconcile(env)) ?? {
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
    requestedLimit ??
      getEnvNumber(env, "LEGACY_AGENT_CURRENT_METRICS_BACKFILL_BATCH_SIZE", 100, {
        min: 1,
        max: 500,
      }),
    500
  );
  const claimedLastPk = Number(checkpoint.last_pk ?? 0);
  const rows = await env.DB.prepare(
    sourceSelect("WHERE agent_id > ? ORDER BY agent_id ASC LIMIT ?")
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
        source_id: String(row.agent_id),
        error_code: (error instanceof Error ? error.message : String(error)).slice(
          0,
          128
        ),
        raw_value_json: canonicalMigrationJson(row),
      });
    }
  }
  const now = new Date().toISOString();
  const batchChecksum = await migrationSha256Hex(
    canonicalMigrationJson(
      sourceRows.map((row) => ({
        source_id: String(row.agent_id),
        target_id: prepared.find((item) => item.agent_id === row.agent_id)
          ?.target_id,
        anomaly: anomalies.find(
          (item) => item.source_id === String(row.agent_id)
        )?.error_code,
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
           resolution_note = NULL, resolved_at = NULL,
           updated_at = excluded.updated_at`
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
      String(sourceRows.at(-1)?.agent_id ?? claimedLastPk),
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

export async function legacyAgentCurrentMetricsCoverage(
  env: Pick<Bindings, "DB">
) {
  const [source, mapped, anomalies] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM agent_latest_metrics`).first<{
      count: number;
    }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM legacy_id_map map
       JOIN agent_current_metrics target
         ON target.agent_id = CAST(map.target_id AS INTEGER)
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
