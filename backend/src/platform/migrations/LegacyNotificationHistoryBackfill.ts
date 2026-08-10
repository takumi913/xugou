import type { Bindings } from "../../models/db";
import { getEnvNumber } from "../../utils/env";
import {
  canonicalMigrationJson,
  migrationSha256Hex,
} from "./MigrationEncoding";
import { claimMigrationCheckpoint } from "./MigrationLedger";

const SOURCE_TABLE = "notification_history";
const MIGRATION_KEY = "legacy-notification-history-v1";
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

type SourceRow = {
  id: number;
  type: string;
  target_id: number | null;
  channel_id: number;
  template_id: number;
  status: string;
  content: string;
  error: string | null;
  sent_at: string | null;
};

type PreparedRow = {
  source_table: string;
  source_id: string;
  event_id: string;
  message_id: string;
  attempt_id: string;
  type: "monitor" | "agent";
  target_id: number | null;
  channel_id: number;
  template_id: number;
  subject: string;
  content: string;
  variables_json: string;
  message_status: "sent" | "failed";
  success: number;
  error: string | null;
  sent_at: string;
  payload_checksum: string;
  identity: string;
  needs_insert: boolean;
};

function parseContent(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { subject: "", content: value, variables: {} };
    }
    const record = parsed as Record<string, unknown>;
    return {
      subject: typeof record.subject === "string" ? record.subject : "",
      content: typeof record.content === "string" ? record.content : value,
      variables:
        record.variables &&
        typeof record.variables === "object" &&
        !Array.isArray(record.variables)
          ? record.variables
          : {},
    };
  } catch {
    return { subject: "", content: value, variables: {} };
  }
}

function parseLegacyShanghaiTime(variables: unknown) {
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return Number.NaN;
  }
  const value = (variables as Record<string, unknown>).time;
  if (typeof value !== "string") return Number.NaN;
  // Legacy notifications rendered time with zh-CN + Asia/Shanghai while a
  // quoted SQLite default stored the literal CURRENT_TIMESTAMP in sent_at.
  const match = value.trim().match(
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})$/
  );
  if (!match) return Number.NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const wallClock = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second)
  );
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day ||
    wallClock.getUTCHours() !== hour ||
    wallClock.getUTCMinutes() !== minute ||
    wallClock.getUTCSeconds() !== second
  ) {
    return Number.NaN;
  }
  return wallClock.getTime() - SHANGHAI_UTC_OFFSET_MS;
}

function notificationIdentity(value: {
  type: string;
  target_id: number | null;
  channel_id: number;
  template_id: number;
  subject: string;
  content: string;
  success: number;
  error: string | null;
  sent_at: string;
}) {
  return canonicalMigrationJson({
    type: value.type,
    target_id: value.target_id,
    channel_id: value.channel_id,
    template_id: value.template_id,
    subject: value.subject,
    content: value.content,
    success: value.success,
    error: value.error,
    sent_at: value.sent_at,
  });
}

async function prepareSource(row: SourceRow): Promise<PreparedRow> {
  if (!Number.isInteger(row.id) || row.id <= 0) throw new Error("INVALID_SOURCE_ID");
  if (!Number.isInteger(row.channel_id) || row.channel_id <= 0) {
    throw new Error("INVALID_CHANNEL_ID");
  }
  if (!Number.isInteger(row.template_id) || row.template_id <= 0) {
    throw new Error("INVALID_TEMPLATE_ID");
  }
  if (row.type !== "monitor" && row.type !== "agent") {
    throw new Error("INVALID_TYPE");
  }
  if (row.status !== "success" && row.status !== "failed") {
    throw new Error("INVALID_STATUS");
  }
  if (typeof row.content !== "string") throw new Error("INVALID_CONTENT");
  const content = parseContent(row.content);
  const storedTimestamp = Date.parse(String(row.sent_at ?? ""));
  const timestamp = Number.isFinite(storedTimestamp)
    ? storedTimestamp
    : parseLegacyShanghaiTime(content.variables);
  if (!Number.isFinite(timestamp)) throw new Error("INVALID_TIMESTAMP");
  const sentAt = new Date(timestamp).toISOString();
  const base = {
    type: row.type as "monitor" | "agent",
    target_id: row.target_id,
    channel_id: row.channel_id,
    template_id: row.template_id,
    subject: content.subject.slice(0, 1000),
    content: content.content,
    success: row.status === "success" ? 1 : 0,
    error: row.error?.slice(0, 2048) ?? null,
    sent_at: sentAt,
  };
  const payloadChecksum = await migrationSha256Hex(notificationIdentity(base));
  return {
    source_table: SOURCE_TABLE,
    source_id: String(row.id),
    event_id: `legacy-notification-event:${row.id}`,
    message_id: `legacy-notification-message:${row.id}`,
    attempt_id: `legacy-notification-attempt:${row.id}`,
    ...base,
    variables_json: canonicalMigrationJson(content.variables),
    message_status: row.status === "success" ? "sent" : "failed",
    payload_checksum: payloadChecksum,
    identity: notificationIdentity(base),
    needs_insert: true,
  };
}

async function checkpointState(env: Bindings) {
  return env.DB.prepare(
    `SELECT status, last_pk FROM migration_checkpoints
     WHERE migration_key = ? LIMIT 1`
  )
    .bind(MIGRATION_KEY)
    .first<{ status: string; last_pk: string | null }>();
}

async function findExistingMessageId(env: Bindings, row: PreparedRow) {
  const candidates = await env.DB.prepare(
    `SELECT m.message_id, e.type, e.target_id, m.channel_id, m.template_id,
            m.subject, m.content, a.success, a.error, a.completed_at AS sent_at
     FROM notification_attempts a
     JOIN notification_messages m ON m.message_id = a.message_id
     JOIN notification_events e ON e.event_id = m.event_id
     WHERE a.completed_at = ? AND m.channel_id = ? AND m.template_id = ?`
  )
    .bind(row.sent_at, row.channel_id, row.template_id)
    .all<{
      message_id: string;
      type: string;
      target_id: number | null;
      channel_id: number;
      template_id: number;
      subject: string;
      content: string;
      success: number;
      error: string | null;
      sent_at: string;
    }>();
  return candidates.results.find(
    (candidate) => notificationIdentity(candidate) === row.identity
  )?.message_id;
}

async function retryRequestedNotificationAnomaly(env: Bindings) {
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
    `SELECT id, type, target_id, channel_id, template_id, status, content,
            error, sent_at FROM notification_history WHERE id = ? LIMIT 1`
  )
    .bind(sourceId)
    .first<SourceRow>();
  if (!source) return fail("SOURCE_ROW_MISSING");
  const [channel, template] = await Promise.all([
    env.DB.prepare(`SELECT id FROM notification_channels WHERE id = ? LIMIT 1`)
      .bind(source.channel_id)
      .first<{ id: number }>(),
    env.DB.prepare(`SELECT id FROM notification_templates WHERE id = ? LIMIT 1`)
      .bind(source.template_id)
      .first<{ id: number }>(),
  ]);
  if (!channel) return fail("ORPHAN_CHANNEL");
  if (!template) return fail("ORPHAN_TEMPLATE");
  let prepared: PreparedRow;
  try {
    prepared = await prepareSource(source);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const existingMessageId = await findExistingMessageId(env, prepared);
  if (existingMessageId) {
    prepared.message_id = existingMessageId;
    prepared.needs_insert = false;
  }
  const statements: D1PreparedStatement[] = [];
  if (prepared.needs_insert) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO notification_events
         (event_id, source_event_id, type, target_id, event_key, variables_json,
          status, completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'legacy-import', ?, 'completed', ?, ?, ?)`
      ).bind(
        prepared.event_id,
        `legacy-history:${prepared.source_id}`,
        prepared.type,
        prepared.target_id,
        prepared.variables_json,
        prepared.sent_at,
        now,
        now
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO notification_messages
         (message_id, event_id, channel_id, template_id, subject, content,
          cooldown_minutes, status, attempts, max_attempts, available_at,
          last_error, sent_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, 1, ?, ?, ?, ?, ?)`
      ).bind(
        prepared.message_id,
        prepared.event_id,
        prepared.channel_id,
        prepared.template_id,
        prepared.subject,
        prepared.content,
        prepared.message_status,
        prepared.sent_at,
        prepared.error,
        prepared.success ? prepared.sent_at : null,
        now,
        now
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO notification_attempts
         (attempt_id, message_id, attempt_number, started_at, completed_at,
          duration_ms, success, error_category, error, retryable,
          created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, 0, ?, 'legacy-import', ?, 0, ?, ?)`
      ).bind(
        prepared.attempt_id,
        prepared.message_id,
        prepared.sent_at,
        prepared.sent_at,
        prepared.success,
        prepared.error,
        now,
        now
      )
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO legacy_id_map
       (source_table, source_id, target_table, target_id, payload_checksum,
        created_at, updated_at)
       VALUES (?, ?, 'notification_messages', ?, ?, ?, ?)
       ON CONFLICT(source_table, source_id) DO UPDATE SET
         target_table = excluded.target_table, target_id = excluded.target_id,
         payload_checksum = excluded.payload_checksum, updated_at = excluded.updated_at`
    ).bind(
      SOURCE_TABLE,
      prepared.source_id,
      prepared.message_id,
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
    ).bind(now, now, MIGRATION_KEY, checkpoint.lease_token)
  );
  await env.DB.batch(statements);
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM migration_anomalies
     WHERE migration_key = ? AND status = 'retry_requested'`
  )
    .bind(MIGRATION_KEY)
    .first<{ count: number }>();
  return {
    configured: true,
    migrated: existingMessageId ? 0 : 1,
    deduplicated: existingMessageId ? 1 : 0,
    anomalies: 0,
    remaining: Number(pending?.count ?? 0) > 0,
  };
}

export async function backfillLegacyNotificationHistory(
  env: Bindings,
  requestedLimit?: number
) {
  const retried = await retryRequestedNotificationAnomaly(env);
  if (retried) return retried;
  const [maximum, previous] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM notification_history`
    ).first<{ max_id: number }>(),
    checkpointState(env),
  ]);
  const previousLastPk = Number(previous?.last_pk ?? 0);
  if (
    previous &&
    ["completed", "completed_with_anomalies"].includes(previous.status) &&
    Number(maximum?.max_id ?? 0) <=
      (Number.isFinite(previousLastPk) ? previousLastPk : 0)
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
      getEnvNumber(env, "LEGACY_NOTIFICATION_HISTORY_BACKFILL_BATCH_SIZE", 100, {
        min: 1,
        max: 500,
      }),
    500
  );
  const lastPk = Number(checkpoint.last_pk ?? 0);
  const rows = await env.DB.prepare(
    `SELECT id, type, target_id, channel_id, template_id, status, content,
            error, sent_at
     FROM notification_history WHERE id > ? ORDER BY id ASC LIMIT ?`
  )
    .bind(Number.isFinite(lastPk) ? lastPk : 0, limit + 1)
    .all<SourceRow>();
  const sourceRows = rows.results.slice(0, limit);
  const remaining = rows.results.length > limit;

  const channelIds = [...new Set(sourceRows.map((row) => row.channel_id))];
  const templateIds = [...new Set(sourceRows.map((row) => row.template_id))];
  const [channels, templates] = await Promise.all([
    channelIds.length
      ? env.DB.prepare(
          `SELECT id FROM notification_channels
           WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`
        )
          .bind(JSON.stringify(channelIds))
          .all<{ id: number }>()
      : Promise.resolve({ results: [] as Array<{ id: number }> }),
    templateIds.length
      ? env.DB.prepare(
          `SELECT id FROM notification_templates
           WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`
        )
          .bind(JSON.stringify(templateIds))
          .all<{ id: number }>()
      : Promise.resolve({ results: [] as Array<{ id: number }> }),
  ]);
  const channelSet = new Set(channels.results.map((row) => row.id));
  const templateSet = new Set(templates.results.map((row) => row.id));
  const prepared: PreparedRow[] = [];
  const anomalies: Array<{
    source_table: string;
    source_id: string;
    error_code: string;
    raw_value_json: string;
  }> = [];
  for (const row of sourceRows) {
    try {
      if (!channelSet.has(row.channel_id)) throw new Error("ORPHAN_CHANNEL");
      if (!templateSet.has(row.template_id)) throw new Error("ORPHAN_TEMPLATE");
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

  const sentTimes = prepared.map((row) => row.sent_at).sort();
  const candidates = prepared.length
    ? await env.DB.prepare(
        `SELECT m.message_id, e.type, e.target_id, m.channel_id, m.template_id,
                m.subject, m.content, a.success, a.error, a.completed_at AS sent_at
         FROM notification_attempts a
         JOIN notification_messages m ON m.message_id = a.message_id
         JOIN notification_events e ON e.event_id = m.event_id
         WHERE a.completed_at BETWEEN ? AND ?
           AND m.channel_id IN (
             SELECT DISTINCT CAST(json_extract(value, '$.channel_id') AS INTEGER)
             FROM json_each(?)
           )`
      )
        .bind(sentTimes[0], sentTimes.at(-1), JSON.stringify(prepared))
        .all<{
          message_id: string;
          type: string;
          target_id: number | null;
          channel_id: number;
          template_id: number;
          subject: string;
          content: string;
          success: number;
          error: string | null;
          sent_at: string;
        }>()
    : { results: [] as Array<PreparedRow> };
  const existingByIdentity = new Map(
    candidates.results.map((row) => [notificationIdentity(row), row.message_id])
  );
  let migrated = 0;
  let deduplicated = 0;
  for (const row of prepared) {
    const existingMessageId = existingByIdentity.get(row.identity);
    if (existingMessageId) {
      row.message_id = existingMessageId;
      row.needs_insert = false;
      deduplicated += 1;
    } else {
      existingByIdentity.set(row.identity, row.message_id);
      migrated += 1;
    }
  }

  const now = new Date().toISOString();
  const batchChecksum = await migrationSha256Hex(
    canonicalMigrationJson(
      sourceRows.map((row) => ({
        source_id: String(row.id),
        target_id: prepared.find((item) => item.source_id === String(row.id))
          ?.message_id,
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
  const newRows = prepared.filter((row) => row.needs_insert);
  if (newRows.length > 0) {
    const json = JSON.stringify(newRows);
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO notification_events
         (event_id, source_event_id, type, target_id, event_key, variables_json,
          status, completed_at, created_at, updated_at)
         SELECT json_extract(value, '$.event_id'),
                'legacy-history:' || json_extract(value, '$.source_id'),
                json_extract(value, '$.type'),
                CAST(json_extract(value, '$.target_id') AS INTEGER),
                'legacy-import', json_extract(value, '$.variables_json'),
                'completed', json_extract(value, '$.sent_at'), ?, ?
         FROM json_each(?)`
      ).bind(now, now, json),
      env.DB.prepare(
        `INSERT OR IGNORE INTO notification_messages
         (message_id, event_id, channel_id, template_id, subject, content,
          cooldown_minutes, status, attempts, max_attempts, available_at,
          last_error, sent_at, created_at, updated_at)
         SELECT json_extract(value, '$.message_id'),
                json_extract(value, '$.event_id'),
                CAST(json_extract(value, '$.channel_id') AS INTEGER),
                CAST(json_extract(value, '$.template_id') AS INTEGER),
                json_extract(value, '$.subject'), json_extract(value, '$.content'),
                0, json_extract(value, '$.message_status'), 1, 1,
                json_extract(value, '$.sent_at'), json_extract(value, '$.error'),
                CASE WHEN json_extract(value, '$.success') = 1
                     THEN json_extract(value, '$.sent_at') ELSE NULL END,
                ?, ?
         FROM json_each(?)`
      ).bind(now, now, json),
      env.DB.prepare(
        `INSERT OR IGNORE INTO notification_attempts
         (attempt_id, message_id, attempt_number, started_at, completed_at,
          duration_ms, success, error_category, error, retryable,
          created_at, updated_at)
         SELECT json_extract(value, '$.attempt_id'),
                json_extract(value, '$.message_id'), 1,
                json_extract(value, '$.sent_at'), json_extract(value, '$.sent_at'),
                0, CAST(json_extract(value, '$.success') AS INTEGER),
                'legacy-import', json_extract(value, '$.error'), 0, ?, ?
         FROM json_each(?)`
      ).bind(now, now, json)
    );
  }
  if (prepared.length > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO legacy_id_map
         (source_table, source_id, target_table, target_id, payload_checksum,
          created_at, updated_at)
         SELECT json_extract(value, '$.source_table'),
                json_extract(value, '$.source_id'), 'notification_messages',
                json_extract(value, '$.message_id'),
                json_extract(value, '$.payload_checksum'), ?, ?
         FROM json_each(?) WHERE 1 = 1
         ON CONFLICT(source_table, source_id) DO UPDATE SET
           target_table = excluded.target_table, target_id = excluded.target_id,
           payload_checksum = excluded.payload_checksum, updated_at = excluded.updated_at`
      ).bind(now, now, JSON.stringify(prepared))
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
      String(sourceRows.at(-1)?.id ?? lastPk),
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

export async function legacyNotificationHistoryCoverage(env: Bindings) {
  const [source, mapped, anomalies] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM notification_history`).first<{
      count: number;
    }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM legacy_id_map
       WHERE source_table = ? AND target_table = 'notification_messages'`
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
