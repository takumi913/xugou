import type { Bindings } from "../../models/db";
import { getEnvNumber } from "../../utils/env";
import {
  canonicalMigrationJson,
  migrationSha256Hex,
} from "./MigrationEncoding";
import { claimMigrationCheckpoint } from "./MigrationLedger";

const MIGRATION_KEY = "legacy-status-page-v1";

type SourceRow = {
  source_table: string;
  source_id: string;
  sort_key: string;
  kind: "page" | "monitor" | "agent";
  page_id: number;
  component_id: number | null;
  sort_order: number;
  title: string | null;
  description: string | null;
  logo_url: string | null;
  custom_css: string | null;
  theme: string | null;
  created_at: string | null;
  updated_at: string | null;
  resource_exists: number;
};

type PreparedRow = {
  source_table: string;
  source_id: string;
  target_table: "status_pages" | "status_components";
  target_id: string;
  payload_checksum: string;
  kind: "page" | "monitor" | "agent";
  page_id: number;
  component_id: number | null;
  sort_order: number;
  title: string | null;
  description: string | null;
  logo_url: string | null;
  custom_css: string | null;
  theme: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

const sourceCte = `WITH source AS (
  SELECT 'status_page_config' AS source_table,
         CAST(config.id AS TEXT) AS source_id,
         printf('0:%020d', config.id) AS sort_key,
         'page' AS kind, config.id AS page_id, NULL AS component_id,
         0 AS sort_order, config.title, config.description, config.logo_url,
         config.custom_css, config.theme, config.created_at, config.updated_at,
         1 AS resource_exists
  FROM status_page_config config
  UNION ALL
  SELECT 'status_page_monitors',
         CAST(relation.config_id AS TEXT) || ':' || CAST(relation.monitor_id AS TEXT),
         printf('1:%020d:%020d', relation.config_id, relation.monitor_id),
         'monitor', relation.config_id, relation.monitor_id,
         ROW_NUMBER() OVER (
           PARTITION BY relation.config_id ORDER BY relation.monitor_id
         ) - 1,
         NULL, NULL, NULL, NULL, NULL, config.created_at, config.updated_at,
         CASE WHEN monitor.id IS NULL THEN 0 ELSE 1 END
  FROM status_page_monitors relation
  JOIN status_page_config config ON config.id = relation.config_id
  LEFT JOIN monitors monitor ON monitor.id = relation.monitor_id
  UNION ALL
  SELECT 'status_page_agents',
         CAST(relation.config_id AS TEXT) || ':' || CAST(relation.agent_id AS TEXT),
         printf('2:%020d:%020d', relation.config_id, relation.agent_id),
         'agent', relation.config_id, relation.agent_id,
         ROW_NUMBER() OVER (
           PARTITION BY relation.config_id ORDER BY relation.agent_id
         ) - 1,
         NULL, NULL, NULL, NULL, NULL, config.created_at, config.updated_at,
         CASE WHEN agent.id IS NULL THEN 0 ELSE 1 END
  FROM status_page_agents relation
  JOIN status_page_config config ON config.id = relation.config_id
  LEFT JOIN agents agent ON agent.id = relation.agent_id
)`;

function sourceQuery(predicate: string) {
  return `${sourceCte} SELECT * FROM source ${predicate}`;
}

function timestamp(value: string | null, code: string) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
}

async function prepareSource(row: SourceRow): Promise<PreparedRow> {
  if (!Number.isSafeInteger(row.page_id) || row.page_id <= 0) {
    throw new Error("INVALID_PAGE_ID");
  }
  if (row.resource_exists !== 1) throw new Error("ORPHAN_COMPONENT");
  const createdAtMs = timestamp(row.created_at, "INVALID_CREATED_AT");
  const updatedAtMs = timestamp(row.updated_at, "INVALID_UPDATED_AT");
  if (row.kind === "page" && !row.title?.trim()) throw new Error("INVALID_TITLE");
  if (
    row.kind !== "page" &&
    (!Number.isSafeInteger(row.component_id) || Number(row.component_id) <= 0)
  ) {
    throw new Error("INVALID_COMPONENT_ID");
  }
  const normalized = {
    kind: row.kind,
    page_id: row.page_id,
    component_id: row.component_id,
    sort_order: row.sort_order,
    title: row.title?.trim() ?? null,
    description: row.description,
    logo_url: row.logo_url,
    custom_css: row.custom_css,
    theme: row.theme?.trim() || "mono",
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
  };
  return {
    source_table: row.source_table,
    source_id: row.source_id,
    target_table: row.kind === "page" ? "status_pages" : "status_components",
    target_id:
      row.kind === "page"
        ? String(row.page_id)
        : `${row.page_id}:${row.kind}:${row.component_id}`,
    payload_checksum: await migrationSha256Hex(
      canonicalMigrationJson(normalized)
    ),
    ...normalized,
  };
}

function persist(env: Pick<Bindings, "DB">, rows: PreparedRow[], now: string) {
  if (rows.length === 0) return [];
  const pages = rows.filter((row) => row.kind === "page");
  const components = rows.filter((row) => row.kind !== "page");
  const statements: D1PreparedStatement[] = [];
  if (pages.length > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO status_pages
         (id, singleton_key, title, description, logo_url, custom_css, theme,
          created_at_ms, updated_at_ms)
         SELECT CAST(json_extract(value, '$.page_id') AS INTEGER), 1,
                json_extract(value, '$.title'), json_extract(value, '$.description'),
                json_extract(value, '$.logo_url'), json_extract(value, '$.custom_css'),
                json_extract(value, '$.theme'),
                CAST(json_extract(value, '$.created_at_ms') AS INTEGER),
                CAST(json_extract(value, '$.updated_at_ms') AS INTEGER)
         FROM json_each(?) WHERE 1 = 1
         ON CONFLICT(id) DO UPDATE SET title = excluded.title,
           description = excluded.description, logo_url = excluded.logo_url,
           custom_css = excluded.custom_css, theme = excluded.theme,
           updated_at_ms = excluded.updated_at_ms
         WHERE excluded.updated_at_ms >= status_pages.updated_at_ms`
      ).bind(JSON.stringify(pages))
    );
  }
  if (components.length > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO status_components
         (page_id, component_type, component_id, sort_order,
          created_at_ms, updated_at_ms)
         SELECT CAST(json_extract(value, '$.page_id') AS INTEGER),
                json_extract(value, '$.kind'),
                CAST(json_extract(value, '$.component_id') AS INTEGER),
                CAST(json_extract(value, '$.sort_order') AS INTEGER),
                CAST(json_extract(value, '$.created_at_ms') AS INTEGER),
                CAST(json_extract(value, '$.updated_at_ms') AS INTEGER)
         FROM json_each(?) WHERE 1 = 1
         ON CONFLICT(page_id, component_type, component_id) DO UPDATE SET
           sort_order = excluded.sort_order,
           updated_at_ms = excluded.updated_at_ms`
      ).bind(JSON.stringify(components))
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
              json_extract(value, '$.payload_checksum'), ?, ?
       FROM json_each(?) WHERE 1 = 1
       ON CONFLICT(source_table, source_id) DO UPDATE SET
         target_table = excluded.target_table, target_id = excluded.target_id,
         payload_checksum = excluded.payload_checksum,
         updated_at = excluded.updated_at`
    ).bind(now, now, JSON.stringify(rows))
  );
  return statements;
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
  const stale = await env.DB.prepare(
    `SELECT component.page_id, component.component_type, component.component_id
     FROM status_components component
     WHERE NOT EXISTS (
       SELECT 1 FROM status_page_monitors relation
       WHERE component.component_type = 'monitor'
         AND relation.config_id = component.page_id
         AND relation.monitor_id = component.component_id
     ) AND NOT EXISTS (
       SELECT 1 FROM status_page_agents relation
       WHERE component.component_type = 'agent'
         AND relation.config_id = component.page_id
         AND relation.agent_id = component.component_id
     )
     ORDER BY component.page_id, component.component_type, component.component_id
     LIMIT 1`
  ).first<{ page_id: number; component_type: string; component_id: number }>();
  const source = stale
    ? null
    : await env.DB.prepare(
        sourceQuery(
          `WHERE NOT EXISTS (
             SELECT 1 FROM legacy_id_map map
             WHERE map.source_table = source.source_table
               AND map.source_id = source.source_id
               AND (
                 (source.kind = 'page' AND map.target_table = 'status_pages'
                  AND EXISTS (SELECT 1 FROM status_pages page
                              WHERE page.id = source.page_id))
                 OR
                 (source.kind <> 'page' AND map.target_table = 'status_components'
                  AND EXISTS (SELECT 1 FROM status_components component
                              WHERE component.page_id = source.page_id
                                AND component.component_type = source.kind
                                AND component.component_id = source.component_id))
               )
           ) OR (source.kind = 'page' AND EXISTS (
             SELECT 1 FROM legacy_id_map map
             WHERE map.source_table = source.source_table
               AND map.source_id = source.source_id
               AND julianday(source.updated_at) > julianday(map.updated_at)
           ))
           ORDER BY source.sort_key LIMIT 1`
        )
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
    const sourceTable =
      stale.component_type === "monitor"
        ? "status_page_monitors"
        : "status_page_agents";
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM status_components
         WHERE page_id = ? AND component_type = ? AND component_id = ?`
      ).bind(stale.page_id, stale.component_type, stale.component_id),
      env.DB.prepare(
        `DELETE FROM legacy_id_map WHERE source_table = ? AND source_id = ?`
      ).bind(sourceTable, `${stale.page_id}:${stale.component_id}`),
      env.DB.prepare(
        `UPDATE migration_checkpoints SET rows_skipped = rows_skipped + 1,
         lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE migration_key = ? AND lease_token = ?`
      ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
    ]);
    return {
      configured: true,
      migrated: 0,
      reconciled: 1,
      anomalies: 0,
      remaining: true,
    };
  }
  let prepared: PreparedRow;
  try {
    prepared = await prepareSource(source!);
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
    return {
      configured: true,
      migrated: 0,
      reconciled: 0,
      anomalies: 1,
      remaining: false,
    };
  }
  await env.DB.batch([
    ...persist(env, [prepared], now),
    env.DB.prepare(
      `UPDATE migration_checkpoints SET rows_skipped = rows_skipped + 1,
       lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
       WHERE migration_key = ? AND lease_token = ?`
    ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token),
  ]);
  return {
    configured: true,
    migrated: 0,
    reconciled: 1,
    anomalies: 0,
    remaining: true,
  };
}

export async function backfillLegacyStatusPage(
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
      getEnvNumber(env, "LEGACY_STATUS_PAGE_BACKFILL_BATCH_SIZE", 100, {
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
        source_table: row.source_table,
        source_id: row.source_id,
        target_id: prepared.find(
          (item) =>
            item.source_table === row.source_table && item.source_id === row.source_id
        )?.target_id,
        anomaly: anomalies.find(
          (item) =>
            item.source_table === row.source_table && item.source_id === row.source_id
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

export async function legacyStatusPageCoverage(env: Pick<Bindings, "DB">) {
  const [source, mapped, target, anomalies] = await Promise.all([
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM status_page_config) +
         (SELECT COUNT(*) FROM status_page_monitors) +
         (SELECT COUNT(*) FROM status_page_agents) AS count`
    ).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM legacy_id_map map
          JOIN status_page_config source
            ON map.source_id = CAST(source.id AS TEXT)
          JOIN status_pages target ON target.id = source.id
          WHERE map.source_table = 'status_page_config'
            AND map.target_table = 'status_pages') +
         (SELECT COUNT(*) FROM legacy_id_map map
          JOIN status_page_monitors source
            ON map.source_id = CAST(source.config_id AS TEXT) || ':' ||
                               CAST(source.monitor_id AS TEXT)
          JOIN status_components target
            ON target.page_id = source.config_id
           AND target.component_type = 'monitor'
           AND target.component_id = source.monitor_id
          WHERE map.source_table = 'status_page_monitors'
            AND map.target_table = 'status_components') +
         (SELECT COUNT(*) FROM legacy_id_map map
          JOIN status_page_agents source
            ON map.source_id = CAST(source.config_id AS TEXT) || ':' ||
                               CAST(source.agent_id AS TEXT)
          JOIN status_components target
            ON target.page_id = source.config_id
           AND target.component_type = 'agent'
           AND target.component_id = source.agent_id
          WHERE map.source_table = 'status_page_agents'
            AND map.target_table = 'status_components') AS count`
    ).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM status_pages) +
              (SELECT COUNT(*) FROM status_components) AS count`
    ).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM migration_anomalies
       WHERE migration_key = ? AND status IN ('open', 'retry_requested', 'ignored')`
    )
      .bind(MIGRATION_KEY)
      .first<{ count: number }>(),
  ]);
  const sourceRows = Number(source?.count ?? 0);
  const mappedRows = Number(mapped?.count ?? 0);
  const targetRows = Number(target?.count ?? 0);
  const anomalyRows = Number(anomalies?.count ?? 0);
  const exactTarget = targetRows === mappedRows;
  return {
    source_table: "status_page_config+relations",
    source_rows: sourceRows,
    mapped_rows: mappedRows,
    anomaly_rows: anomalyRows,
    target_rows: targetRows,
    stale_rows: Math.max(0, targetRows - mappedRows),
    read_ready: sourceRows === mappedRows && exactTarget,
    conserved: sourceRows === mappedRows + anomalyRows && exactTarget,
  };
}
