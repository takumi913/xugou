import type { Bindings } from "../../models/db";
import { getEnvNumber } from "../../utils/env";
import {
  canonicalMigrationJson,
  migrationSha256Hex,
} from "./MigrationEncoding";
import { claimMigrationCheckpoint } from "./MigrationLedger";

const MIGRATION_KEY = "legacy-notification-rules-v1";

type SourceRow = {
  source_table: string;
  source_id: string;
  sort_key: string;
  kind: "rule" | "endpoint";
  rule_id: number;
  channel_id: number | null;
  sort_order: number;
  channel_value_type: string | null;
  duplicate_rank: number;
  channel_exists: number;
  target_type: string;
  target_id: number | null;
  target_exists: number;
  enabled: number;
  on_down: number;
  on_recovery: number;
  on_offline: number;
  on_cpu_threshold: number;
  cpu_threshold: number;
  on_memory_threshold: number;
  memory_threshold: number;
  on_disk_threshold: number;
  disk_threshold: number;
  cooldown_minutes: number;
  channels_json: string | null;
  channels_are_array: number;
  created_at: string | null;
  updated_at: string | null;
};

type PreparedRow = {
  source_table: string;
  source_id: string;
  target_table: "notification_rules" | "notification_rule_endpoints";
  target_id: string;
  payload_checksum: string;
  kind: "rule" | "endpoint";
  rule_id: number;
  channel_id: number | null;
  sort_order: number;
  target_type: string;
  source_target_id: number | null;
  enabled: number;
  on_down: number;
  on_recovery: number;
  on_offline: number;
  on_cpu_threshold: number;
  cpu_threshold: number;
  on_memory_threshold: number;
  memory_threshold: number;
  on_disk_threshold: number;
  disk_threshold: number;
  cooldown_minutes: number;
  created_at_ms: number;
  updated_at_ms: number;
};

const sourceCte = `WITH normalized_settings AS (
  SELECT setting.*,
         CASE WHEN json_valid(COALESCE(setting.channels, '[]')) = 1
              THEN CASE
                WHEN json_type(COALESCE(setting.channels, '[]')) = 'array'
                THEN COALESCE(setting.channels, '[]') ELSE '[]' END
              ELSE '[]' END AS normalized_channels,
         CASE WHEN json_valid(COALESCE(setting.channels, '[]')) = 1
              THEN CASE
                WHEN json_type(COALESCE(setting.channels, '[]')) = 'array'
                THEN 1 ELSE 0 END
              ELSE 0 END AS channels_are_array,
         CASE
           WHEN setting.target_type IN ('global-monitor', 'global-agent')
                AND setting.target_id IS NULL THEN 1
           WHEN setting.target_type = 'monitor' AND setting.target_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM monitors monitor
                            WHERE monitor.id = setting.target_id
                              AND monitor.deleted_at IS NULL) THEN 1
           WHEN setting.target_type = 'agent' AND setting.target_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM agents agent
                            WHERE agent.id = setting.target_id
                              AND agent.deleted_at IS NULL) THEN 1
           ELSE 0
         END AS target_exists
  FROM notification_settings setting
), endpoint_source AS (
  SELECT setting.*,
         CAST(entry.key AS INTEGER) AS channel_index,
         entry.type AS channel_value_type,
         CAST(entry.value AS INTEGER) AS channel_id,
         ROW_NUMBER() OVER (
           PARTITION BY setting.id, entry.type, CAST(entry.value AS TEXT)
           ORDER BY CAST(entry.key AS INTEGER)
         ) AS duplicate_rank,
         CASE WHEN entry.type = 'integer' AND CAST(entry.value AS INTEGER) > 0
                   AND EXISTS (
                     SELECT 1 FROM notification_channels channel
                     WHERE channel.id = CAST(entry.value AS INTEGER)
                       AND channel.deleted_at IS NULL
                   )
              THEN 1 ELSE 0 END AS channel_exists
  FROM normalized_settings setting
  JOIN json_each(setting.normalized_channels) entry
), source AS (
  SELECT 'notification_settings' AS source_table,
         CAST(setting.id AS TEXT) AS source_id,
         printf('%020d:0', setting.id) AS sort_key,
         'rule' AS kind, setting.id AS rule_id, NULL AS channel_id,
         0 AS sort_order, NULL AS channel_value_type, 1 AS duplicate_rank,
         1 AS channel_exists, setting.target_type, setting.target_id,
         setting.target_exists, setting.enabled, setting.on_down,
         setting.on_recovery, setting.on_offline, setting.on_cpu_threshold,
         setting.cpu_threshold, setting.on_memory_threshold,
         setting.memory_threshold, setting.on_disk_threshold,
         setting.disk_threshold, setting.cooldown_minutes,
         setting.channels AS channels_json, setting.channels_are_array,
         setting.created_at, setting.updated_at
  FROM normalized_settings setting
  UNION ALL
  SELECT 'notification_settings_channels',
         CAST(setting.id AS TEXT) || ':' || CAST(setting.channel_index AS TEXT),
         printf('%020d:1:%020d', setting.id, setting.channel_index),
         'endpoint', setting.id, setting.channel_id, setting.channel_index,
         setting.channel_value_type, setting.duplicate_rank,
         setting.channel_exists, setting.target_type, setting.target_id,
         setting.target_exists, setting.enabled, setting.on_down,
         setting.on_recovery, setting.on_offline, setting.on_cpu_threshold,
         setting.cpu_threshold, setting.on_memory_threshold,
         setting.memory_threshold, setting.on_disk_threshold,
         setting.disk_threshold, setting.cooldown_minutes,
         setting.channels AS channels_json, setting.channels_are_array,
         setting.created_at, setting.updated_at
  FROM endpoint_source setting
)`;

function sourceQuery(predicate: string) {
  return `${sourceCte} SELECT * FROM source ${predicate}`;
}

function timestamp(value: string | null, code: string) {
  // 0000 migration曾把 SQL 函数误写为字符串默认值；按确定性 epoch 兼容该批旧行。
  if (value === "CURRENT_TIMESTAMP") return 0;
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
}

function binary(value: number, code: string) {
  if (value !== 0 && value !== 1) throw new Error(code);
  return value;
}

function integerRange(value: number, min: number, max: number, code: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(code);
  }
  return value;
}

async function prepareSource(row: SourceRow): Promise<PreparedRow> {
  if (!Number.isSafeInteger(row.rule_id) || row.rule_id <= 0) {
    throw new Error("INVALID_RULE_ID");
  }
  if (row.target_exists !== 1) throw new Error("INVALID_NOTIFICATION_TARGET");
  if (row.channels_are_array !== 1) throw new Error("INVALID_CHANNELS_JSON");
  if (
    !["global-monitor", "global-agent", "monitor", "agent"].includes(
      row.target_type
    )
  ) {
    throw new Error("INVALID_TARGET_TYPE");
  }
  const createdAtMs = timestamp(row.created_at, "INVALID_CREATED_AT");
  const updatedAtMs = timestamp(row.updated_at, "INVALID_UPDATED_AT");
  const normalizedRule = {
    rule_id: row.rule_id,
    target_type: row.target_type,
    target_id: row.target_id,
    enabled: binary(row.enabled, "INVALID_ENABLED"),
    on_down: binary(row.on_down, "INVALID_ON_DOWN"),
    on_recovery: binary(row.on_recovery, "INVALID_ON_RECOVERY"),
    on_offline: binary(row.on_offline, "INVALID_ON_OFFLINE"),
    on_cpu_threshold: binary(
      row.on_cpu_threshold,
      "INVALID_ON_CPU_THRESHOLD"
    ),
    cpu_threshold: integerRange(
      row.cpu_threshold,
      0,
      100,
      "INVALID_CPU_THRESHOLD"
    ),
    on_memory_threshold: binary(
      row.on_memory_threshold,
      "INVALID_ON_MEMORY_THRESHOLD"
    ),
    memory_threshold: integerRange(
      row.memory_threshold,
      0,
      100,
      "INVALID_MEMORY_THRESHOLD"
    ),
    on_disk_threshold: binary(
      row.on_disk_threshold,
      "INVALID_ON_DISK_THRESHOLD"
    ),
    disk_threshold: integerRange(
      row.disk_threshold,
      0,
      100,
      "INVALID_DISK_THRESHOLD"
    ),
    cooldown_minutes: integerRange(
      row.cooldown_minutes,
      0,
      1440,
      "INVALID_COOLDOWN"
    ),
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
  };
  if (row.kind === "endpoint") {
    if (
      row.channel_value_type !== "integer" ||
      !Number.isSafeInteger(row.channel_id) ||
      Number(row.channel_id) <= 0
    ) {
      throw new Error("INVALID_CHANNEL_ID");
    }
    if (row.duplicate_rank !== 1) throw new Error("DUPLICATE_CHANNEL_ID");
    if (row.channel_exists !== 1) throw new Error("MISSING_CHANNEL");
  }
  const normalized =
    row.kind === "rule"
      ? normalizedRule
      : {
          rule_id: row.rule_id,
          channel_id: row.channel_id,
          sort_order: row.sort_order,
          created_at_ms: createdAtMs,
          updated_at_ms: updatedAtMs,
        };
  return {
    source_table: row.source_table,
    source_id: row.source_id,
    target_table:
      row.kind === "rule"
        ? "notification_rules"
        : "notification_rule_endpoints",
    target_id:
      row.kind === "rule"
        ? String(row.rule_id)
        : `${row.rule_id}:${row.channel_id}`,
    payload_checksum: await migrationSha256Hex(
      canonicalMigrationJson(normalized)
    ),
    kind: row.kind,
    rule_id: row.rule_id,
    channel_id: row.channel_id,
    sort_order: row.sort_order,
    target_type: normalizedRule.target_type,
    source_target_id: normalizedRule.target_id,
    enabled: normalizedRule.enabled,
    on_down: normalizedRule.on_down,
    on_recovery: normalizedRule.on_recovery,
    on_offline: normalizedRule.on_offline,
    on_cpu_threshold: normalizedRule.on_cpu_threshold,
    cpu_threshold: normalizedRule.cpu_threshold,
    on_memory_threshold: normalizedRule.on_memory_threshold,
    memory_threshold: normalizedRule.memory_threshold,
    on_disk_threshold: normalizedRule.on_disk_threshold,
    disk_threshold: normalizedRule.disk_threshold,
    cooldown_minutes: normalizedRule.cooldown_minutes,
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
  };
}

function persist(env: Pick<Bindings, "DB">, rows: PreparedRow[], now: string) {
  if (rows.length === 0) return [];
  const rules = rows.filter((row) => row.kind === "rule");
  const endpoints = rows.filter((row) => row.kind === "endpoint");
  const statements: D1PreparedStatement[] = [];
  if (rules.length > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO notification_rules
         (id, target_type, target_id, enabled, on_down, on_recovery, on_offline,
          on_cpu_threshold, cpu_threshold, on_memory_threshold, memory_threshold,
          on_disk_threshold, disk_threshold, cooldown_minutes,
          created_at_ms, updated_at_ms)
         SELECT CAST(json_extract(value, '$.rule_id') AS INTEGER),
                json_extract(value, '$.target_type'),
                CAST(json_extract(value, '$.source_target_id') AS INTEGER),
                CAST(json_extract(value, '$.enabled') AS INTEGER),
                CAST(json_extract(value, '$.on_down') AS INTEGER),
                CAST(json_extract(value, '$.on_recovery') AS INTEGER),
                CAST(json_extract(value, '$.on_offline') AS INTEGER),
                CAST(json_extract(value, '$.on_cpu_threshold') AS INTEGER),
                CAST(json_extract(value, '$.cpu_threshold') AS INTEGER),
                CAST(json_extract(value, '$.on_memory_threshold') AS INTEGER),
                CAST(json_extract(value, '$.memory_threshold') AS INTEGER),
                CAST(json_extract(value, '$.on_disk_threshold') AS INTEGER),
                CAST(json_extract(value, '$.disk_threshold') AS INTEGER),
                CAST(json_extract(value, '$.cooldown_minutes') AS INTEGER),
                CAST(json_extract(value, '$.created_at_ms') AS INTEGER),
                CAST(json_extract(value, '$.updated_at_ms') AS INTEGER)
         FROM json_each(?) WHERE 1 = 1
         ON CONFLICT(id) DO UPDATE SET
           target_type = excluded.target_type, target_id = excluded.target_id,
           enabled = excluded.enabled, on_down = excluded.on_down,
           on_recovery = excluded.on_recovery, on_offline = excluded.on_offline,
           on_cpu_threshold = excluded.on_cpu_threshold,
           cpu_threshold = excluded.cpu_threshold,
           on_memory_threshold = excluded.on_memory_threshold,
           memory_threshold = excluded.memory_threshold,
           on_disk_threshold = excluded.on_disk_threshold,
           disk_threshold = excluded.disk_threshold,
           cooldown_minutes = excluded.cooldown_minutes,
           updated_at_ms = excluded.updated_at_ms
         WHERE excluded.updated_at_ms >= notification_rules.updated_at_ms`
      ).bind(JSON.stringify(rules))
    );
  }
  if (endpoints.length > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO notification_rule_endpoints
         (rule_id, channel_id, sort_order, created_at_ms, updated_at_ms)
         SELECT CAST(json_extract(value, '$.rule_id') AS INTEGER),
                CAST(json_extract(value, '$.channel_id') AS INTEGER),
                CAST(json_extract(value, '$.sort_order') AS INTEGER),
                CAST(json_extract(value, '$.created_at_ms') AS INTEGER),
                CAST(json_extract(value, '$.updated_at_ms') AS INTEGER)
         FROM json_each(?) WHERE 1 = 1
         ON CONFLICT(rule_id, channel_id) DO UPDATE SET
           sort_order = excluded.sort_order,
           updated_at_ms = excluded.updated_at_ms`
      ).bind(JSON.stringify(endpoints))
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO legacy_id_map
       (source_table, source_id, target_table, target_id, payload_checksum,
        created_at, updated_at)
       SELECT json_extract(value, '$.source_table'),
              json_extract(value, '$.source_id'),
              json_extract(value, '$.target_table'),
              json_extract(value, '$.target_id'),
              json_extract(value, '$.payload_checksum'), ?,
              strftime('%Y-%m-%dT%H:%M:%fZ',
                       CAST(json_extract(value, '$.updated_at_ms') AS INTEGER) /
                         1000.0, 'unixepoch')
       FROM json_each(?) WHERE 1 = 1
       ON CONFLICT(source_table, source_id) DO UPDATE SET
         target_table = excluded.target_table, target_id = excluded.target_id,
         payload_checksum = excluded.payload_checksum,
         updated_at = excluded.updated_at`
    ).bind(now, JSON.stringify(rows))
  );
  return statements;
}

/** 同步一条旧设置及其 JSON 渠道关系，供管理写路径执行兼容双写。 */
export async function syncLegacyNotificationRule(
  env: Pick<Bindings, "DB">,
  ruleId: number
) {
  const rows = await env.DB.prepare(
    sourceQuery("WHERE rule_id = ? ORDER BY sort_key")
  )
    .bind(ruleId)
    .all<SourceRow>();
  if (rows.results.length === 0) return false;
  const prepared = await Promise.all(rows.results.map(prepareSource));
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM notification_rule_endpoints WHERE rule_id = ?`
    ).bind(ruleId),
    env.DB.prepare(
      `DELETE FROM legacy_id_map
       WHERE source_table = 'notification_settings_channels'
         AND target_id LIKE ?`
    ).bind(`${ruleId}:%`),
    ...persist(env, prepared, now),
  ]);
  return true;
}

async function retryRequested(env: Bindings) {
  const anomaly = await env.DB.prepare(
    `SELECT id, source_table, source_pk FROM migration_anomalies
     WHERE migration_key = ? AND status = 'retry_requested'
     ORDER BY id ASC LIMIT 1`
  )
    .bind(MIGRATION_KEY)
    .first<{ id: number; source_table: string; source_pk: string }>();
  if (!anomaly) return null;
  const checkpoint = await claimMigrationCheckpoint(env, MIGRATION_KEY);
  if (!checkpoint) {
    return { configured: true, migrated: 0, anomalies: 0, remaining: true, busy: true };
  }
  const now = new Date().toISOString();
  const source = await env.DB.prepare(
    sourceQuery("WHERE source_table = ? AND source_id = ? LIMIT 1")
  )
    .bind(anomaly.source_table, anomaly.source_pk)
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
       SET rows_written = rows_written + 1, lease_token = NULL,
           lease_expires_at = NULL, completed_at = ?, updated_at = ?
       WHERE migration_key = ? AND lease_token = ?`
    ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
  ]);
  return { configured: true, migrated: 1, anomalies: 0, remaining: false };
}

async function reconcile(env: Bindings) {
  const staleRule = await env.DB.prepare(
    `SELECT rule.id FROM notification_rules rule
     WHERE NOT EXISTS (SELECT 1 FROM notification_settings source
                       WHERE source.id = rule.id)
     ORDER BY rule.id LIMIT 1`
  ).first<{ id: number }>();
  const staleEndpoint = staleRule
    ? null
    : await env.DB.prepare(
        `${sourceCte}
         SELECT endpoint.rule_id, endpoint.channel_id
         FROM notification_rule_endpoints endpoint
         WHERE NOT EXISTS (
           SELECT 1 FROM source
           WHERE source.kind = 'endpoint'
             AND source.rule_id = endpoint.rule_id
             AND source.channel_id = endpoint.channel_id
             AND source.channel_value_type = 'integer'
             AND source.duplicate_rank = 1
             AND source.channel_exists = 1
         )
         ORDER BY endpoint.rule_id, endpoint.channel_id LIMIT 1`
      ).first<{ rule_id: number; channel_id: number }>();
  const source = staleRule || staleEndpoint
    ? null
    : await env.DB.prepare(
        sourceQuery(
          `WHERE NOT EXISTS (
             SELECT 1 FROM legacy_id_map map
             WHERE map.source_table = source.source_table
               AND map.source_id = source.source_id
               AND (
                 (source.kind = 'rule' AND map.target_table = 'notification_rules'
                   AND EXISTS (SELECT 1 FROM notification_rules target
                               WHERE target.id = source.rule_id))
                 OR
                 (source.kind = 'endpoint'
                   AND map.target_table = 'notification_rule_endpoints'
                   AND EXISTS (
                     SELECT 1 FROM notification_rule_endpoints target
                     WHERE target.rule_id = source.rule_id
                       AND target.channel_id = source.channel_id
                   ))
               )
           ) OR EXISTS (
             SELECT 1 FROM legacy_id_map map
             WHERE map.source_table = source.source_table
               AND map.source_id = source.source_id
               AND julianday(source.updated_at) > julianday(map.updated_at)
           )
           ORDER BY source.sort_key LIMIT 1`
        )
      ).first<SourceRow>();
  if (!staleRule && !staleEndpoint && !source) return null;
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
  if (staleRule) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM notification_rules WHERE id = ?`).bind(staleRule.id),
      env.DB.prepare(
        `DELETE FROM legacy_id_map
         WHERE (source_table = 'notification_settings' AND source_id = ?)
            OR (source_table = 'notification_settings_channels' AND target_id LIKE ?)`
      ).bind(String(staleRule.id), `${staleRule.id}:%`),
      env.DB.prepare(
        `UPDATE migration_checkpoints SET rows_skipped = rows_skipped + 1,
         lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE migration_key = ? AND lease_token = ?`
      ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
    ]);
    return { configured: true, migrated: 0, reconciled: 1, anomalies: 0, remaining: true };
  }
  if (staleEndpoint) {
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM notification_rule_endpoints
         WHERE rule_id = ? AND channel_id = ?`
      ).bind(staleEndpoint.rule_id, staleEndpoint.channel_id),
      env.DB.prepare(
        `DELETE FROM legacy_id_map
         WHERE target_table = 'notification_rule_endpoints' AND target_id = ?`
      ).bind(`${staleEndpoint.rule_id}:${staleEndpoint.channel_id}`),
      env.DB.prepare(
        `UPDATE migration_checkpoints SET rows_skipped = rows_skipped + 1,
         lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE migration_key = ? AND lease_token = ?`
      ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
    ]);
    return { configured: true, migrated: 0, reconciled: 1, anomalies: 0, remaining: true };
  }
  try {
    const prepared = await prepareSource(source!);
    await env.DB.batch([
      ...persist(env, [prepared], now),
      env.DB.prepare(
        `UPDATE migration_checkpoints SET rows_skipped = rows_skipped + 1,
         lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE migration_key = ? AND lease_token = ?`
      ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
    ]);
    return { configured: true, migrated: 0, reconciled: 1, anomalies: 0, remaining: true };
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
        source!.source_table,
        source!.source_id,
        errorCode,
        canonicalMigrationJson(source),
        now,
        now,
        now
      ),
      env.DB.prepare(
        `UPDATE migration_checkpoints SET status = 'completed_with_anomalies',
         anomaly_rows = anomaly_rows + 1, lease_token = NULL,
         lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE migration_key = ? AND lease_token = ?`
      ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
    ]);
    return { configured: true, migrated: 0, reconciled: 0, anomalies: 1, remaining: false };
  }
}

export async function backfillLegacyNotificationRules(
  env: Bindings,
  requestedLimit?: number
) {
  const retried = await retryRequested(env);
  if (retried) return retried;
  const current = await env.DB.prepare(
    `SELECT status FROM migration_checkpoints WHERE migration_key = ? LIMIT 1`
  )
    .bind(MIGRATION_KEY)
    .first<{ status: string }>();
  if (current && ["completed", "completed_with_anomalies"].includes(current.status)) {
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
      getEnvNumber(env, "LEGACY_NOTIFICATION_RULES_BACKFILL_BATCH_SIZE", 100, {
        min: 1,
        max: 500,
      }),
    500
  );
  const rows = await env.DB.prepare(
    sourceQuery("WHERE sort_key > ? ORDER BY sort_key LIMIT ?")
  )
    .bind(checkpoint.last_pk ?? "", limit + 1)
    .all<SourceRow>();
  const sourceRows = rows.results.slice(0, limit);
  const remaining = rows.results.length > limit;
  const prepared: PreparedRow[] = [];
  const anomalies: Array<{
    source_table: string;
    source_id: string;
    error_code: string;
    raw_value_json: string;
  }> = [];
  for (const row of sourceRows) {
    try {
      prepared.push(await prepareSource(row));
    } catch (error) {
      anomalies.push({
        source_table: row.source_table,
        source_id: row.source_id,
        error_code: (error instanceof Error ? error.message : String(error)).slice(0, 128),
        raw_value_json: canonicalMigrationJson(row),
      });
    }
  }
  const now = new Date().toISOString();
  const batchChecksum = await migrationSha256Hex(
    canonicalMigrationJson(
      sourceRows.map((row) => ({
        source_table: row.source_table,
        source_id: row.source_id,
        target_id: prepared.find(
          (item) => item.source_table === row.source_table && item.source_id === row.source_id
        )?.target_id,
        anomaly: anomalies.find(
          (item) => item.source_table === row.source_table && item.source_id === row.source_id
        )?.error_code,
      }))
    )
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
         SELECT ?, json_extract(value, '$.source_table'),
                json_extract(value, '$.source_id'),
                json_extract(value, '$.error_code'),
                json_extract(value, '$.raw_value_json'), 'open', NULL, ?, NULL, ?, ?
         FROM json_each(?) WHERE 1 = 1
         ON CONFLICT(migration_key, source_table, source_pk, error_code) DO UPDATE SET
           raw_value_json = excluded.raw_value_json, status = 'open',
           resolution_note = NULL, resolved_at = NULL,
           updated_at = excluded.updated_at`
      ).bind(MIGRATION_KEY, now, now, now, JSON.stringify(anomalies))
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
      sourceRows.at(-1)?.sort_key ?? checkpoint.last_pk ?? "",
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

export async function legacyNotificationRulesCoverage(
  env: Pick<Bindings, "DB">
) {
  const [source, mapped, target, anomalies, staleSource] = await Promise.all([
    env.DB.prepare(`${sourceCte} SELECT COUNT(*) AS count FROM source`).first<{ count: number }>(),
    env.DB.prepare(
      `${sourceCte}
       SELECT COUNT(*) AS count FROM source
       JOIN legacy_id_map map
         ON map.source_table = source.source_table AND map.source_id = source.source_id
       WHERE (source.kind = 'rule' AND map.target_table = 'notification_rules'
              AND EXISTS (SELECT 1 FROM notification_rules target
                          WHERE target.id = source.rule_id))
          OR (source.kind = 'endpoint'
              AND map.target_table = 'notification_rule_endpoints'
              AND EXISTS (SELECT 1 FROM notification_rule_endpoints target
                          WHERE target.rule_id = source.rule_id
                            AND target.channel_id = source.channel_id))`
    ).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM notification_rules) +
              (SELECT COUNT(*) FROM notification_rule_endpoints) AS count`
    ).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM migration_anomalies
       WHERE migration_key = ? AND status IN ('open', 'retry_requested', 'ignored')`
    )
      .bind(MIGRATION_KEY)
      .first<{ count: number }>(),
    env.DB.prepare(
      `${sourceCte}
       SELECT COUNT(*) AS count FROM source
       JOIN legacy_id_map map
         ON map.source_table = source.source_table AND map.source_id = source.source_id
       WHERE julianday(source.updated_at) > julianday(map.updated_at)`
    ).first<{ count: number }>(),
  ]);
  const sourceRows = Number(source?.count ?? 0);
  const mappedRows = Number(mapped?.count ?? 0);
  const targetRows = Number(target?.count ?? 0);
  const anomalyRows = Number(anomalies?.count ?? 0);
  const staleSourceRows = Number(staleSource?.count ?? 0);
  const extraTargetRows = Math.max(0, targetRows - mappedRows);
  const exactTarget = targetRows === mappedRows;
  return {
    source_table: "notification_settings+channels",
    source_rows: sourceRows,
    mapped_rows: mappedRows,
    anomaly_rows: anomalyRows,
    target_rows: targetRows,
    stale_rows: staleSourceRows + extraTargetRows,
    read_ready:
      sourceRows === mappedRows && exactTarget && staleSourceRows === 0,
    conserved:
      sourceRows === mappedRows + anomalyRows &&
      exactTarget &&
      staleSourceRows === 0,
  };
}
