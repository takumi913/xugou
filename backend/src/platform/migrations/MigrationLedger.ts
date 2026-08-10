import type { Bindings } from "../../models/db";

export interface ClaimedMigrationCheckpoint {
  lease_token: string;
  last_pk: string | null;
  checksum: string | null;
  anomaly_rows: number;
}

export async function claimMigrationCheckpoint(
  env: Bindings,
  migrationKey: string,
  phase = "backfill",
  leaseSeconds = 300
) {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(
    now.getTime() + Math.max(30, leaseSeconds) * 1000
  ).toISOString();
  return env.DB.prepare(
    `INSERT INTO migration_checkpoints
     (migration_key, phase, status, last_pk, rows_read, rows_written,
      rows_skipped, anomaly_rows, checksum, last_error, lease_token,
      lease_expires_at, started_at, completed_at, created_at, updated_at)
     VALUES (?, ?, 'running', NULL, 0, 0, 0, 0, NULL, NULL,
             ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(migration_key) DO UPDATE SET
       phase = excluded.phase, status = 'running', last_error = NULL,
       lease_token = excluded.lease_token,
       lease_expires_at = excluded.lease_expires_at,
       started_at = COALESCE(migration_checkpoints.started_at, excluded.started_at),
       completed_at = NULL,
       updated_at = excluded.updated_at
     WHERE migration_checkpoints.lease_token IS NULL
        OR migration_checkpoints.lease_expires_at <= ?
     RETURNING lease_token, last_pk, checksum, anomaly_rows`
  )
    .bind(
      migrationKey,
      phase,
      leaseToken,
      leaseExpiresAt,
      nowIso,
      nowIso,
      nowIso,
      nowIso
    )
    .first<ClaimedMigrationCheckpoint>();
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serialization_error: true });
  }
}

export async function recordMigrationAnomaly(
  env: Bindings,
  input: {
    migrationKey: string;
    sourceTable: string;
    sourcePk: string | number;
    errorCode: string;
    rawValue: unknown;
  }
) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO migration_anomalies
     (migration_key, source_table, source_pk, error_code, raw_value_json,
      status, resolution_note, first_seen_at, resolved_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, NULL, ?, ?)
     ON CONFLICT(migration_key, source_table, source_pk, error_code) DO UPDATE SET
       raw_value_json = excluded.raw_value_json,
       status = 'open', resolution_note = NULL, resolved_at = NULL,
       updated_at = excluded.updated_at`
  )
    .bind(
      input.migrationKey,
      input.sourceTable,
      String(input.sourcePk),
      input.errorCode,
      safeJson(input.rawValue),
      now,
      now,
      now
    )
    .run();
}

export async function recordMigrationBatch(
  env: Bindings,
  input: {
    migrationKey: string;
    phase: string;
    lastPk?: string | number | null;
    rowsRead: number;
    rowsWritten: number;
    rowsSkipped?: number;
    anomalyRows?: number;
    remaining: boolean;
    checksum?: string | null;
    error?: string | null;
  }
) {
  const now = new Date().toISOString();
  const status = input.error
    ? "failed"
    : input.remaining
      ? "running"
      : "completed";
  await env.DB.prepare(
    `INSERT INTO migration_checkpoints
     (migration_key, phase, status, last_pk, rows_read, rows_written,
      rows_skipped, anomaly_rows, checksum, last_error, started_at,
      completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(migration_key) DO UPDATE SET
       phase = excluded.phase,
       status = CASE
         WHEN excluded.status = 'completed'
           AND migration_checkpoints.anomaly_rows + excluded.anomaly_rows > 0
           THEN 'completed_with_anomalies'
         ELSE excluded.status
       END,
       last_pk = COALESCE(excluded.last_pk, migration_checkpoints.last_pk),
       rows_read = migration_checkpoints.rows_read + excluded.rows_read,
       rows_written = migration_checkpoints.rows_written + excluded.rows_written,
       rows_skipped = migration_checkpoints.rows_skipped + excluded.rows_skipped,
       anomaly_rows = migration_checkpoints.anomaly_rows + excluded.anomaly_rows,
       checksum = COALESCE(excluded.checksum, migration_checkpoints.checksum),
       last_error = excluded.last_error,
       completed_at = excluded.completed_at,
       updated_at = excluded.updated_at`
  )
    .bind(
      input.migrationKey,
      input.phase,
      status,
      input.lastPk == null ? null : String(input.lastPk),
      input.rowsRead,
      input.rowsWritten,
      input.rowsSkipped ?? 0,
      input.anomalyRows ?? 0,
      input.checksum ?? null,
      input.error?.slice(0, 2048) ?? null,
      now,
      input.remaining || input.error ? null : now,
      now,
      now
    )
    .run();
}
