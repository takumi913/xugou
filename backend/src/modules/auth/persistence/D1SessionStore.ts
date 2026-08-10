import type { Bindings } from "../../../models/db";
import { generateSecureToken, hmacSha256Hex } from "../../../utils/crypto";

const SESSION_TOKEN_PREFIX = "xgs_";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const MIN_HMAC_SECRET_LENGTH = 32;

type SessionEnv = Pick<Bindings, "DB" | "SESSION_HMAC_SECRET">;

export class SessionConfigurationError extends Error {
  constructor() {
    super("SESSION_HMAC_SECRET 配置缺失或长度不足");
    this.name = "SessionConfigurationError";
  }
}

function requireSessionHmacSecret(env: Pick<Bindings, "SESSION_HMAC_SECRET">) {
  const secret = env.SESSION_HMAC_SECRET?.trim();
  if (!secret || secret.length < MIN_HMAC_SECRET_LENGTH) {
    throw new SessionConfigurationError();
  }
  return secret;
}

export async function digestAdminSessionToken(
  env: Pick<Bindings, "SESSION_HMAC_SECRET">,
  token: string
): Promise<string> {
  return hmacSha256Hex(requireSessionHmacSecret(env), token);
}

export interface CreatedAdminSession {
  token: string;
  expiresAt: string;
}

export async function createAdminSession(
  env: SessionEnv,
  userId: number
): Promise<CreatedAdminSession> {
  const now = new Date();
  const nowIso = now.toISOString();
  const token = `${SESSION_TOKEN_PREFIX}${generateSecureToken(32)}`;
  const tokenDigest = await digestAdminSessionToken(env, token);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM admin_sessions WHERE expires_at <= ?`).bind(nowIso),
    env.DB.prepare(
      `INSERT INTO admin_sessions
       (token_digest, user_id, expires_at, last_seen_at, revoked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`
    ).bind(tokenDigest, userId, expiresAt, nowIso, nowIso, nowIso),
  ]);
  return { token, expiresAt };
}

export async function authenticateAdminSession(env: SessionEnv, token: string) {
  if (!/^xgs_[0-9a-f]{64}$/.test(token)) return null;
  const now = new Date();
  const nowIso = now.toISOString();
  const tokenDigest = await digestAdminSessionToken(env, token);
  const session = await env.DB.prepare(
    `SELECT s.user_id, s.last_seen_at, u.id, u.username
     FROM admin_sessions s
     JOIN users u ON u.id = s.user_id AND u.id = 1
     WHERE s.token_digest = ? AND s.revoked_at IS NULL AND s.expires_at > ?
     LIMIT 1`
  )
    .bind(tokenDigest, nowIso)
    .first<{ user_id: number; last_seen_at: string; id: number; username: string }>();
  if (!session) return null;
  const lastSeenAt = Date.parse(session.last_seen_at);
  if (!Number.isFinite(lastSeenAt) || now.getTime() - lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
    await env.DB.prepare(
      `UPDATE admin_sessions SET last_seen_at = ?, updated_at = ?
       WHERE token_digest = ? AND revoked_at IS NULL AND expires_at > ?`
    )
      .bind(nowIso, nowIso, tokenDigest, nowIso)
      .run();
  }
  return {
    tokenDigest,
    payload: { id: session.id, username: session.username },
  };
}

export async function revokeAdminSession(env: SessionEnv, token: string) {
  if (!/^xgs_[0-9a-f]{64}$/.test(token)) return;
  const tokenDigest = await digestAdminSessionToken(env, token);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE admin_sessions SET revoked_at = ?, updated_at = ?
     WHERE token_digest = ? AND revoked_at IS NULL`
  )
    .bind(now, now, tokenDigest)
    .run();
}

export async function revokeOtherSessionsAfterPasswordChange(
  env: SessionEnv,
  userId: number,
  currentToken: string | null
) {
  const currentTokenDigest = currentToken
    ? await digestAdminSessionToken(env, currentToken)
    : null;
  const now = new Date().toISOString();
  if (currentTokenDigest) {
    await env.DB.prepare(
      `UPDATE admin_sessions SET revoked_at = ?, updated_at = ?
       WHERE user_id = ? AND revoked_at IS NULL AND token_digest <> ?`
    )
      .bind(now, now, userId, currentTokenDigest)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE admin_sessions SET revoked_at = ?, updated_at = ?
       WHERE user_id = ? AND revoked_at IS NULL`
    )
      .bind(now, now, userId)
      .run();
  }
}
