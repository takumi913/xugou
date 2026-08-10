import type { Agent } from "../../../models/agent";
import type { Bindings } from "../../../models/db";
import { generateSecureToken, hmacSha256Hex } from "../../../utils/crypto";
import { getEnvNumber } from "../../../utils/env";


const MIN_PEPPER_LENGTH = 32;
const DEFAULT_ENROLLMENT_TTL_MINUTES = 30;
const CREDENTIAL_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_ACTIVE_AGENT_CREDENTIALS = 5;
const MAX_AGENT_CREDENTIAL_PAGE_SIZE = 100;

interface AgentCredentialRow {
  id: number;
  agent_id: number;
  token_digest: string;
  token_hint: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentEnrollmentRow {
  id: number;
  token_digest: string;
  issued_by: number;
  agent_id: number | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export class AgentCredentialConfigurationError extends Error {
  constructor() {
    super("AGENT_TOKEN_PEPPER 配置缺失或长度不足");
    this.name = "AgentCredentialConfigurationError";
  }
}

export class AgentCredentialLimitError extends Error {
  constructor() {
    super(`每个 Agent 最多保留 ${MAX_ACTIVE_AGENT_CREDENTIALS} 份活动凭据`);
    this.name = "AgentCredentialLimitError";
  }
}

function requireAgentTokenPepper(env: Pick<Bindings, "AGENT_TOKEN_PEPPER">) {
  const pepper = env.AGENT_TOKEN_PEPPER?.trim();
  if (!pepper || pepper.length < MIN_PEPPER_LENGTH) {
    throw new AgentCredentialConfigurationError();
  }
  return pepper;
}

export async function digestAgentToken(
  env: Pick<Bindings, "AGENT_TOKEN_PEPPER">,
  token: string
) {
  return hmacSha256Hex(requireAgentTokenPepper(env), token);
}

function tokenHint(token: string) {
  return token.length <= 12 ? "****" : `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function generateAgentCredentialToken() {
  return `xga_${generateSecureToken(32)}`;
}

async function findActiveCredential(env: Bindings, digest: string) {
  return env.DB.prepare(
    `SELECT * FROM agent_credentials
     WHERE token_digest = ? AND revoked_at IS NULL LIMIT 1`
  )
    .bind(digest)
    .first<AgentCredentialRow>();
}

async function findActiveAgent(env: Bindings, agentId: number) {
  return env.DB.prepare(
    `SELECT id FROM agent_nodes WHERE id = ? AND deleted_at_ms IS NULL LIMIT 1`
  )
    .bind(agentId)
    .first<Agent>();
}

export async function createCredentialForAgent(
  env: Bindings,
  agentId: number,
  token: string,
  options: { maxActive?: number } = {}
) {
  const now = new Date().toISOString();
  const digest = await digestAgentToken(env, token);
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO agent_credentials
     (agent_id, token_digest, token_hint, last_used_at, revoked_at,
      created_at, updated_at)
     SELECT ?, ?, ?, ?, NULL, ?, ?
     WHERE ? IS NULL OR (
       SELECT COUNT(*) FROM agent_credentials
       WHERE agent_id = ? AND revoked_at IS NULL
     ) < ?
     RETURNING *`
  )
    .bind(
      agentId,
      digest,
      tokenHint(token),
      now,
      now,
      now,
      options.maxActive ?? null,
      agentId,
      options.maxActive ?? null
    )
    .first<AgentCredentialRow>();
  const credential = inserted ?? (await findActiveCredential(env, digest));
  if (!credential && options.maxActive !== undefined) {
    const active = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM agent_credentials
       WHERE agent_id = ? AND revoked_at IS NULL`
    )
      .bind(agentId)
      .first<{ count: number }>();
    if (Number(active?.count ?? 0) >= options.maxActive) {
      throw new AgentCredentialLimitError();
    }
  }
  if (!credential || Number(credential.agent_id) !== agentId) {
    throw new Error("Agent Token 已绑定其他客户端");
  }
}

export async function authenticateAgentToken(env: Bindings, token: string) {
  if (!token || token.length > 512) return null;
  const digest = await digestAgentToken(env, token);
  const credential = await findActiveCredential(env, digest);
  if (credential) {
    const agent = await findActiveAgent(env, Number(credential.agent_id));
    if (!agent) return null;
    const lastUsedAt = Date.parse(String(credential.last_used_at ?? ""));
    if (
      !Number.isFinite(lastUsedAt) ||
      Date.now() - lastUsedAt >= CREDENTIAL_TOUCH_INTERVAL_MS
    ) {
      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE agent_credentials SET last_used_at = ?, updated_at = ?
         WHERE id = ? AND revoked_at IS NULL`
      )
        .bind(now, now, credential.id)
        .run();
    }
    return agent;
  }

  return null;
}

export async function issueAgentEnrollmentToken(
  env: Bindings,
  issuedBy: number
) {
  const token = `xge_${generateSecureToken(32)}`;
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() +
      getEnvNumber(env, "AGENT_ENROLLMENT_TTL_MINUTES", DEFAULT_ENROLLMENT_TTL_MINUTES, {
        min: 5,
        max: 1440,
      }) *
        60 *
        1000
  ).toISOString();
  const nowIso = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO agent_enrollment_tokens
     (token_digest, issued_by, agent_id, expires_at, used_at, revoked_at,
      created_at, updated_at)
     VALUES (?, ?, NULL, ?, NULL, NULL, ?, ?)`
  )
    .bind(await digestAgentToken(env, token), issuedBy, expiresAt, nowIso, nowIso)
    .run();
  return { token, expiresAt };
}

export async function consumeAgentEnrollmentToken(env: Bindings, token: string) {
  const now = new Date().toISOString();
  return env.DB.prepare(
    `UPDATE agent_enrollment_tokens SET used_at = ?, updated_at = ?
     WHERE token_digest = ? AND used_at IS NULL AND revoked_at IS NULL
       AND expires_at > ?
     RETURNING *`
  )
    .bind(now, now, await digestAgentToken(env, token), now)
    .first<AgentEnrollmentRow>();
}

export async function linkAgentEnrollmentToken(
  env: Bindings,
  enrollmentId: number,
  agentId: number,
  now = new Date().toISOString()
) {
  await env.DB.prepare(
    `UPDATE agent_enrollment_tokens SET agent_id = ?, updated_at = ? WHERE id = ?`
  )
    .bind(agentId, now, enrollmentId)
    .run();
}

export async function releaseAgentEnrollmentToken(
  env: Bindings,
  enrollmentId: number,
  now = new Date().toISOString()
) {
  await env.DB.prepare(
    `UPDATE agent_enrollment_tokens SET used_at = NULL, updated_at = ?
     WHERE id = ? AND agent_id IS NULL AND revoked_at IS NULL`
  )
    .bind(now, enrollmentId)
    .run();
}

export async function backfillLegacyAgentCredentials(env: Bindings, limit = 25) {
  if (!env.AGENT_TOKEN_PEPPER) {
    return { migrated: 0, remaining: true, configured: false };
  }
  requireAgentTokenPepper(env);
  const migrationKey = "agent-credential-v1";
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.token FROM agents a
     WHERE a.deleted_at IS NULL AND a.token NOT LIKE 'deleted:%'
       AND NOT EXISTS (
         SELECT 1 FROM agent_credentials c WHERE c.agent_id = a.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM migration_anomalies ma
         WHERE ma.migration_key = ? AND ma.source_table = 'agents'
           AND ma.source_pk = CAST(a.id AS TEXT) AND ma.status IN ('open', 'ignored')
       )
     ORDER BY a.id LIMIT ?`
  )
    .bind(migrationKey, limit)
    .all<{ id: number; token: string }>();
  let migrated = 0;
  let anomalies = 0;
  for (const row of results) {
    try {
      await createCredentialForAgent(env, row.id, row.token);
      const resolvedAt = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE migration_anomalies SET status = 'resolved', resolved_at = ?,
         updated_at = ? WHERE migration_key = ? AND source_table = 'agents'
           AND source_pk = ? AND status = 'retry_requested'`
      )
        .bind(resolvedAt, resolvedAt, migrationKey, String(row.id))
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
    remaining: results.length === limit,
    configured: true,
  };
}

export async function rotateAgentCredential(env: Bindings, agentId: number) {
  if (!(await findActiveAgent(env, agentId))) return null;
  const token = generateAgentCredentialToken();
  await createCredentialForAgent(env, agentId, token, {
    maxActive: MAX_ACTIVE_AGENT_CREDENTIALS,
  });
  return { token };
}

export async function listAgentCredentialMetadata(
  env: Bindings,
  agentId: number,
  input: { cursor?: number; limit?: number } = {}
) {
  if (!(await findActiveAgent(env, agentId))) return null;
  const limit = Math.max(
    1,
    Math.min(MAX_AGENT_CREDENTIAL_PAGE_SIZE, input.limit ?? 25)
  );
  const rows = (
    await env.DB.prepare(
      `SELECT id, agent_id, token_hint, last_used_at, revoked_at, created_at
       FROM agent_credentials
       WHERE agent_id = ? AND (? IS NULL OR id < ?)
       ORDER BY id DESC LIMIT ?`
    )
      .bind(agentId, input.cursor ?? null, input.cursor ?? null, limit + 1)
      .all<{
        id: number;
        agent_id: number;
        token_hint: string;
        last_used_at: string | null;
        revoked_at: string | null;
        created_at: string;
      }>()
  ).results;
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    next_cursor: hasMore ? String(data.at(-1)?.id ?? "") : null,
    has_more: hasMore,
  };
}

export async function revokeAgentCredential(
  env: Bindings,
  agentId: number,
  credentialId: number
) {
  if (!(await findActiveAgent(env, agentId))) {
    return { success: false, reason: "agent_not_found" as const };
  }
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `UPDATE agent_credentials SET revoked_at = ?, updated_at = ?
     WHERE id = ? AND agent_id = ? AND revoked_at IS NULL
       AND (SELECT COUNT(*) FROM agent_credentials
            WHERE agent_id = ? AND revoked_at IS NULL) > 1
     RETURNING id`
  )
    .bind(now, now, credentialId, agentId, agentId)
    .first<{ id: number }>();
  return row
    ? { success: true as const }
    : { success: false as const, reason: "last_or_missing" as const };
}

export async function listAgentEnrollments(env: Bindings, issuedBy: number) {
  return (
    await env.DB.prepare(
      `SELECT id, agent_id, expires_at, used_at, revoked_at, created_at
       FROM agent_enrollment_tokens WHERE issued_by = ?
       ORDER BY created_at DESC LIMIT 100`
    )
      .bind(issuedBy)
      .all<{
        id: number;
        agent_id: number | null;
        expires_at: string;
        used_at: string | null;
        revoked_at: string | null;
        created_at: string;
      }>()
  ).results;
}

export async function revokeAgentEnrollment(
  env: Bindings,
  issuedBy: number,
  enrollmentId: number
) {
  const now = new Date().toISOString();
  return Boolean(
    await env.DB.prepare(
      `UPDATE agent_enrollment_tokens SET revoked_at = ?, updated_at = ?
       WHERE id = ? AND issued_by = ? AND used_at IS NULL AND revoked_at IS NULL
       RETURNING id`
    )
      .bind(now, now, enrollmentId, issuedBy)
      .first<{ id: number }>()
  );
}

export async function getAgentCredentialBackfillCoverage(env: Bindings) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM agent_credentials c
            WHERE c.agent_id = a.id AND c.revoked_at IS NULL
          ) THEN 1 ELSE 0 END) AS covered
       FROM agent_nodes a WHERE a.deleted_at_ms IS NULL`
  ).first<{ total: number; covered: number | null }>();
  return {
    total: Number(row?.total ?? 0),
    covered: Number(row?.covered ?? 0),
  };
}
