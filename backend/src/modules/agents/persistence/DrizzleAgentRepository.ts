import { and, asc, eq, gt, isNull, notExists, or } from "drizzle-orm";
import type { AppDatabase } from "../../../config/db";
import type { Bindings } from "../../../models/db";

import {
  agentCredentials,
  agentReports,
  agents,
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
    report_interval_seconds: row.report_interval ?? 60,
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
    report_interval_seconds: row.report_interval ?? 60,
    auto_update: row.auto_update === 1,
  };
}

export class DrizzleAgentRepository implements AgentRepositoryPort {
  constructor(
    private readonly env: Bindings,
    private readonly db: AppDatabase
  ) {}

  async listPage(input: Parameters<AgentRepositoryPort["listPage"]>[0]) {
    const afterSortOrder = input.after?.sortOrder ?? Number.MIN_SAFE_INTEGER;
    const afterId = input.after?.id ?? 0;
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

  async findById(id: number) {
    const row = await this.env.DB.prepare(
      `SELECT ${targetColumns}
       FROM agent_nodes n JOIN agent_runtime r ON r.agent_id = n.id
       WHERE n.id = ? AND n.deleted_at_ms IS NULL LIMIT 1`
    )
      .bind(id)
      .first<TargetAgentRow>();
    return row ? targetView(row) : null;
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
    const ipJson = "";
    const tagsJson = "";
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
    const result = await this.env.DB.batch(statements);
    return result[nodeIndex].meta.changes === 1;
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
    }
    if (agentId === undefined) return null;
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


}
