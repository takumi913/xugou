import type { Bindings } from "../../models/db";
import { digestAdminSessionToken } from "../../modules/auth/persistence/D1SessionStore";
import { writeStructuredLog } from "../observability/StructuredLogger";

const SENSITIVE_METADATA_KEY = /(token|secret|password|authorization|cookie)/i;
type SecurityEnv = Pick<Bindings, "DB" | "SESSION_HMAC_SECRET"> &
  Partial<Pick<Bindings, "CF_VERSION_METADATA">>;

export interface RateLimitPolicy {
  maxAttempts: number;
  windowMs: number;
  blockMs: number;
}

export const LOGIN_RATE_LIMIT_POLICY: RateLimitPolicy = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
};

export const CONTROL_PLANE_RATE_LIMIT_POLICY: RateLimitPolicy = {
  maxAttempts: 10,
  windowMs: 60 * 60 * 1000,
  blockMs: 60 * 60 * 1000,
};

export function getRequestClientIp(request: Request) {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export async function consumeRateLimit(
  env: SecurityEnv,
  scope: string,
  subject: string,
  policy: RateLimitPolicy
) {
  const now = new Date();
  const nowIso = now.toISOString();
  const resetBefore = new Date(now.getTime() - policy.windowMs).toISOString();
  const blockUntil = new Date(now.getTime() + policy.blockMs).toISOString();
  const keyDigest = await digestAdminSessionToken(
    env,
    `rate-limit:${scope}:${subject}`
  );
  const row = await env.DB.prepare(
    `INSERT INTO security_rate_limits
     (key_digest, scope, attempts, window_started_at, blocked_until, created_at, updated_at)
     VALUES (?, ?, 1, ?, NULL, ?, ?)
     ON CONFLICT(key_digest) DO UPDATE SET
       scope = excluded.scope,
       attempts = CASE
         WHEN window_started_at <= ? OR (blocked_until IS NOT NULL AND blocked_until <= ?)
           THEN 1 ELSE attempts + 1 END,
       window_started_at = CASE
         WHEN window_started_at <= ? OR (blocked_until IS NOT NULL AND blocked_until <= ?)
           THEN ? ELSE window_started_at END,
       blocked_until = CASE
         WHEN window_started_at <= ? OR (blocked_until IS NOT NULL AND blocked_until <= ?)
           THEN NULL
         WHEN attempts + 1 > ? THEN ? ELSE blocked_until END,
       updated_at = ?
     RETURNING attempts, blocked_until`
  )
    .bind(
      keyDigest,
      scope,
      nowIso,
      nowIso,
      nowIso,
      resetBefore,
      nowIso,
      resetBefore,
      nowIso,
      nowIso,
      resetBefore,
      nowIso,
      policy.maxAttempts,
      blockUntil,
      nowIso
    )
    .first<{ attempts: number; blocked_until: string | null }>();
  const attempts = Number(row?.attempts ?? 1);
  const blockedUntilMs = row?.blocked_until
    ? Date.parse(row.blocked_until)
    : Number.NaN;
  const blocked = Number.isFinite(blockedUntilMs) && blockedUntilMs > now.getTime();
  return {
    allowed: !blocked && attempts <= policy.maxAttempts,
    attempts,
    retryAfterSeconds: blocked
      ? Math.max(1, Math.ceil((blockedUntilMs - now.getTime()) / 1000))
      : 0,
    keyDigest,
  };
}

export async function clearRateLimit(env: Pick<Bindings, "DB">, keyDigest: string) {
  await env.DB.prepare(`DELETE FROM security_rate_limits WHERE key_digest = ?`)
    .bind(keyDigest)
    .run();
}

export function sanitizeSecurityAuditMetadata(
  metadata: Record<string, string | number | boolean | null | undefined>
) {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 20)) {
    if (SENSITIVE_METADATA_KEY.test(key) || value === undefined) continue;
    safe[key] = typeof value === "string" ? value.slice(0, 256) : value;
  }
  return safe;
}

export async function writeSecurityAuditEvent(
  env: SecurityEnv,
  input: {
    eventType: string;
    outcome: "success" | "failure" | "denied";
    actorType: "admin" | "agent" | "anonymous" | "system";
    actorId?: string | number | null;
    subjectType?: string | null;
    subjectId?: string | number | null;
    request?: Request;
    metadata?: Record<string, string | number | boolean | null | undefined>;
  }
) {
  try {
    const ip = input.request ? getRequestClientIp(input.request) : null;
    const ipDigest = ip
      ? await digestAdminSessionToken(env, `audit-ip:${ip}`)
      : null;
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO security_audit_events
       (id, event_type, outcome, actor_type, actor_id, subject_type, subject_id,
        request_id, ip_digest, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        input.eventType,
        input.outcome,
        input.actorType,
        input.actorId == null ? null : String(input.actorId),
        input.subjectType ?? null,
        input.subjectId == null ? null : String(input.subjectId),
        input.request?.headers.get("CF-Ray") ??
          input.request?.headers.get("X-Request-ID") ??
          null,
        ipDigest,
        JSON.stringify(sanitizeSecurityAuditMetadata(input.metadata ?? {})),
        now,
        now
      )
      .run();
  } catch (error) {
    writeStructuredLog(env, {
      service: "http",
      operation: "security_audit_write",
      result: "failure",
      errorCode: "SECURITY_AUDIT_WRITE_FAILED",
      error,
      entityType: input.subjectType ?? undefined,
      entityId: input.subjectId ?? undefined,
      fields: { event_type: input.eventType, outcome: input.outcome },
    });
  }
}

export async function listSecurityAuditEvents(
  env: Pick<Bindings, "DB">,
  filter: { eventType?: string; outcome?: string; limit: number; offset: number }
) {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (filter.eventType) {
    conditions.push("event_type = ?");
    bindings.push(filter.eventType);
  }
  if (filter.outcome) {
    conditions.push("outcome = ?");
    bindings.push(filter.outcome);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT id, event_type, outcome, actor_type, actor_id, subject_type,
              subject_id, request_id, ip_digest, metadata_json, created_at, updated_at
       FROM security_audit_events ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
      .bind(...bindings, filter.limit, filter.offset)
      .all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT count(*) AS count FROM security_audit_events ${where}`)
      .bind(...bindings)
      .first<{ count: number }>(),
  ]);
  return { rows: rows.results, total: Number(count?.count ?? 0) };
}

interface SecurityAuditCursor {
  createdAt: string;
  id: string;
}

export function encodeSecurityAuditCursor(cursor: SecurityAuditCursor) {
  return `${cursor.createdAt}|${cursor.id}`;
}

export function decodeSecurityAuditCursor(
  value: string | undefined
): SecurityAuditCursor | null {
  if (!value) return null;
  const separator = value.lastIndexOf("|");
  if (separator <= 0 || separator === value.length - 1) return null;
  const createdAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!Number.isFinite(Date.parse(createdAt)) || id.length > 128) return null;
  return { createdAt, id };
}

export async function listSecurityAuditEventsPage(
  env: Pick<Bindings, "DB">,
  filter: {
    cursor?: string;
    eventType?: string;
    outcome?: string;
    limit: number;
  }
) {
  if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 100) {
    throw new Error("SECURITY_AUDIT_LIMIT_INVALID");
  }
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (filter.eventType) {
    conditions.push("event_type = ?");
    bindings.push(filter.eventType);
  }
  if (filter.outcome) {
    conditions.push("outcome = ?");
    bindings.push(filter.outcome);
  }
  const cursor = decodeSecurityAuditCursor(filter.cursor);
  if (filter.cursor && !cursor) {
    throw new Error("SECURITY_AUDIT_CURSOR_INVALID");
  }
  if (cursor) {
    conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await env.DB.prepare(
    `SELECT id, event_type, outcome, actor_type, actor_id, subject_type,
            subject_id, request_id, ip_digest, metadata_json, created_at, updated_at
     FROM security_audit_events ${where}
     ORDER BY created_at DESC, id DESC LIMIT ?`
  )
    .bind(...bindings, filter.limit + 1)
    .all<Record<string, unknown> & { id: string; created_at: string }>();
  const hasMore = rows.results.length > filter.limit;
  const data = hasMore ? rows.results.slice(0, filter.limit) : rows.results;
  const last = data.at(-1);
  return {
    data,
    next_cursor:
      hasMore && last
        ? encodeSecurityAuditCursor({ createdAt: last.created_at, id: last.id })
        : null,
    has_more: hasMore,
  };
}

export async function deleteStaleSecurityRateLimits(
  env: Pick<Bindings, "DB">,
  cutoff: string
) {
  await env.DB.prepare(`DELETE FROM security_rate_limits WHERE updated_at < ?`)
    .bind(cutoff)
    .run();
}

export async function deleteOldSecurityAuditEvents(
  env: Pick<Bindings, "DB">,
  cutoff: string
) {
  await env.DB.prepare(`DELETE FROM security_audit_events WHERE created_at < ?`)
    .bind(cutoff)
    .run();
}
