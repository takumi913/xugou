import type { Bindings } from "../../../models/db";
import { getEnvNumber } from "../../../utils/env";
import {
  getNotificationKekVersion,
  rewrapNotificationSecretPayload,
} from "../security/notification-secret-crypto";
import { D1NotificationChannelStore, type ChannelRow } from "./D1NotificationChannelStore";

export async function backfillNotificationSecrets(env: Bindings, limit = 10) {
  if (!env.NOTIFICATION_KEK) {
    return { migrated: 0, remaining: true, configured: false };
  }
  const migrationKey = "notification-secret-v1";
  const result = await env.DB.prepare(
    `SELECT c.id, c.name, c.type, c.config, c.enabled, c.deleted_at,
            c.created_at, c.updated_at
     FROM notification_channels c
     LEFT JOIN notification_endpoints e ON e.channel_id = c.id
     WHERE c.deleted_at IS NULL AND e.channel_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM migration_anomalies ma
         WHERE ma.migration_key = ? AND ma.source_table = 'notification_channels'
           AND ma.source_pk = CAST(c.id AS TEXT) AND ma.status IN ('open', 'ignored')
       )
     ORDER BY c.id ASC LIMIT ?`
  )
    .bind(migrationKey, limit)
    .all<ChannelRow>();
  const store = new D1NotificationChannelStore(env);
  let migrated = 0;
  let anomalies = 0;
  for (const channel of result.results) {
    try {
      await store.persistSecureConfig(channel.id, channel.type, channel.config);
      const resolvedAt = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE migration_anomalies SET status = 'resolved', resolved_at = ?,
         updated_at = ? WHERE migration_key = ?
           AND source_table = 'notification_channels' AND source_pk = ?
           AND status = 'retry_requested'`
      )
        .bind(resolvedAt, resolvedAt, migrationKey, String(channel.id))
        .run();
      migrated += 1;
    } catch (error) {
      anomalies += 1;
      null;
    }
  }
  null;
  return {
    migrated,
    anomalies,
    remaining: result.results.length === limit,
    configured: true,
  };
}

export async function rotateNotificationSecretKek(env: Bindings, limit = 10) {
  if (!env.NOTIFICATION_KEK) {
    return { rotated: 0, remaining: true, configured: false };
  }
  if (env.NOTIFICATION_KEK_ROTATION_ENABLED !== "true") {
    return { rotated: 0, remaining: false, configured: true, enabled: false };
  }
  const targetKeyVersion = getNotificationKekVersion(env);
  const rows = await env.DB.prepare(
    `SELECT channel_id, wrapped_dek, wrap_iv, key_version
     FROM notification_secrets WHERE key_version <> ?
     ORDER BY channel_id ASC LIMIT ?`
  )
    .bind(targetKeyVersion, limit)
    .all<{
      channel_id: number;
      wrapped_dek: string;
      wrap_iv: string;
      key_version: number;
    }>();
  let rotated = 0;
  for (const row of rows.results) {
    const wrapping = await rewrapNotificationSecretPayload(env, row);
    const now = new Date().toISOString();
    const result = await env.DB.prepare(
      `UPDATE notification_secrets SET wrapped_dek = ?, wrap_iv = ?,
       key_version = ?, updated_at = ? WHERE channel_id = ? AND key_version = ?`
    )
      .bind(
        wrapping.wrappedDek,
        wrapping.wrapIv,
        wrapping.keyVersion,
        now,
        row.channel_id,
        row.key_version
      )
      .run();
    if (result.meta.changes === 1) rotated += 1;
  }
  return {
    rotated,
    remaining: rows.results.length === limit,
    configured: true,
    enabled: true,
    targetKeyVersion,
  };
}

export async function getNotificationSecretMigrationCoverage(env: Bindings) {
  const targetKeyVersion = getEnvNumber(env, "NOTIFICATION_KEK_VERSION", 1, {
    min: 1,
    max: 2_147_483_647,
  });
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN e.channel_id IS NOT NULL THEN 1 ELSE 0 END) AS endpoint_covered,
       SUM(CASE WHEN s.channel_id IS NOT NULL THEN 1 ELSE 0 END) AS encrypted_secret_rows,
       SUM(CASE WHEN s.channel_id IS NOT NULL AND s.key_version = ? THEN 1 ELSE 0 END)
         AS current_key_rows
     FROM notification_channels c
     LEFT JOIN notification_endpoints e ON e.channel_id = c.id
     LEFT JOIN notification_secrets s ON s.channel_id = c.id
     WHERE c.deleted_at IS NULL`
  )
    .bind(targetKeyVersion)
    .first<{
      total: number;
      endpoint_covered: number | null;
      encrypted_secret_rows: number | null;
      current_key_rows: number | null;
    }>();
  return {
    total: Number(row?.total ?? 0),
    endpointCovered: Number(row?.endpoint_covered ?? 0),
    encryptedSecretRows: Number(row?.encrypted_secret_rows ?? 0),
    currentKeyRows: Number(row?.current_key_rows ?? 0),
  };
}
