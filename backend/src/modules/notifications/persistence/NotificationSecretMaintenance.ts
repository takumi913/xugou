import type { Bindings } from "../../../models/db";
import {
  getNotificationKekVersion,
  rewrapNotificationSecretPayload,
} from "../security/notification-secret-crypto";

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
