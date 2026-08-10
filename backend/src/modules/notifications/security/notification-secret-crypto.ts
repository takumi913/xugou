import type { Bindings } from "../../../models/db";
import { getEnvNumber } from "../../../utils/env";

export const MASKED_NOTIFICATION_SECRET = "********";
const NOTIFICATION_KEK_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const ENVELOPE_AAD = new TextEncoder().encode("xugou-notification-secret-v1");
const DEFAULT_NOTIFICATION_KEK_VERSION = 1;

type NotificationKekEnv = Partial<
  Pick<
    Bindings,
    | "NOTIFICATION_KEK"
    | "NOTIFICATION_KEK_VERSION"
    | "NOTIFICATION_KEK_PREVIOUS"
    | "NOTIFICATION_KEK_PREVIOUS_VERSION"
    | "NOTIFICATION_KEK_ROTATION_ENABLED"
  >
>;

const SENSITIVE_CONFIG_KEYS: Record<string, ReadonlySet<string>> = {
  telegram: new Set(["botToken"]),
  resend: new Set(["apiKey"]),
  feishu: new Set(["webhookUrl"]),
  wecom: new Set(["webhookUrl"]),
  dingtalk: new Set(["webhook_url", "secret"]),
  bark: new Set(["device_key"]),
  serverchan: new Set(["send_key"]),
  wxpusher: new Set(["app_token"]),
  gotify: new Set(["app_token"]),
  onebot: new Set(["access_token"]),
};

export class NotificationSecretConfigurationError extends Error {
  constructor() {
    super("NOTIFICATION_KEK 配置缺失或格式错误");
    this.name = "NotificationSecretConfigurationError";
  }
}

function parseConfig(config: unknown): Record<string, unknown> {
  if (typeof config === "string") {
    try {
      const parsed = JSON.parse(config) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return config && typeof config === "object" && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};
}

function isSensitiveKey(type: string, key: string) {
  const configured = SENSITIVE_CONFIG_KEYS[type];
  if (configured) {
    return configured.has(key);
  }
  return /(token|secret|password|api[_-]?key|webhook)/i.test(key);
}

export function splitNotificationConfig(type: string, config: unknown) {
  const publicConfig: Record<string, unknown> = {};
  const secrets: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parseConfig(config))) {
    if (isSensitiveKey(type, key)) {
      if (value !== undefined && value !== null && value !== "") {
        secrets[key] = value;
      }
    } else {
      publicConfig[key] = value;
    }
  }
  return { publicConfig, secrets };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function getNotificationKekVersion(env: NotificationKekEnv) {
  return getEnvNumber(
    env,
    "NOTIFICATION_KEK_VERSION",
    DEFAULT_NOTIFICATION_KEK_VERSION,
    { min: 1, max: 2147483647 }
  );
}

async function importNotificationKek(encodedValue: string | undefined) {
  const encoded = encodedValue?.trim();
  if (!encoded) {
    throw new NotificationSecretConfigurationError();
  }
  try {
    const bytes = base64ToBytes(encoded);
    if (bytes.byteLength !== NOTIFICATION_KEK_BYTES) {
      throw new NotificationSecretConfigurationError();
    }
    return await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  } catch (error) {
    if (error instanceof NotificationSecretConfigurationError) {
      throw error;
    }
    throw new NotificationSecretConfigurationError();
  }
}

async function getNotificationKek(
  env: NotificationKekEnv,
  requestedVersion = getNotificationKekVersion(env)
) {
  const currentVersion = getNotificationKekVersion(env);
  if (requestedVersion === currentVersion) {
    return importNotificationKek(env.NOTIFICATION_KEK);
  }
  const previousVersion = getEnvNumber(
    env,
    "NOTIFICATION_KEK_PREVIOUS_VERSION",
    -1,
    { min: -1, max: 2147483647 }
  );
  if (requestedVersion === previousVersion) {
    return importNotificationKek(env.NOTIFICATION_KEK_PREVIOUS);
  }
  throw new NotificationSecretConfigurationError();
}

export async function encryptNotificationSecretPayload(
  env: NotificationKekEnv,
  secrets: Record<string, unknown>
) {
  if (Object.keys(secrets).length === 0) {
    return null;
  }

  const kek = await getNotificationKek(env);
  const dataKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const dataKey = await crypto.subtle.importKey(
    "raw",
    dataKeyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const wrapIv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ENVELOPE_AAD },
    dataKey,
    new TextEncoder().encode(JSON.stringify(secrets))
  );
  const wrappedDek = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: wrapIv, additionalData: ENVELOPE_AAD },
    kek,
    dataKeyBytes
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    wrappedDek: bytesToBase64(new Uint8Array(wrappedDek)),
    wrapIv: bytesToBase64(wrapIv),
    keyVersion: getNotificationKekVersion(env),
  };
}

export async function decryptNotificationSecretPayload(
  env: NotificationKekEnv,
  record: {
    ciphertext: string;
    iv: string;
    wrapped_dek: string;
    wrap_iv: string;
    key_version?: number;
  }
) {
  const kek = await getNotificationKek(env, record.key_version ?? 1);
  const dataKeyBytes = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(record.wrap_iv),
      additionalData: ENVELOPE_AAD,
    },
    kek,
    base64ToBytes(record.wrapped_dek)
  );
  const dataKey = await crypto.subtle.importKey(
    "raw",
    dataKeyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(record.iv),
      additionalData: ENVELOPE_AAD,
    },
    dataKey,
    base64ToBytes(record.ciphertext)
  );
  return parseConfig(new TextDecoder().decode(plaintext));
}

export async function rewrapNotificationSecretPayload(
  env: NotificationKekEnv,
  record: {
    wrapped_dek: string;
    wrap_iv: string;
    key_version: number;
  }
) {
  const previousKek = await getNotificationKek(env, record.key_version);
  const dataKeyBytes = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(record.wrap_iv),
      additionalData: ENVELOPE_AAD,
    },
    previousKek,
    base64ToBytes(record.wrapped_dek)
  );
  const wrapIv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const wrappedDek = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: wrapIv, additionalData: ENVELOPE_AAD },
    await getNotificationKek(env),
    dataKeyBytes
  );
  return {
    wrappedDek: bytesToBase64(new Uint8Array(wrappedDek)),
    wrapIv: bytesToBase64(wrapIv),
    keyVersion: getNotificationKekVersion(env),
  };
}
