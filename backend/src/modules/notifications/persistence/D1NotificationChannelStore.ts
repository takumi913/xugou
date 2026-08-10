import type { NotificationChannel } from "../../../models/notification";
import type { Bindings } from "../../../models/db";
import {
  decryptNotificationSecretPayload,
  encryptNotificationSecretPayload,
  MASKED_NOTIFICATION_SECRET,
  splitNotificationConfig,
} from "../security/notification-secret-crypto";
import { isContractMode } from "../../../platform/compatibility/CompatibilityMode";

export type ChannelRow = {
  id: number;
  name: string;
  type: string;
  config: string;
  enabled: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type SecureRow = {
  public_config_json: string | null;
  ciphertext: string | null;
  iv: string | null;
  wrapped_dek: string | null;
  wrap_iv: string | null;
  key_version: number | null;
};

function parseObject(value: unknown) {
  if (typeof value !== "string") {
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toChannel(row: ChannelRow, config: Record<string, unknown>): NotificationChannel {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: JSON.stringify(config),
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class D1NotificationChannelStore {
  constructor(private readonly env: Bindings) {}

  async findRow(id: number) {
    return this.env.DB.prepare(
      isContractMode(this.env)
        ? `SELECT id, name, type, '{}' AS config, enabled, deleted_at,
                  created_at, updated_at
           FROM notification_channels WHERE id = ? AND deleted_at IS NULL LIMIT 1`
        : `SELECT id, name, type, config, enabled, deleted_at, created_at, updated_at
           FROM notification_channels WHERE id = ? AND deleted_at IS NULL LIMIT 1`
    )
      .bind(id)
      .first<ChannelRow>();
  }

  async listMasked(limit = 100) {
    const boundedLimit = Math.max(1, Math.min(100, limit));
    const rows = await this.env.DB.prepare(
      isContractMode(this.env)
        ? `SELECT channel.id, channel.name, channel.type, '{}' AS config,
                  channel.enabled, channel.deleted_at, channel.created_at,
                  channel.updated_at, endpoint.public_config_json,
                  secret.ciphertext, secret.iv, secret.wrapped_dek,
                  secret.wrap_iv, secret.key_version
           FROM notification_channels channel
           LEFT JOIN notification_endpoints endpoint
             ON endpoint.channel_id = channel.id
           LEFT JOIN notification_secrets secret
             ON secret.channel_id = channel.id
           WHERE channel.deleted_at IS NULL
           ORDER BY channel.id ASC LIMIT ?`
        : `SELECT channel.id, channel.name, channel.type, channel.config,
                  channel.enabled, channel.deleted_at, channel.created_at,
                  channel.updated_at, endpoint.public_config_json,
                  secret.ciphertext, secret.iv, secret.wrapped_dek,
                  secret.wrap_iv, secret.key_version
           FROM notification_channels channel
           LEFT JOIN notification_endpoints endpoint
             ON endpoint.channel_id = channel.id
           LEFT JOIN notification_secrets secret
             ON secret.channel_id = channel.id
           WHERE channel.deleted_at IS NULL
           ORDER BY channel.id ASC LIMIT ?`
    )
      .bind(boundedLimit)
      .all<ChannelRow & SecureRow>();
    return Promise.all(
      rows.results.map(async (row) => {
        // Expand 旧行仍按原有读升级策略补齐 Endpoint；规范行无需 N+1 查询。
        if (row.public_config_json === null) return this.maskedChannel(row);
        const fullConfig = await this.configFromSecureRow(row);
        const { publicConfig, secrets } = splitNotificationConfig(
          row.type,
          fullConfig
        );
        const masked = Object.fromEntries(
          Object.keys(secrets).map((key) => [key, MASKED_NOTIFICATION_SECRET])
        );
        return toChannel(row, { ...publicConfig, ...masked });
      })
    );
  }

  private async secureRow(channelId: number) {
    return this.env.DB.prepare(
      `SELECT e.public_config_json, s.ciphertext, s.iv, s.wrapped_dek, s.wrap_iv,
              s.key_version
       FROM notification_endpoints e
       LEFT JOIN notification_secrets s ON s.channel_id = e.channel_id
       WHERE e.channel_id = ? LIMIT 1`
    )
      .bind(channelId)
      .first<SecureRow>();
  }

  private async configFromSecureRow(secure: SecureRow) {
    const publicConfig = parseObject(secure.public_config_json);
    if (
      !secure.ciphertext ||
      !secure.iv ||
      !secure.wrapped_dek ||
      !secure.wrap_iv
    ) {
      return publicConfig;
    }
    const secrets = await decryptNotificationSecretPayload(this.env, {
      ciphertext: secure.ciphertext,
      iv: secure.iv,
      wrapped_dek: secure.wrapped_dek,
      wrap_iv: secure.wrap_iv,
      key_version: secure.key_version ?? 1,
    });
    return { ...publicConfig, ...secrets };
  }

  async persistSecureConfig(channelId: number, type: string, config: unknown) {
    const { publicConfig, secrets } = splitNotificationConfig(type, config);
    if (Object.values(secrets).includes(MASKED_NOTIFICATION_SECRET)) {
      throw new Error("脱敏占位符不可作为新通知 Secret 保存");
    }
    const encrypted = await encryptNotificationSecretPayload(this.env, secrets);
    const now = new Date().toISOString();
    const statements = [
      this.env.DB.prepare(
        `INSERT INTO notification_endpoints
         (channel_id, public_config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           public_config_json = excluded.public_config_json,
           updated_at = excluded.updated_at`
      ).bind(channelId, JSON.stringify(publicConfig), now, now),
    ];
    statements.push(
      isContractMode(this.env)
        ? this.env.DB.prepare(
            `UPDATE notification_channels SET updated_at = ? WHERE id = ?`
          ).bind(now, channelId)
        : this.env.DB.prepare(
            `UPDATE notification_channels SET config = ?, updated_at = ? WHERE id = ?`
          ).bind(JSON.stringify(publicConfig), now, channelId)
    );
    if (encrypted) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO notification_secrets
           (channel_id, ciphertext, iv, wrapped_dek, wrap_iv, key_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(channel_id) DO UPDATE SET
             ciphertext = excluded.ciphertext, iv = excluded.iv,
             wrapped_dek = excluded.wrapped_dek, wrap_iv = excluded.wrap_iv,
             key_version = excluded.key_version, updated_at = excluded.updated_at`
        ).bind(
          channelId,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.wrappedDek,
          encrypted.wrapIv,
          encrypted.keyVersion,
          now,
          now
        )
      );
    } else {
      statements.push(
        this.env.DB.prepare(`DELETE FROM notification_secrets WHERE channel_id = ?`).bind(
          channelId
        )
      );
    }
    await this.env.DB.batch(statements);
  }

  async loadFullConfig(row: ChannelRow) {
    const secure = await this.secureRow(row.id);
    if (!secure) {
      if (isContractMode(this.env)) {
        throw new Error("通知渠道缺少规范 Endpoint 配置");
      }
      // Upgrade old rows on first read and erase plaintext secrets from the legacy column.
      const legacy = parseObject(row.config);
      await this.persistSecureConfig(row.id, row.type, legacy);
      return legacy;
    }
    return this.configFromSecureRow(secure);
  }

  async maskedChannel(row: ChannelRow) {
    const fullConfig = await this.loadFullConfig(row);
    const { publicConfig, secrets } = splitNotificationConfig(row.type, fullConfig);
    const masked = Object.fromEntries(
      Object.keys(secrets).map((key) => [key, MASKED_NOTIFICATION_SECRET])
    );
    return toChannel(row, { ...publicConfig, ...masked });
  }

  async deliveryChannel(id: number) {
    const row = await this.findRow(id);
    if (!row) return null;
    return toChannel(row, await this.loadFullConfig(row));
  }

  async mergeConfigUpdate(
    row: ChannelRow,
    nextType: string,
    nextConfig: unknown
  ) {
    const candidate = parseObject(nextConfig);
    if (nextType !== row.type) return candidate;
    const current = await this.loadFullConfig(row);
    const currentSecrets = splitNotificationConfig(row.type, current).secrets;
    for (const key of Object.keys(currentSecrets)) {
      if (
        candidate[key] === MASKED_NOTIFICATION_SECRET ||
        candidate[key] === undefined
      ) {
        candidate[key] = current[key];
      }
    }
    return candidate;
  }
}
