import type { Bindings } from "../../models/db";
import { getEnvNumber } from "../../utils/env";
import { claimMigrationCheckpoint } from "./MigrationLedger";
import {
  canonicalMigrationJson as canonicalJson,
  migrationSha256Hex as sha256Hex,
  migrationUuidFromDigest as uuidFromDigest,
} from "./MigrationEncoding";
import {
  agentMetricBucket,
  prepareAgentMetricRollupRebuild,
} from "../../modules/agents/persistence/D1AgentMetricRollup";

const MIGRATION_PREFIX = "legacy-agent-history-v1:";
const SOURCE_TABLE_PATTERN = /^(agent_metrics_24h|agent_metrics_history(?:_old|_\d+)?)$/;

type SourceRow = Record<string, unknown> & { id: number; agent_id: number };
type PreparedRow = {
  report_id: string;
  agent_id: number;
  collected_at: string;
  payload_digest: string;
  payload_json: string;
  metrics_json: string;
  source_table: string;
  source_id: string;
  payload_checksum: string;
};

type PreparedAnomaly = {
  source_table: string;
  source_id: string;
  error_code: string;
  raw_value_json: string;
};


function finiteNumber(value: unknown, field: string) {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`INVALID_NUMBER:${field}`);
  return number;
}

function percentage(value: unknown, field: string) {
  const number = finiteNumber(value, field);
  if (number !== undefined && (number < 0 || number > 100)) {
    throw new Error(`INVALID_PERCENTAGE:${field}`);
  }
  return number;
}

function parseJson(value: unknown, field: string, fallback: unknown) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`INVALID_JSON:${field}`);
  }
}

function timestampFromLegacyId(id: number) {
  const suffix = String(Math.trunc(Math.abs(id))).slice(-12);
  if (!/^\d{12}$/.test(suffix)) return null;
  const year = 2000 + Number(suffix.slice(0, 2));
  const month = Number(suffix.slice(2, 4));
  const day = Number(suffix.slice(4, 6));
  const hour = Number(suffix.slice(6, 8));
  const minute = Number(suffix.slice(8, 10));
  const second = Number(suffix.slice(10, 12));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
    ? date.toISOString()
    : null;
}

function collectedAt(row: SourceRow, sourceTable: string) {
  const parsed = Date.parse(String(row.timestamp ?? ""));
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  if (sourceTable !== "agent_metrics_24h") {
    const inferred = timestampFromLegacyId(row.id);
    if (inferred) return inferred;
  }
  throw new Error("INVALID_TIMESTAMP:timestamp");
}

function normalizeRow(row: SourceRow, sourceTable: string) {
  if (!Number.isInteger(row.id)) throw new Error("INVALID_SOURCE_ID:id");
  if (!Number.isInteger(row.agent_id) || row.agent_id <= 0) {
    throw new Error("INVALID_AGENT_ID:agent_id");
  }
  const disks = parseJson(row.disk_metrics, "disk_metrics", []);
  const network = parseJson(row.network_metrics, "network_metrics", []);
  const ping = parseJson(row.ping_json, "ping_json", {});
  if (!Array.isArray(disks)) throw new Error("INVALID_JSON_SHAPE:disk_metrics");
  if (!Array.isArray(network)) throw new Error("INVALID_JSON_SHAPE:network_metrics");
  if (!ping || typeof ping !== "object" || Array.isArray(ping)) {
    throw new Error("INVALID_JSON_SHAPE:ping_json");
  }
  const sample = {
    collected_at: collectedAt(row, sourceTable),
    cpu: {
      usage: percentage(row.cpu_usage, "cpu_usage"),
      cores: finiteNumber(row.cpu_cores, "cpu_cores"),
      model_name: typeof row.cpu_model === "string" ? row.cpu_model : undefined,
    },
    memory: {
      total: finiteNumber(row.memory_total, "memory_total"),
      used: finiteNumber(row.memory_used, "memory_used"),
      free: finiteNumber(row.memory_free, "memory_free"),
      usage_rate: percentage(row.memory_usage_rate, "memory_usage_rate"),
    },
    load: {
      load1: finiteNumber(row.load_1, "load_1"),
      load5: finiteNumber(row.load_5, "load_5"),
      load15: finiteNumber(row.load_15, "load_15"),
    },
    disks,
    network,
    swap:
      row.swap_total == null && row.swap_used == null
        ? undefined
        : {
            total: finiteNumber(row.swap_total, "swap_total"),
            used: finiteNumber(row.swap_used, "swap_used"),
          },
    process_count: finiteNumber(row.process_count, "process_count"),
    tcp_connections: finiteNumber(row.tcp_connections, "tcp_connections"),
    udp_connections: finiteNumber(row.udp_connections, "udp_connections"),
    ping,
    ipv4_reachable:
      row.ipv4_reachable == null ? undefined : Boolean(row.ipv4_reachable),
    ipv6_reachable:
      row.ipv6_reachable == null ? undefined : Boolean(row.ipv6_reachable),
    network_rx_speed: finiteNumber(row.network_rx_speed, "network_rx_speed"),
    network_tx_speed: finiteNumber(row.network_tx_speed, "network_tx_speed"),
  };
  return sample;
}

async function prepareRow(row: SourceRow, sourceTable: string): Promise<PreparedRow> {
  const sample = normalizeRow(row, sourceTable);
  const metricsJson = canonicalJson(sample);
  const payloadChecksum = await sha256Hex(metricsJson);
  const reportIdentity = canonicalJson({
    agent_id: row.agent_id,
    collected_at: sample.collected_at,
    payload_checksum: payloadChecksum,
  });
  const reportId = uuidFromDigest(await sha256Hex(reportIdentity));
  const payloadJson = canonicalJson({
    protocol_version: 4,
    report_id: reportId,
    samples: [sample],
  });
  return {
    report_id: reportId,
    agent_id: row.agent_id,
    collected_at: sample.collected_at,
    payload_digest: await sha256Hex(payloadJson),
    payload_json: payloadJson,
    metrics_json: metricsJson,
    source_table: sourceTable,
    source_id: String(row.id),
    payload_checksum: payloadChecksum,
  };
}

function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(":", 1)[0].slice(0, 128) || "LEGACY_HISTORY_INVALID";
}

export async function listLegacyAgentHistorySourceTables(env: Bindings) {
  const rows = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND (
       name = 'agent_metrics_24h' OR name = 'agent_metrics_history' OR
       name = 'agent_metrics_history_old' OR name GLOB 'agent_metrics_history_[0-9]*'
     )`
  ).all<{ name: string }>();
  return rows.results
    .map((row) => row.name)
    .filter((name) => SOURCE_TABLE_PATTERN.test(name))
    .sort((left, right) => {
      const priority = (name: string) =>
        name === "agent_metrics_history"
          ? 0
          : name.startsWith("agent_metrics_history_")
            ? 1
            : 2;
      return priority(left) - priority(right) || left.localeCompare(right);
    });
}

async function chooseSource(env: Bindings) {
  for (const table of await listLegacyAgentHistorySourceTables(env)) {
    const checkpoint = await env.DB.prepare(
      `SELECT status, last_pk, checksum, anomaly_rows FROM migration_checkpoints
       WHERE migration_key = ? LIMIT 1`
    )
      .bind(`${MIGRATION_PREFIX}${table}`)
      .first<{
        status: string;
        last_pk: string | null;
        checksum: string | null;
        anomaly_rows: number;
      }>();
    const maximum = await env.DB.prepare(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM "${table}"`
    ).first<{ max_id: number }>();
    const lastPk = Number(checkpoint?.last_pk ?? 0);
    if (
      !checkpoint ||
      !["completed", "completed_with_anomalies"].includes(checkpoint.status) ||
      Number(maximum?.max_id ?? 0) > (Number.isFinite(lastPk) ? lastPk : 0)
    ) {
      return { table, checkpoint };
    }
  }
  return null;
}

async function retryRequestedAnomaly(env: Bindings) {
  const anomaly = await env.DB.prepare(
    `SELECT id, migration_key, source_table, source_pk
     FROM migration_anomalies
     WHERE status = 'retry_requested' AND migration_key LIKE ?
     ORDER BY id ASC LIMIT 1`
  )
    .bind(`${MIGRATION_PREFIX}%`)
    .first<{
      id: number;
      migration_key: string;
      source_table: string;
      source_pk: string;
    }>();
  if (!anomaly) return null;
  const checkpoint = await claimMigrationCheckpoint(env, anomaly.migration_key);
  if (!checkpoint) {
    return {
      configured: true,
      sourceTable: anomaly.source_table,
      migrated: 0,
      deduplicated: 0,
      anomalies: 0,
      remaining: true,
      busy: true,
    };
  }
  const now = new Date().toISOString();
  const sourceId = Number(anomaly.source_pk);
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
      ).bind(now, now, anomaly.migration_key, checkpoint.lease_token),
    ]);
    return {
      configured: true,
      sourceTable: anomaly.source_table,
      migrated: 0,
      deduplicated: 0,
      anomalies: 1,
      remaining: true,
    };
  };
  if (!SOURCE_TABLE_PATTERN.test(anomaly.source_table) || !Number.isInteger(sourceId)) {
    return fail("INVALID_ANOMALY_SOURCE");
  }
  const source = await env.DB.prepare(
    `SELECT * FROM "${anomaly.source_table}" WHERE id = ? LIMIT 1`
  )
    .bind(sourceId)
    .first<SourceRow>();
  if (!source) return fail("SOURCE_ROW_MISSING");
  const agent = await env.DB.prepare(`SELECT id FROM agents WHERE id = ? LIMIT 1`)
    .bind(source.agent_id)
    .first<{ id: number }>();
  if (!agent) return fail("ORPHAN_AGENT");

  let prepared: PreparedRow;
  try {
    prepared = await prepareRow(source, anomaly.source_table);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const existing = await env.DB.prepare(
    `SELECT report_id FROM agent_reports WHERE report_id = ? LIMIT 1`
  )
    .bind(prepared.report_id)
    .first<{ report_id: string }>();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO agent_reports
       (report_id, agent_id, payload_digest, payload_json, sample_count, status,
        received_at, processed_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'processed', ?, ?, NULL, ?, ?)`
    ).bind(
      prepared.report_id,
      prepared.agent_id,
      prepared.payload_digest,
      prepared.payload_json,
      prepared.collected_at,
      now,
      now,
      now
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO agent_report_samples
       (report_id, sample_index, agent_id, collected_at, metrics_json, created_at)
       VALUES (?, 0, ?, ?, ?, ?)`
    ).bind(
      prepared.report_id,
      prepared.agent_id,
      prepared.collected_at,
      prepared.metrics_json,
      now
    ),
    prepareAgentMetricRollupRebuild(
      env.DB,
      prepared.agent_id,
      agentMetricBucket(prepared.collected_at),
      now
    ),
    env.DB.prepare(
      `INSERT INTO legacy_id_map
       (source_table, source_id, target_table, target_id, payload_checksum,
        created_at, updated_at)
       VALUES (?, ?, 'agent_report_samples', ?, ?, ?, ?)
       ON CONFLICT(source_table, source_id) DO UPDATE SET
         target_table = excluded.target_table,
         target_id = excluded.target_id,
         payload_checksum = excluded.payload_checksum,
         updated_at = excluded.updated_at`
    ).bind(
      prepared.source_table,
      prepared.source_id,
      prepared.report_id,
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
    ).bind(now, now, anomaly.migration_key, checkpoint.lease_token),
  ]);
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM migration_anomalies
     WHERE status = 'retry_requested' AND migration_key LIKE ?`
  )
    .bind(`${MIGRATION_PREFIX}%`)
    .first<{ count: number }>();
  return {
    configured: true,
    sourceTable: anomaly.source_table,
    migrated: existing ? 0 : 1,
    deduplicated: existing ? 1 : 0,
    anomalies: 0,
    remaining: Number(pending?.count ?? 0) > 0 || (await chooseSource(env)) !== null,
  };
}

export async function backfillLegacyAgentHistory(env: Bindings, requestedLimit?: number) {
  const retried = await retryRequestedAnomaly(env);
  if (retried) return retried;
  const selected = await chooseSource(env);
  if (!selected) {
    return { configured: true, migrated: 0, deduplicated: 0, anomalies: 0, remaining: false };
  }
  const migrationKey = `${MIGRATION_PREFIX}${selected.table}`;
  const checkpoint = await claimMigrationCheckpoint(env, migrationKey);
  if (!checkpoint) {
    return {
      configured: true,
      sourceTable: selected.table,
      migrated: 0,
      deduplicated: 0,
      anomalies: 0,
      remaining: true,
      busy: true,
    };
  }
  const limit = Math.min(
    requestedLimit ??
      getEnvNumber(env, "LEGACY_AGENT_HISTORY_BACKFILL_BATCH_SIZE", 100, {
        min: 1,
        max: 500,
      }),
    500
  );
  const lastPk = Number(checkpoint.last_pk ?? 0);
  const rows = await env.DB.prepare(
    `SELECT * FROM "${selected.table}" WHERE id > ? ORDER BY id ASC LIMIT ?`
  )
    .bind(Number.isFinite(lastPk) ? lastPk : 0, limit + 1)
    .all<SourceRow>();
  const sourceRows = rows.results.slice(0, limit);
  const remaining = rows.results.length > limit;
  const now = new Date().toISOString();

  const agentIds = [...new Set(sourceRows.map((row) => Number(row.agent_id)))];
  const existingAgents = agentIds.length
    ? await env.DB.prepare(
        `SELECT id FROM agents
         WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`
      )
        .bind(JSON.stringify(agentIds))
        .all<{ id: number }>()
    : { results: [] as Array<{ id: number }> };
  const agentSet = new Set(existingAgents.results.map((row) => row.id));

  const prepared: PreparedRow[] = [];
  const anomalies: PreparedAnomaly[] = [];
  for (const row of sourceRows) {
    try {
      if (!agentSet.has(Number(row.agent_id))) throw new Error("ORPHAN_AGENT:agent_id");
      prepared.push(await prepareRow(row, selected.table));
    } catch (error) {
      anomalies.push({
        source_table: selected.table,
        source_id: String(row.id),
        error_code: errorCode(error),
        raw_value_json: canonicalJson(row),
      });
    }
  }

  const reportIds = [...new Set(prepared.map((row) => row.report_id))];
  const existingReports = reportIds.length
    ? await env.DB.prepare(
        `SELECT report_id FROM agent_reports
         WHERE report_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`
      )
        .bind(JSON.stringify(reportIds))
        .all<{ report_id: string }>()
    : { results: [] as Array<{ report_id: string }> };
  const knownReports = new Set(existingReports.results.map((row) => row.report_id));
  let migrated = 0;
  let deduplicated = 0;
  for (const row of prepared) {
    if (knownReports.has(row.report_id)) deduplicated += 1;
    else {
      knownReports.add(row.report_id);
      migrated += 1;
    }
  }

  const batchChecksum = await sha256Hex(
    canonicalJson(
      sourceRows.map((row) => ({
        source_id: String(row.id),
        target_id: prepared.find((item) => item.source_id === String(row.id))
          ?.report_id,
        anomaly: anomalies.find((item) => item.source_id === String(row.id))
          ?.error_code,
      }))
    )
  );
  const cumulativeChecksum = await sha256Hex(
    `${checkpoint.checksum ?? ""}:${batchChecksum}`
  );
  const lastProcessedPk = sourceRows.at(-1)?.id ?? lastPk;
  const status = remaining
    ? "running"
    : anomalies.length > 0 || Number(checkpoint.anomaly_rows ?? 0) > 0
      ? "completed_with_anomalies"
      : "completed";

  const statements: D1PreparedStatement[] = [];
  if (prepared.length > 0) {
    const json = JSON.stringify(prepared);
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO agent_reports
         (report_id, agent_id, payload_digest, payload_json, sample_count, status,
          received_at, processed_at, last_error, created_at, updated_at)
         SELECT json_extract(value, '$.report_id'),
                CAST(json_extract(value, '$.agent_id') AS INTEGER),
                json_extract(value, '$.payload_digest'),
                json_extract(value, '$.payload_json'), 1, 'processed',
                json_extract(value, '$.collected_at'), ?, NULL, ?, ?
         FROM json_each(?)`
      ).bind(now, now, now, json),
      env.DB.prepare(
        `INSERT OR IGNORE INTO agent_report_samples
         (report_id, sample_index, agent_id, collected_at, metrics_json, created_at)
         SELECT json_extract(value, '$.report_id'), 0,
                CAST(json_extract(value, '$.agent_id') AS INTEGER),
                json_extract(value, '$.collected_at'),
                json_extract(value, '$.metrics_json'), ?
         FROM json_each(?)`
      ).bind(now, json),
      env.DB.prepare(
        `INSERT INTO legacy_id_map
         (source_table, source_id, target_table, target_id, payload_checksum,
          created_at, updated_at)
         SELECT json_extract(value, '$.source_table'),
                json_extract(value, '$.source_id'), 'agent_report_samples',
                json_extract(value, '$.report_id'),
                json_extract(value, '$.payload_checksum'), ?, ?
         FROM json_each(?)
         WHERE 1 = 1
         ON CONFLICT(source_table, source_id) DO UPDATE SET
           target_table = excluded.target_table,
           target_id = excluded.target_id,
           payload_checksum = excluded.payload_checksum,
           updated_at = excluded.updated_at`
      ).bind(now, now, json)
    );
    const affectedBuckets = new Map<
      string,
      { agentId: number; bucket: ReturnType<typeof agentMetricBucket> }
    >();
    for (const row of prepared) {
      const bucket = agentMetricBucket(row.collected_at);
      affectedBuckets.set(`${row.agent_id}:${bucket.start}`, {
        agentId: row.agent_id,
        bucket,
      });
    }
    statements.push(
      ...[...affectedBuckets.values()].map(({ agentId, bucket }) =>
        prepareAgentMetricRollupRebuild(env.DB, agentId, bucket, now)
      )
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
         FROM json_each(?)
         WHERE 1 = 1
         ON CONFLICT(migration_key, source_table, source_pk, error_code) DO UPDATE SET
           raw_value_json = excluded.raw_value_json, status = 'open',
           resolution_note = NULL, resolved_at = NULL, updated_at = excluded.updated_at`
      ).bind(migrationKey, now, now, now, JSON.stringify(anomalies))
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE migration_checkpoints SET
         phase = 'backfill', status = ?, last_pk = ?,
         rows_read = rows_read + ?, rows_written = rows_written + ?,
         rows_skipped = rows_skipped + ?, anomaly_rows = anomaly_rows + ?,
         checksum = ?, last_error = NULL,
         lease_token = NULL, lease_expires_at = NULL,
         completed_at = ?, updated_at = ?
       WHERE migration_key = ? AND lease_token = ?`
    ).bind(
      status,
      String(lastProcessedPk),
      sourceRows.length,
      migrated,
      deduplicated,
      anomalies.length,
      cumulativeChecksum,
      remaining ? null : now,
      now,
      migrationKey,
      checkpoint.lease_token
    )
  );
  await env.DB.batch(statements);

  return {
    configured: true,
    sourceTable: selected.table,
    migrated,
    deduplicated,
    anomalies: anomalies.length,
    remaining: remaining || (await chooseSource(env)) !== null,
    checksum: cumulativeChecksum,
  };
}

export async function legacyAgentHistoryCoverage(env: Bindings) {
  const tables = await listLegacyAgentHistorySourceTables(env);
  const results = [];
  for (const table of tables) {
    const source = await env.DB.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).first<{
      count: number;
    }>();
    const mapped = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM legacy_id_map WHERE source_table = ?`
    )
      .bind(table)
      .first<{ count: number }>();
    const anomalies = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM migration_anomalies
       WHERE migration_key = ? AND status IN ('open', 'retry_requested', 'ignored')`
    )
      .bind(`${MIGRATION_PREFIX}${table}`)
      .first<{ count: number }>();
    results.push({
      source_table: table,
      source_rows: Number(source?.count ?? 0),
      mapped_rows: Number(mapped?.count ?? 0),
      anomaly_rows: Number(anomalies?.count ?? 0),
      read_ready: Number(source?.count ?? 0) === Number(mapped?.count ?? 0),
      conserved:
        Number(source?.count ?? 0) ===
        Number(mapped?.count ?? 0) + Number(anomalies?.count ?? 0),
    });
  }
  return results;
}
