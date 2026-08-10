import type { Bindings } from "../../models/db";
import { getEnvNumber } from "../../utils/env";
import {
  canonicalMigrationJson,
  migrationSha256Hex,
} from "./MigrationEncoding";
import { claimMigrationCheckpoint } from "./MigrationLedger";

const MIGRATION_KEY = "legacy-notification-templates-v1";

type SourceRow = {
  id: number;
  name: string;
  type: string;
  subject: string;
  content: string;
  is_default: number;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type PreparedRow = {
  source_table: "notification_templates";
  source_id: string;
  target_table: "notification_template_definitions";
  target_id: string;
  payload_checksum: string;
  id: number;
  name: string;
  type: "monitor" | "agent";
  subject: string;
  content: string;
  version: number;
  is_default: number;
  deleted_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
};

type CurrentRow = {
  id: number;
  current_version: number;
  subject: string;
  content: string;
};

function timestamp(value: string | null, code: string) {
  if (value === "CURRENT_TIMESTAMP") return 0;
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
}

function nullableTimestamp(value: string | null, code: string) {
  return value === null ? null : timestamp(value, code);
}

async function prepareSource(row: SourceRow): Promise<PreparedRow> {
  if (!Number.isSafeInteger(row.id) || row.id <= 0) {
    throw new Error("INVALID_TEMPLATE_ID");
  }
  const name = row.name?.trim();
  if (!name) throw new Error("INVALID_TEMPLATE_NAME");
  if (row.type !== "monitor" && row.type !== "agent") {
    throw new Error("INVALID_TEMPLATE_TYPE");
  }
  const templateType: "monitor" | "agent" = row.type;
  if (typeof row.subject !== "string") throw new Error("INVALID_SUBJECT");
  if (typeof row.content !== "string") throw new Error("INVALID_CONTENT");
  if (row.is_default !== 0 && row.is_default !== 1) {
    throw new Error("INVALID_DEFAULT_FLAG");
  }
  const normalized = {
    id: row.id,
    name,
    type: templateType,
    subject: row.subject,
    content: row.content,
    is_default: row.is_default,
    deleted_at_ms: nullableTimestamp(row.deleted_at, "INVALID_DELETED_AT"),
    created_at_ms: timestamp(row.created_at, "INVALID_CREATED_AT"),
    updated_at_ms: timestamp(row.updated_at, "INVALID_UPDATED_AT"),
  };
  return {
    source_table: "notification_templates",
    source_id: String(row.id),
    target_table: "notification_template_definitions",
    target_id: String(row.id),
    payload_checksum: await migrationSha256Hex(
      canonicalMigrationJson(normalized)
    ),
    version: 1,
    ...normalized,
  };
}

async function assignVersions(
  env: Pick<Bindings, "DB">,
  rows: PreparedRow[]
) {
  if (rows.length === 0) return rows;
  const current = await env.DB.prepare(
    `SELECT definition.id, definition.current_version,
            version.subject, version.content
     FROM notification_template_definitions definition
     JOIN notification_template_versions version
       ON version.template_id = definition.id
      AND version.version = definition.current_version
     WHERE definition.id IN (
       SELECT CAST(value AS INTEGER) FROM json_each(?)
     )`
  )
    .bind(JSON.stringify(rows.map((row) => row.id)))
    .all<CurrentRow>();
  const byId = new Map(current.results.map((row) => [row.id, row]));
  return rows.map((row) => {
    const existing = byId.get(row.id);
    if (!existing) return row;
    const version =
      existing.subject === row.subject && existing.content === row.content
        ? existing.current_version
        : existing.current_version + 1;
    return { ...row, version };
  });
}

function persist(env: Pick<Bindings, "DB">, rows: PreparedRow[], now: string) {
  if (rows.length === 0) return [];
  return [
    env.DB.prepare(
      `INSERT INTO notification_template_definitions
       (id, name, type, current_version, is_default, deleted_at_ms,
        created_at_ms, updated_at_ms)
       SELECT CAST(json_extract(value, '$.id') AS INTEGER),
              json_extract(value, '$.name'), json_extract(value, '$.type'),
              CAST(json_extract(value, '$.version') AS INTEGER),
              CAST(json_extract(value, '$.is_default') AS INTEGER),
              CAST(json_extract(value, '$.deleted_at_ms') AS INTEGER),
              CAST(json_extract(value, '$.created_at_ms') AS INTEGER),
              CAST(json_extract(value, '$.updated_at_ms') AS INTEGER)
       FROM json_each(?) WHERE 1 = 1
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, type = excluded.type,
         current_version = CASE
           WHEN excluded.current_version >= notification_template_definitions.current_version
           THEN excluded.current_version
           ELSE notification_template_definitions.current_version END,
         is_default = excluded.is_default,
         deleted_at_ms = excluded.deleted_at_ms,
         updated_at_ms = excluded.updated_at_ms`
    ).bind(JSON.stringify(rows)),
    env.DB.prepare(
      `INSERT INTO notification_template_versions
       (template_id, version, subject, content, created_at_ms)
       SELECT CAST(json_extract(value, '$.id') AS INTEGER),
              CAST(json_extract(value, '$.version') AS INTEGER),
              json_extract(value, '$.subject'), json_extract(value, '$.content'),
              CAST(json_extract(value, '$.updated_at_ms') AS INTEGER)
       FROM json_each(?) WHERE 1 = 1
       ON CONFLICT(template_id, version) DO NOTHING`
    ).bind(JSON.stringify(rows)),
    env.DB.prepare(
      `INSERT INTO legacy_id_map
       (source_table, source_id, target_table, target_id, payload_checksum,
        created_at, updated_at)
       SELECT 'notification_templates', json_extract(value, '$.source_id'),
              'notification_template_definitions',
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
    ).bind(now, JSON.stringify(rows)),
  ];
}

/** 管理写路径在更新旧模板后调用，内容变化会追加不可变版本。 */
export async function syncLegacyNotificationTemplate(
  env: Pick<Bindings, "DB">,
  templateId: number
) {
  const source = await env.DB.prepare(
    `SELECT id, name, type, subject, content, is_default, deleted_at,
            created_at, updated_at
     FROM notification_templates WHERE id = ? LIMIT 1`
  )
    .bind(templateId)
    .first<SourceRow>();
  if (!source) return false;
  const prepared = await assignVersions(env, [await prepareSource(source)]);
  await env.DB.batch(persist(env, prepared, new Date().toISOString()));
  return true;
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
  const source = await env.DB.prepare(
    `SELECT id, name, type, subject, content, is_default, deleted_at,
            created_at, updated_at
     FROM notification_templates WHERE id = ? LIMIT 1`
  )
    .bind(anomaly.source_pk)
    .first<SourceRow>();
  let prepared: PreparedRow[];
  try {
    if (!source) throw new Error("SOURCE_ROW_MISSING");
    prepared = await assignVersions(env, [await prepareSource(source)]);
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
    ...persist(env, prepared, now),
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
  const stale = await env.DB.prepare(
    `SELECT definition.id FROM notification_template_definitions definition
     WHERE NOT EXISTS (SELECT 1 FROM notification_templates source
                       WHERE source.id = definition.id)
     ORDER BY definition.id LIMIT 1`
  ).first<{ id: number }>();
  const source = stale
    ? null
    : await env.DB.prepare(
        `SELECT source.id, source.name, source.type, source.subject,
                source.content, source.is_default, source.deleted_at,
                source.created_at, source.updated_at
         FROM notification_templates source
         LEFT JOIN legacy_id_map map
           ON map.source_table = 'notification_templates'
          AND map.source_id = CAST(source.id AS TEXT)
         LEFT JOIN notification_template_definitions definition
           ON definition.id = source.id
         LEFT JOIN notification_template_versions version
           ON version.template_id = definition.id
          AND version.version = definition.current_version
         WHERE map.source_id IS NULL OR definition.id IS NULL OR version.template_id IS NULL
            OR version.subject <> source.subject OR version.content <> source.content
            OR julianday(source.updated_at) > julianday(map.updated_at)
         ORDER BY source.id LIMIT 1`
      ).first<SourceRow>();
  if (!stale && !source) return null;
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
  if (stale) {
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM notification_template_definitions WHERE id = ?`
      ).bind(stale.id),
      env.DB.prepare(
        `DELETE FROM legacy_id_map
         WHERE source_table = 'notification_templates' AND source_id = ?`
      ).bind(String(stale.id)),
      env.DB.prepare(
        `UPDATE migration_checkpoints SET rows_skipped = rows_skipped + 1,
         lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE migration_key = ? AND lease_token = ?`
      ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
    ]);
    return { configured: true, migrated: 0, reconciled: 1, anomalies: 0, remaining: true };
  }
  try {
    const prepared = await assignVersions(env, [await prepareSource(source!)]);
    await env.DB.batch([
      ...persist(env, prepared, now),
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
         VALUES (?, 'notification_templates', ?, ?, ?, 'open', NULL, ?, NULL, ?, ?)
         ON CONFLICT(migration_key, source_table, source_pk, error_code) DO UPDATE SET
           status = 'open', resolution_note = NULL, resolved_at = NULL,
           updated_at = excluded.updated_at`
      ).bind(
        MIGRATION_KEY,
        String(source!.id),
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

export async function backfillLegacyNotificationTemplates(
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
      getEnvNumber(env, "LEGACY_NOTIFICATION_TEMPLATES_BACKFILL_BATCH_SIZE", 100, {
        min: 1,
        max: 500,
      }),
    500
  );
  const rows = await env.DB.prepare(
    `SELECT id, name, type, subject, content, is_default, deleted_at,
            created_at, updated_at
     FROM notification_templates WHERE id > ? ORDER BY id LIMIT ?`
  )
    .bind(Number(checkpoint.last_pk ?? 0), limit + 1)
    .all<SourceRow>();
  const sourceRows = rows.results.slice(0, limit);
  const remaining = rows.results.length > limit;
  const initialPrepared: PreparedRow[] = [];
  const anomalies: Array<{
    source_id: string;
    error_code: string;
    raw_value_json: string;
  }> = [];
  for (const row of sourceRows) {
    try {
      initialPrepared.push(await prepareSource(row));
    } catch (error) {
      anomalies.push({
        source_id: String(row.id),
        error_code: (error instanceof Error ? error.message : String(error)).slice(0, 128),
        raw_value_json: canonicalMigrationJson(row),
      });
    }
  }
  const prepared = await assignVersions(env, initialPrepared);
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
         SELECT ?, 'notification_templates', json_extract(value, '$.source_id'),
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
      String(sourceRows.at(-1)?.id ?? checkpoint.last_pk ?? 0),
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

export async function legacyNotificationTemplatesCoverage(
  env: Pick<Bindings, "DB">
) {
  const [source, mapped, target, anomalies, staleSource] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM notification_templates`).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM notification_templates source
       JOIN legacy_id_map map
         ON map.source_table = 'notification_templates'
        AND map.source_id = CAST(source.id AS TEXT)
        AND map.target_table = 'notification_template_definitions'
       JOIN notification_template_definitions definition ON definition.id = source.id
       JOIN notification_template_versions version
         ON version.template_id = definition.id
        AND version.version = definition.current_version
       WHERE version.subject = source.subject AND version.content = source.content`
    ).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM notification_template_definitions`
    ).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM migration_anomalies
       WHERE migration_key = ? AND status IN ('open', 'retry_requested', 'ignored')`
    )
      .bind(MIGRATION_KEY)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM notification_templates source
       JOIN legacy_id_map map
         ON map.source_table = 'notification_templates'
        AND map.source_id = CAST(source.id AS TEXT)
       LEFT JOIN notification_template_definitions definition ON definition.id = source.id
       LEFT JOIN notification_template_versions version
         ON version.template_id = definition.id
        AND version.version = definition.current_version
       WHERE definition.id IS NULL OR version.template_id IS NULL
          OR version.subject <> source.subject OR version.content <> source.content
          OR julianday(source.updated_at) > julianday(map.updated_at)`
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
    source_table: "notification_templates",
    source_rows: sourceRows,
    mapped_rows: mappedRows,
    anomaly_rows: anomalyRows,
    target_rows: targetRows,
    stale_rows: staleSourceRows + extraTargetRows,
    read_ready: sourceRows === mappedRows && exactTarget && staleSourceRows === 0,
    conserved:
      sourceRows === mappedRows + anomalyRows && exactTarget && staleSourceRows === 0,
  };
}
