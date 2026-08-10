import { and, asc, eq, gt, isNull, notExists, or } from "drizzle-orm";
import type { AppDatabase } from "../../../config/db";
import type { Bindings } from "../../../models/db";
import {
  canonicalMigrationJson,
  migrationSha256Hex,
} from "../../../platform/migrations/MigrationEncoding";
import { legacyAgentModelCoverage } from "../../../platform/migrations/LegacyAgentModelBackfill";
import { isContractMode } from "../../../platform/compatibility/CompatibilityMode";
import {
  agentCredentials,
  agentReports,
  agents,
  asyncJobs,
} from "../../../db/schema";
import type { AgentRepositoryPort } from "../application/AgentUseCases";
import type {
  AgentMutation,
  AgentReportCommand,
  AgentView,
  AuthenticatedAgent,
} from "../domain/models";

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseTags(value: string | null): string[] {
  return value
    ? value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];
}

function iso(value: number | null) {
  return value === null ? null : new Date(value).toISOString();
}

type TargetAgentRow = {
  id: number;
  name: string;
  collect_interval_ms: number;
  report_interval_ms: number;
  group_name: string | null;
  tags_json: string;
  price: number | null;
  currency: string | null;
  billing_cycle: string | null;
  expire_date: string | null;
  auto_renewal: number;
  is_hidden: number;
  traffic_limit_gb: number | null;
  traffic_reset_day: number;
  traffic_calc_type: string;
  auto_update: number;
  sort_order: number;
  created_at_ms: number;
  updated_at_ms: number;
  status: string;
  hostname: string | null;
  ip_addresses_json: string;
  os: string | null;
  agent_version: string | null;
  keepalive_seconds: number | null;
  boot_time: number | null;
  last_seen_at_ms: number | null;
  next_offline_at_ms: number | null;
  region: string | null;
  geo_latitude: number | null;
  geo_longitude: number | null;
  geo_city: string | null;
  geo_region_name: string | null;
};

const targetColumns = `n.id, n.name, n.collect_interval_ms,
  n.report_interval_ms, n.group_name, n.tags_json, n.price, n.currency,
  n.billing_cycle, n.expire_date, n.auto_renewal, n.is_hidden,
  n.traffic_limit_gb, n.traffic_reset_day, n.traffic_calc_type,
  n.auto_update, n.sort_order, n.created_at_ms, n.updated_at_ms,
  r.status, r.hostname, r.ip_addresses_json, r.os, r.agent_version,
  r.keepalive_seconds, r.boot_time, r.last_seen_at_ms, r.next_offline_at_ms,
  r.region, r.geo_latitude, r.geo_longitude, r.geo_city, r.geo_region_name`;

function targetView(row: TargetAgentRow): AgentView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    hostname: row.hostname,
    ip_addresses: parseStringArray(row.ip_addresses_json),
    os: row.os,
    version: row.agent_version,
    keepalive:
      row.keepalive_seconds === null ? null : String(row.keepalive_seconds),
    boot_time: row.boot_time,
    collect_interval_seconds: Math.max(
      1,
      Math.floor(row.collect_interval_ms / 1000)
    ),
    report_interval_seconds: Math.max(
      1,
      Math.floor(row.report_interval_ms / 1000)
    ),
    last_seen_at: iso(row.last_seen_at_ms),
    next_offline_at: iso(row.next_offline_at_ms),
    group_name: row.group_name,
    tags: parseStringArray(row.tags_json),
    price: row.price,
    currency: row.currency,
    billing_cycle: row.billing_cycle,
    expire_date: row.expire_date,
    auto_renewal: row.auto_renewal === 1,
    is_hidden: row.is_hidden === 1,
    traffic_limit_gb: row.traffic_limit_gb,
    traffic_reset_day: row.traffic_reset_day,
    traffic_calc_type: row.traffic_calc_type,
    auto_update: row.auto_update === 1,
    region: row.region,
    geo_latitude: row.geo_latitude,
    geo_longitude: row.geo_longitude,
    geo_city: row.geo_city,
    geo_region_name: row.geo_region_name,
    sort_order: row.sort_order,
    created_at: iso(row.created_at_ms)!,
    updated_at: iso(row.updated_at_ms)!,
  };
}

function tokenHint(token: string) {
  return token.length > 12 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "****";
}

function toView(row: typeof agents.$inferSelect): AgentView {
  return {
    id: row.id,
    name: row.name,
    status: row.status ?? "inactive",
    hostname: row.hostname,
    ip_addresses: parseStringArray(row.ip_addresses),
    os: row.os,
    version: row.version,
    keepalive: row.keepalive,
    boot_time: row.boot_time,
    collect_interval_seconds: row.collect_interval ?? 60,
    report_interval_seconds: row.report_interval ?? 300,
    last_seen_at: row.last_seen_at,
    next_offline_at: row.next_offline_at,
    group_name: row.group_name,
    tags: parseTags(row.tags),
    price: row.price,
    currency: row.currency,
    billing_cycle: row.billing_cycle,
    expire_date: row.expire_date,
    auto_renewal: row.auto_renewal === 1,
    is_hidden: row.is_hidden === 1,
    traffic_limit_gb: row.traffic_limit_gb,
    traffic_reset_day: row.traffic_reset_day ?? 1,
    traffic_calc_type: row.traffic_calc_type ?? "sum",
    auto_update: row.auto_update === 1,
    region: row.region,
    geo_latitude: row.geo_latitude,
    geo_longitude: row.geo_longitude,
    geo_city: row.geo_city,
    geo_region_name: row.geo_region_name,
    sort_order: row.sort_order ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toAuthenticated(row: typeof agents.$inferSelect): AuthenticatedAgent {
  return {
    id: row.id,
    name: row.name,
    status: row.status ?? "inactive",
    collect_interval_seconds: row.collect_interval ?? 60,
    report_interval_seconds: row.report_interval ?? 300,
    auto_update: row.auto_update === 1,
  };
}

export class DrizzleAgentRepository implements AgentRepositoryPort {
  constructor(
    private readonly env: Bindings,
    private readonly db: AppDatabase
  ) {}

  private async targetReady() {
    return (
      isContractMode(this.env) ||
      (await legacyAgentModelCoverage(this.env)).read_ready
    );
  }

  async listPage(input: Parameters<AgentRepositoryPort["listPage"]>[0]) {
    const afterSortOrder = input.after?.sortOrder ?? Number.MIN_SAFE_INTEGER;
    const afterId = input.after?.id ?? 0;
    if (await this.targetReady()) {
      const rows = await this.env.DB.prepare(
        `SELECT ${targetColumns}
         FROM agent_nodes n JOIN agent_runtime r ON r.agent_id = n.id
         WHERE n.deleted_at_ms IS NULL
           AND (n.sort_order > ? OR (n.sort_order = ? AND n.id > ?))
         ORDER BY n.sort_order ASC, n.id ASC LIMIT ?`
      )
        .bind(afterSortOrder, afterSortOrder, afterId, input.limit)
        .all<TargetAgentRow>();
      return rows.results.map(targetView);
    }
    const conditions = [isNull(agents.deleted_at)];
    if (input.after !== undefined) {
      conditions.push(
        or(
          gt(agents.sort_order, input.after.sortOrder),
          and(
            eq(agents.sort_order, input.after.sortOrder),
            gt(agents.id, input.after.id)
          )
        )!
      );
    }
    const rows = await this.db
      .select()
      .from(agents)
      .where(and(...conditions))
      .orderBy(asc(agents.sort_order), asc(agents.id))
      .limit(input.limit);
    return rows.map(toView);
  }

  async findById(id: number) {
    if (await this.targetReady()) {
      const row = await this.env.DB.prepare(
        `SELECT ${targetColumns}
         FROM agent_nodes n JOIN agent_runtime r ON r.agent_id = n.id
         WHERE n.id = ? AND n.deleted_at_ms IS NULL LIMIT 1`
      )
        .bind(id)
        .first<TargetAgentRow>();
      return row ? targetView(row) : null;
    }
    const rows = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), isNull(agents.deleted_at)))
      .limit(1);
    return rows[0] ? toView(rows[0]) : null;
  }

  async update(id: number, input: AgentMutation) {
    const current = await this.findById(id);
    if (!current) return null;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const next: AgentView = {
      ...current,
      ...input,
      hostname: input.hostname === undefined ? current.hostname : input.hostname,
      ip_addresses: input.ip_addresses ?? current.ip_addresses,
      os: input.os === undefined ? current.os : input.os,
      version: input.version === undefined ? current.version : input.version,
      status: input.status ?? current.status,
      collect_interval_seconds:
        input.collect_interval_seconds ?? current.collect_interval_seconds,
      report_interval_seconds:
        input.report_interval_seconds ?? current.report_interval_seconds,
      group_name:
        input.group_name === undefined ? current.group_name : input.group_name,
      tags: input.tags ?? current.tags,
      price: input.price === undefined ? current.price : input.price,
      currency: input.currency === undefined ? current.currency : input.currency,
      billing_cycle:
        input.billing_cycle === undefined
          ? current.billing_cycle
          : input.billing_cycle,
      expire_date:
        input.expire_date === undefined ? current.expire_date : input.expire_date,
      auto_renewal: input.auto_renewal ?? current.auto_renewal,
      is_hidden: input.is_hidden ?? current.is_hidden,
      traffic_limit_gb:
        input.traffic_limit_gb === undefined
          ? current.traffic_limit_gb
          : input.traffic_limit_gb,
      traffic_reset_day:
        input.traffic_reset_day ?? current.traffic_reset_day,
      traffic_calc_type:
        input.traffic_calc_type ?? current.traffic_calc_type,
      auto_update: input.auto_update ?? current.auto_update,
      updated_at: now,
    };
    const ipJson = canonicalMigrationJson(next.ip_addresses);
    const tagsJson = canonicalMigrationJson(next.tags);
    const statements = [
      this.env.DB.prepare(
        `INSERT INTO agent_nodes
         (id, name, collect_interval_ms, report_interval_ms, group_name,
          tags_json, price, currency, billing_cycle, expire_date, auto_renewal,
          is_hidden, traffic_limit_gb, traffic_reset_day, traffic_calc_type,
          auto_update, sort_order, created_at_ms, updated_at_ms, deleted_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name,
          collect_interval_ms = excluded.collect_interval_ms,
          report_interval_ms = excluded.report_interval_ms,
          group_name = excluded.group_name, tags_json = excluded.tags_json,
          price = excluded.price, currency = excluded.currency,
          billing_cycle = excluded.billing_cycle, expire_date = excluded.expire_date,
          auto_renewal = excluded.auto_renewal, is_hidden = excluded.is_hidden,
          traffic_limit_gb = excluded.traffic_limit_gb,
          traffic_reset_day = excluded.traffic_reset_day,
          traffic_calc_type = excluded.traffic_calc_type,
          auto_update = excluded.auto_update, sort_order = excluded.sort_order,
          updated_at_ms = excluded.updated_at_ms, deleted_at_ms = NULL`
      ).bind(
        id,
        next.name,
        next.collect_interval_seconds * 1000,
        next.report_interval_seconds * 1000,
        next.group_name,
        tagsJson,
        next.price,
        next.currency,
        next.billing_cycle,
        next.expire_date,
        next.auto_renewal ? 1 : 0,
        next.is_hidden ? 1 : 0,
        next.traffic_limit_gb,
        next.traffic_reset_day,
        next.traffic_calc_type,
        next.auto_update ? 1 : 0,
        next.sort_order,
        Date.parse(current.created_at),
        nowMs
      ),
      this.env.DB.prepare(
        `INSERT INTO agent_runtime
         (agent_id, status, hostname, ip_addresses_json, os, agent_version,
          keepalive_seconds, boot_time, last_seen_at_ms, last_state_changed_at_ms,
          next_offline_at_ms, region, geo_latitude, geo_longitude, geo_city,
          geo_region_name, version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET status = excluded.status,
          hostname = excluded.hostname, ip_addresses_json = excluded.ip_addresses_json,
          os = excluded.os, agent_version = excluded.agent_version,
          version = agent_runtime.version + 1, updated_at_ms = excluded.updated_at_ms`
      ).bind(
        id,
        next.status,
        next.hostname,
        ipJson,
        next.os,
        next.version,
        next.keepalive === null ? null : Number(next.keepalive),
        next.boot_time,
        next.last_seen_at ? Date.parse(next.last_seen_at) : null,
        next.next_offline_at ? Date.parse(next.next_offline_at) : null,
        next.region,
        next.geo_latitude,
        next.geo_longitude,
        next.geo_city,
        next.geo_region_name,
        Date.parse(current.created_at),
        nowMs
      ),
    ];
    if (!isContractMode(this.env)) {
      statements.unshift(
        this.env.DB.prepare(
          `UPDATE agents SET name = ?, hostname = ?, ip_addresses = ?, os = ?,
           version = ?, status = ?, collect_interval = ?, report_interval = ?,
           group_name = ?, tags = ?, auto_update = ?, is_hidden = ?, price = ?,
           currency = ?, billing_cycle = ?, expire_date = ?, auto_renewal = ?,
           traffic_limit_gb = ?, traffic_reset_day = ?, traffic_calc_type = ?,
           updated_at = ? WHERE id = ? AND deleted_at IS NULL`
        ).bind(
          next.name,
          next.hostname,
          ipJson,
          next.os,
          next.version,
          next.status,
          next.collect_interval_seconds,
          next.report_interval_seconds,
          next.group_name,
          next.tags.join(","),
          next.auto_update ? 1 : 0,
          next.is_hidden ? 1 : 0,
          next.price,
          next.currency,
          next.billing_cycle,
          next.expire_date,
          next.auto_renewal ? 1 : 0,
          next.traffic_limit_gb,
          next.traffic_reset_day,
          next.traffic_calc_type,
          now,
          id
        )
      );
      statements.push(this.env.DB.prepare(
        `INSERT INTO legacy_id_map
         (source_table, source_id, target_table, target_id, payload_checksum,
          created_at, updated_at)
         VALUES ('agents', ?, 'agent_nodes', ?, ?, ?, ?)
         ON CONFLICT(source_table, source_id) DO UPDATE SET
          target_table = excluded.target_table, target_id = excluded.target_id,
          payload_checksum = excluded.payload_checksum, updated_at = excluded.updated_at`
      ).bind(
        String(id),
        String(id),
        await migrationSha256Hex(canonicalMigrationJson(next)),
        now,
        now
      ));
    }
    await this.env.DB.batch(statements);
    return next;
  }

  async softDelete(id: number) {
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const statements = [
      this.env.DB.prepare(
        `UPDATE agent_credentials SET revoked_at = ?, updated_at = ?
         WHERE agent_id = ? AND revoked_at IS NULL`
      ).bind(now, now, id),
      this.env.DB.prepare(
        `DELETE FROM status_components
         WHERE component_type = 'agent' AND component_id = ?`
      ).bind(id),
      this.env.DB.prepare(
        `DELETE FROM notification_rules
         WHERE target_type = 'agent' AND target_id = ?`
      ).bind(id),
      this.env.DB.prepare(
        `UPDATE agent_nodes SET deleted_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND deleted_at_ms IS NULL`
      ).bind(nowMs, nowMs, id),
      this.env.DB.prepare(
        `UPDATE agent_runtime SET status = 'inactive', next_offline_at_ms = NULL,
         last_state_changed_at_ms = ?, version = version + 1, updated_at_ms = ?
         WHERE agent_id = ?`
      ).bind(nowMs, nowMs, id),
    ];
    const nodeIndex = 3;
    if (!isContractMode(this.env)) {
      statements.unshift(
        this.env.DB.prepare(
          `DELETE FROM status_page_agents WHERE agent_id = ?`
        ).bind(id),
        this.env.DB.prepare(
          `DELETE FROM legacy_id_map
           WHERE (source_table = 'notification_settings' AND source_id IN (
                    SELECT CAST(id AS TEXT) FROM notification_settings
                    WHERE target_type = 'agent' AND target_id = ?
                  ))
              OR (source_table = 'notification_settings_channels'
                  AND CAST(substr(source_id, 1, instr(source_id, ':') - 1) AS INTEGER) IN (
                    SELECT id FROM notification_settings
                    WHERE target_type = 'agent' AND target_id = ?
                  ))`
        ).bind(id, id),
        this.env.DB.prepare(
          `DELETE FROM notification_settings
           WHERE target_type = 'agent' AND target_id = ?`
        ).bind(id)
      );
      statements.push(
        this.env.DB.prepare(
          `UPDATE agents SET status = 'inactive', token = ?, deleted_at = ?,
           next_offline_at = NULL, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`
        ).bind(`deleted:${id}:${crypto.randomUUID()}`, now, now, id)
      );
    }
    const result = await this.env.DB.batch(statements);
    const offset = isContractMode(this.env) ? 0 : 3;
    return result[nodeIndex + offset].meta.changes === 1;
  }

  async authenticateCredential(input: {
    token: string;
    digest: string;
    now: string;
  }) {
    const credentials = await this.db
      .select({ id: agentCredentials.id, agent_id: agentCredentials.agent_id })
      .from(agentCredentials)
      .where(
        and(
          eq(agentCredentials.token_digest, input.digest),
          isNull(agentCredentials.revoked_at)
        )
      )
      .limit(1);

    let agentId = credentials[0]?.agent_id;
    if (credentials[0]) {
      await this.db
        .update(agentCredentials)
        .set({ last_used_at: input.now, updated_at: input.now })
        .where(eq(agentCredentials.id, credentials[0].id));
    } else if (!isContractMode(this.env)) {
      // Expand 兼容：只有完全缺少 Credential 行的旧 Agent 才读取一次旧明文列。
      const legacy = await this.db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.token, input.token),
            isNull(agents.deleted_at),
            notExists(
              this.db
                .select({ id: agentCredentials.id })
                .from(agentCredentials)
                .where(eq(agentCredentials.agent_id, agents.id))
            )
          )
        )
        .limit(1);
      agentId = legacy[0]?.id;
      if (agentId !== undefined) {
        await this.db
          .insert(agentCredentials)
          .values({
            agent_id: agentId,
            token_digest: input.digest,
            token_hint: tokenHint(input.token),
            last_used_at: input.now,
            revoked_at: null,
            created_at: input.now,
            updated_at: input.now,
          })
          .onConflictDoNothing();
      }
    }

    if (agentId === undefined) return null;
    if (isContractMode(this.env)) {
      const row = await this.env.DB.prepare(
        `SELECT n.id, n.name, r.status, n.collect_interval_ms,
                n.report_interval_ms, n.auto_update
         FROM agent_nodes n
         JOIN agent_runtime r ON r.agent_id = n.id
         WHERE n.id = ? AND n.deleted_at_ms IS NULL LIMIT 1`
      )
        .bind(agentId)
        .first<{
          id: number;
          name: string;
          status: string;
          collect_interval_ms: number;
          report_interval_ms: number;
          auto_update: number;
        }>();
      return row
        ? {
            id: row.id,
            name: row.name,
            status: row.status,
            collect_interval_seconds: Math.max(
              1,
              Math.floor(row.collect_interval_ms / 1000)
            ),
            report_interval_seconds: Math.max(
              1,
              Math.floor(row.report_interval_ms / 1000)
            ),
            auto_update: row.auto_update === 1,
          }
        : null;
    }
    const rows = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), isNull(agents.deleted_at)))
      .limit(1);
    return rows[0] ? toAuthenticated(rows[0]) : null;
  }

  async createReportJob(input: {
    agentId: number;
    report: AgentReportCommand;
    payloadDigest: string;
    receivedAt: string;
  }) {
    const existing = await this.db
      .select({
        agent_id: agentReports.agent_id,
        payload_digest: agentReports.payload_digest,
      })
      .from(agentReports)
      .where(eq(agentReports.report_id, input.report.report_id))
      .limit(1);
    const jobId = `agent-report:${input.report.report_id}`;
    if (existing[0]) {
      return {
        disposition:
          existing[0].agent_id === input.agentId &&
          existing[0].payload_digest === input.payloadDigest
            ? ("duplicate" as const)
            : ("conflict" as const),
        jobId,
      };
    }

    await this.db.batch([
      this.db
        .insert(agentReports)
        .values({
          report_id: input.report.report_id,
          agent_id: input.agentId,
          payload_digest: input.payloadDigest,
          payload_json: JSON.stringify(input.report),
          sample_count: input.report.samples.length,
          status: "pending",
          received_at: input.receivedAt,
          processed_at: null,
          last_error: null,
          created_at: input.receivedAt,
          updated_at: input.receivedAt,
        })
        .onConflictDoNothing(),
      this.db
        .insert(asyncJobs)
        .values({
          id: jobId,
          kind: "agent.report.process",
          dedup_key: jobId,
          aggregate_type: "agent_report",
          aggregate_id: input.report.report_id,
          payload_json: JSON.stringify({ report_id: input.report.report_id }),
          status: "pending",
          attempts: 0,
          max_attempts: 8,
          available_at: input.receivedAt,
          created_at: input.receivedAt,
          updated_at: input.receivedAt,
        })
        .onConflictDoNothing(),
    ]);

    const persisted = await this.db
      .select({
        agent_id: agentReports.agent_id,
        payload_digest: agentReports.payload_digest,
      })
      .from(agentReports)
      .where(eq(agentReports.report_id, input.report.report_id))
      .limit(1);
    return {
      disposition:
        persisted[0]?.agent_id === input.agentId &&
        persisted[0]?.payload_digest === input.payloadDigest
          ? ("created" as const)
          : ("conflict" as const),
      jobId,
    };
  }

  async markJobPublished(jobId: string, publishedAt: string) {
    await this.db
      .update(asyncJobs)
      .set({ updated_at: publishedAt })
      .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.status, "pending")));
  }
}
