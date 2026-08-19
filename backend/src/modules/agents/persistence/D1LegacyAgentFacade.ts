const isContractMode = (env: any) => true;
const hasTableColumn = (env: any, table: string, column: string) => true;
import type { Agent, Metrics } from "../../../models/agent";
import type { Bindings } from "../../../models/db";
import {
  authenticateAgentToken,
  consumeAgentEnrollmentToken,
  createCredentialForAgent,
  generateAgentCredentialToken,
  linkAgentEnrollmentToken,
  releaseAgentEnrollmentToken,
} from "./D1AgentCredentialStore";
import { normalizeAgentMetricsHours } from "../../../utils/agentMetricsHours";
import type { AgentMutation, AgentReportSample, AgentView } from "../domain/models";
import { downsample, queryAgentSamples } from "../metricblock/query";
import type { BlockSample } from "../metricblock/materialize";

import { createAgentUseCases } from "../composition";

export { normalizeAgentMetricsHours } from "../../../utils/agentMetricsHours";

const LEGACY_AGENT_LIST_LIMIT = 500;

interface LatestMetricRow {
  agent_id: number;
  metrics_json: string;
  collected_at: string | null;
  reported_at: string | null;
}

function parseStringArray(value: string | null) {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseLatestMetric(row: LatestMetricRow): Metrics | null {
  try {
    const parsed = JSON.parse(row.metrics_json) as Metrics;
    return {
      ...parsed,
      agent_id: row.agent_id,
      timestamp: parsed.timestamp ?? row.collected_at ?? row.reported_at ?? "",
    };
  } catch {
    return null;
  }
}

function publicAgent(row: Agent) {
  const { token: _token, deleted_at: _deletedAt, ...agent } = row;
  return agent;
}

export async function listLegacyAgents(env: Bindings, includeLatestMetrics: boolean) {
  if (isContractMode(env)) {
    const views: AgentView[] = [];
    let cursor: string | undefined;
    do {
      const remaining = LEGACY_AGENT_LIST_LIMIT - views.length;
      const page = await createAgentUseCases(env).list({
        cursor,
        limit: Math.min(100, remaining),
      });
      views.push(...page.data.slice(0, remaining));
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined && views.length < LEGACY_AGENT_LIST_LIMIT);
    const metrics = includeLatestMetrics
      ? await queryLatestAgentMetricsForIds(
          env,
          views.map((view) => view.id)
        )
      : new Map<number, Metrics>();
    return views.map((view) => ({
      ...toLegacyAgent(view),
      ...(includeLatestMetrics ? { metrics: metrics.get(view.id) ?? null } : {}),
    }));
  }
  const agentRows = await env.DB.prepare(
    `SELECT * FROM agents WHERE deleted_at IS NULL
     ORDER BY sort_order ASC, id ASC LIMIT ?`
  )
    .bind(LEGACY_AGENT_LIST_LIMIT)
    .all<Agent>();
  const metrics = includeLatestMetrics
    ? await queryLatestAgentMetricsForIds(
        env,
        agentRows.results.map((row) => row.id)
      )
    : new Map<number, Metrics>();
  return agentRows.results.map((row) => ({
    ...publicAgent(row),
    ...(includeLatestMetrics ? { metrics: metrics.get(row.id) ?? null } : {}),
  }));
}

export async function getLegacyAgent(env: Bindings, id: number) {
  if (isContractMode(env)) {
    try {
      const view = await createAgentUseCases(env).get(id);
      return {
        ...toLegacyAgent(view),
        ip_addresses: view.ip_addresses.join(", ") || "未知",
      };
    } catch {
      return null;
    }
  }
  const row = await env.DB.prepare(
    `SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL LIMIT 1`
  )
    .bind(id)
    .first<Agent>();
  if (!row) return null;
  return {
    ...publicAgent(row),
    ip_addresses: parseStringArray(row.ip_addresses).join(", ") || "未知",
  };
}

export function toAgentMutation(input: Record<string, unknown>): AgentMutation {
  const mutation: AgentMutation = {};
  if (typeof input.name === "string") mutation.name = input.name;
  if (input.hostname === null || typeof input.hostname === "string") {
    mutation.hostname = input.hostname;
  }
  if (Array.isArray(input.ip_addresses)) {
    mutation.ip_addresses = input.ip_addresses.filter(
      (item): item is string => typeof item === "string"
    );
  }
  if (input.os === null || typeof input.os === "string") mutation.os = input.os;
  if (input.version === null || typeof input.version === "string") {
    mutation.version = input.version;
  }
  if (input.status === null || typeof input.status === "string") {
    mutation.status = input.status;
  }
  if (typeof input.collect_interval === "number") {
    mutation.collect_interval_seconds = input.collect_interval;
  } else if (typeof input.collect_interval_seconds === "number") {
    mutation.collect_interval_seconds = input.collect_interval_seconds;
  }
  if (typeof input.report_interval === "number") {
    mutation.report_interval_seconds = input.report_interval;
  } else if (typeof input.report_interval_seconds === "number") {
    mutation.report_interval_seconds = input.report_interval_seconds;
  }
  if (input.price === null || typeof input.price === "number") mutation.price = input.price;
  if (input.currency === null || typeof input.currency === "string") {
    mutation.currency = input.currency;
  }
  if (input.billing_cycle === null || typeof input.billing_cycle === "string") {
    mutation.billing_cycle = input.billing_cycle;
  }
  if (input.expire_date === null || typeof input.expire_date === "string") {
    mutation.expire_date = input.expire_date;
  }
  if (typeof input.auto_renewal === "number" || typeof input.auto_renewal === "boolean") {
    mutation.auto_renewal = input.auto_renewal === true || input.auto_renewal === 1;
  }
  if (typeof input.is_hidden === "number" || typeof input.is_hidden === "boolean") {
    mutation.is_hidden = input.is_hidden === true || input.is_hidden === 1;
  }
  if (input.traffic_limit_gb === null || typeof input.traffic_limit_gb === "number") {
    mutation.traffic_limit_gb = input.traffic_limit_gb;
  }
  if (typeof input.traffic_reset_day === "number") {
    mutation.traffic_reset_day = input.traffic_reset_day;
  }
  if (typeof input.traffic_calc_type === "string") {
    mutation.traffic_calc_type = input.traffic_calc_type;
  }
  if (typeof input.auto_update === "number" || typeof input.auto_update === "boolean") {
    mutation.auto_update = input.auto_update === true || input.auto_update === 1;
  }
  if (input.group_name === null || typeof input.group_name === "string") {
    mutation.group_name = input.group_name;
  }
  if (Array.isArray(input.tags)) {
    mutation.tags = input.tags.filter((tag): tag is string => typeof tag === "string");
  } else if (input.tags === null || typeof input.tags === "string") {
    mutation.tags = String(input.tags ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return mutation;
}

export function toLegacyAgent(view: AgentView) {
  return {
    ...view,
    ip_addresses: JSON.stringify(view.ip_addresses),
    collect_interval: view.collect_interval_seconds,
    report_interval: view.report_interval_seconds,
    tags: view.tags.join(","),
    auto_renewal: view.auto_renewal ? 1 : 0,
    is_hidden: view.is_hidden ? 1 : 0,
    auto_update: view.auto_update ? 1 : 0,
  };
}

export async function updateLegacyAgentOrder(env: Bindings, ids: number[]) {
  const uniqueIds = [...new Set(ids)];
  const contractMode = isContractMode(env);
  const row = await env.DB.prepare(
    contractMode
      ? `SELECT COUNT(*) AS count FROM agent_nodes
     WHERE deleted_at_ms IS NULL
       AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`
      : `SELECT COUNT(*) AS count FROM agents
     WHERE deleted_at IS NULL
       AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`
  )
    .bind(JSON.stringify(uniqueIds))
    .first<{ count: number }>();
  if (Number(row?.count ?? 0) !== uniqueIds.length) return false;
  for (let offset = 0; offset < uniqueIds.length; offset += 50) {
    const now = new Date().toISOString();
    await env.DB.batch(
      uniqueIds.slice(offset, offset + 50).flatMap((id, index) => {
        const statements = [env.DB.prepare(
          `UPDATE agent_nodes SET sort_order = ?, updated_at_ms = ? WHERE id = ?`
        ).bind(offset + index, Date.parse(now), id)];
        if (!contractMode) {
          statements.unshift(env.DB.prepare(
            `UPDATE agents SET sort_order = ?, updated_at = ? WHERE id = ?`
          ).bind(offset + index, now, id));
        }
        return statements;
      })
    );
    if (!contractMode) {
      for (const id of uniqueIds.slice(offset, offset + 50)) {
        null;
      }
    }
  }
  return true;
}

export function toAgentExportRecord(agent: {
  name: string;
  hostname?: string | null;
  os?: string | null;
  version?: string | null;
  collect_interval?: number | null;
  report_interval?: number | null;
  price?: number | null;
  currency?: string | null;
  billing_cycle?: string | null;
  expire_date?: string | null;
  auto_renewal?: number | null;
  is_hidden?: number | null;
  traffic_limit_gb?: number | null;
  traffic_reset_day?: number | null;
  traffic_calc_type?: string | null;
  auto_update?: number | null;
  group_name?: string | null;
  tags?: string | null;
  sort_order?: number | null;
}) {
  return {
    name: agent.name,
    hostname: agent.hostname ?? null,
    os: agent.os ?? null,
    version: agent.version ?? null,
    collect_interval: agent.collect_interval ?? null,
    report_interval: agent.report_interval ?? null,
    price: agent.price ?? null,
    currency: agent.currency ?? null,
    billing_cycle: agent.billing_cycle ?? null,
    expire_date: agent.expire_date ?? null,
    auto_renewal: agent.auto_renewal ?? 0,
    is_hidden: agent.is_hidden ?? 0,
    traffic_limit_gb: agent.traffic_limit_gb ?? null,
    traffic_reset_day: agent.traffic_reset_day ?? 1,
    traffic_calc_type: agent.traffic_calc_type ?? "sum",
    auto_update: agent.auto_update ?? 0,
    group_name: agent.group_name ?? null,
    tags: agent.tags ?? null,
    sort_order: agent.sort_order ?? 0,
  };
}

async function insertAgent(
  env: Bindings,
  input: {
    name: string;
    token: string;
    status: string;
    hostname?: string | null;
    ip_addresses?: string[] | null;
    os?: string | null;
    version?: string | null;
  }
) {
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const contractMode = isContractMode(env);
  const legacyColumnsPresent = await hasTableColumn(env, "agents", "token");
  const contractAnchorPresent =
    contractMode &&
    !legacyColumnsPresent &&
    (await hasTableColumn(env, "agents", "anchor_nonce"));
  const identityInsert = contractMode
    ? legacyColumnsPresent
      ? env.DB.prepare(
          `INSERT INTO agents
           (name, token, status, hostname, ip_addresses, os, version,
            last_seen_at, last_state_changed_at, created_at, updated_at)
           VALUES (?, ?, 'retired', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
           RETURNING id`
        ).bind(
          `contract-anchor:${crypto.randomUUID()}`,
          `contract-anchor:${crypto.randomUUID()}`,
          now,
          now
        )
      : contractAnchorPresent
        ? env.DB.prepare(
            `INSERT INTO agents(anchor_nonce, created_at, updated_at)
             VALUES (?, ?, ?) RETURNING id`
          ).bind(`contract-anchor:${crypto.randomUUID()}`, now, now)
        : env.DB.prepare(
            `INSERT INTO agents(created_at, updated_at) VALUES (?, ?) RETURNING id`
          ).bind(now, now)
    : env.DB.prepare(
        `INSERT INTO agents
         (name, token, status, hostname, ip_addresses, os, version, last_seen_at,
          last_state_changed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).bind(
        input.name,
        input.token,
        input.status,
        input.hostname ?? null,
        input.ip_addresses ? JSON.stringify(input.ip_addresses) : null,
        input.os ?? null,
        input.version ?? null,
        now,
        now,
        now,
        now
      );
  const row = await identityInsert.first<{ id: number }>();
  if (!row) throw new Error("创建客户端失败");
  try {
    if (contractMode) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO agent_nodes
           (id, name, collect_interval_ms, report_interval_ms, group_name,
            tags_json, price, currency, billing_cycle, expire_date,
            auto_renewal, is_hidden, traffic_limit_gb, traffic_reset_day,
            traffic_calc_type, auto_update, sort_order, created_at_ms,
            updated_at_ms, deleted_at_ms)
           VALUES (?, ?, 1000, 60000, NULL, '[]', NULL, 'USD', NULL, NULL,
                   0, 0, NULL, 1, 'sum', 0, 0, ?, ?, NULL)`
        ).bind(row.id, input.name, nowMs, nowMs),
        env.DB.prepare(
          `INSERT INTO agent_runtime
           (agent_id, status, hostname, ip_addresses_json, os, agent_version,
            keepalive_seconds, boot_time, last_seen_at_ms,
            last_state_changed_at_ms, next_offline_at_ms, region,
            geo_latitude, geo_longitude, geo_city, geo_region_name, version,
            created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL,
                   NULL, NULL, 0, ?, ?)`
        ).bind(
          row.id,
          input.status,
          input.hostname ?? null,
          JSON.stringify(input.ip_addresses ?? []),
          input.os ?? null,
          input.version ?? null,
          nowMs,
          nowMs,
          nowMs,
          nowMs
        ),
      ]);
    } else {
      null;
    }
  } catch (error) {
    await env.DB.prepare(`DELETE FROM agents WHERE id = ?`).bind(row.id).run();
    throw error;
  }
  return row.id;
}

export async function registerAgent(
  env: Bindings,
  input: {
    token: string;
    name: string;
    hostname?: string | null;
    ip_addresses?: string[] | null;
    os?: string | null;
    version?: string | null;
  }
) {
  const existing = await authenticateAgentToken(env, input.token);
  if (existing) return { id: existing.id, created: false };
  const enrollment = await consumeAgentEnrollmentToken(env, input.token);
  if (!enrollment) return null;
  try {
    const id = await insertAgent(env, { ...input, status: "active" });
    await createCredentialForAgent(env, id, input.token);
    await linkAgentEnrollmentToken(env, enrollment.id, id);
    return { id, created: true };
  } catch (error) {
    await releaseAgentEnrollmentToken(env, enrollment.id);
    throw error;
  }
}

// v1 Adapter 在 Expand 窗口内复用同一注册实现。
export const registerLegacyAgent = registerAgent;

export async function importLegacyAgents(
  env: Bindings,
  items: Array<Record<string, unknown> & { name: string; token?: string }>
) {
  const candidateNames = [...new Set(items.map((item) => item.name))];
  const existingRows = await env.DB.prepare(
    isContractMode(env)
      ? `SELECT name FROM agent_nodes
         WHERE deleted_at_ms IS NULL
           AND name IN (SELECT value FROM json_each(?))`
      : `SELECT name FROM agents
         WHERE deleted_at IS NULL
           AND name IN (SELECT value FROM json_each(?))`
  )
    .bind(JSON.stringify(candidateNames))
    .all<{ name: string }>();
  const existingNames = new Set(existingRows.results.map((row) => row.name));
  let created = 0;
  let skipped = 0;
  const issuedCredentials: Array<{ name: string; token: string }> = [];
  for (const item of items) {
    if (existingNames.has(item.name)) {
      skipped += 1;
      continue;
    }
    let token = item.token ?? "";
    let generated = false;
    if (!token || (await authenticateAgentToken(env, token))) {
      token = generateAgentCredentialToken();
      generated = true;
    }
    const id = await insertAgent(env, {
      name: item.name,
      token,
      status: "inactive",
      hostname: typeof item.hostname === "string" ? item.hostname : null,
      ip_addresses: Array.isArray(item.ip_addresses)
        ? item.ip_addresses.filter((value): value is string => typeof value === "string")
        : null,
      os: typeof item.os === "string" ? item.os : null,
      version: typeof item.version === "string" ? item.version : null,
    });
    await createCredentialForAgent(env, id, token);
    const mutation = toAgentMutation(item);
    if (isContractMode(env)) {
      if (Object.keys(mutation).length > 0) {
        await createAgentUseCases(env).update(id, mutation);
      }
      if (typeof item.sort_order === "number") {
        await env.DB.prepare(
          `UPDATE agent_nodes SET sort_order = ?, updated_at_ms = ? WHERE id = ?`
        )
          .bind(item.sort_order, Date.now(), id)
          .run();
      }
    } else {
      const updates: string[] = [];
      const bindings: unknown[] = [];
      const add = (column: string, value: unknown) => {
        updates.push(`${column} = ?`);
        bindings.push(value);
      };
      if (mutation.collect_interval_seconds !== undefined) add("collect_interval", mutation.collect_interval_seconds);
      if (mutation.report_interval_seconds !== undefined) add("report_interval", mutation.report_interval_seconds);
      if (mutation.price !== undefined) add("price", mutation.price);
      if (mutation.currency !== undefined) add("currency", mutation.currency);
      if (mutation.billing_cycle !== undefined) add("billing_cycle", mutation.billing_cycle);
      if (mutation.expire_date !== undefined) add("expire_date", mutation.expire_date);
      if (mutation.auto_renewal !== undefined) add("auto_renewal", mutation.auto_renewal ? 1 : 0);
      if (mutation.is_hidden !== undefined) add("is_hidden", mutation.is_hidden ? 1 : 0);
      if (mutation.traffic_limit_gb !== undefined) add("traffic_limit_gb", mutation.traffic_limit_gb);
      if (mutation.traffic_reset_day !== undefined) add("traffic_reset_day", mutation.traffic_reset_day);
      if (mutation.traffic_calc_type !== undefined) add("traffic_calc_type", mutation.traffic_calc_type);
      if (mutation.auto_update !== undefined) add("auto_update", mutation.auto_update ? 1 : 0);
      if (mutation.group_name !== undefined) add("group_name", mutation.group_name);
      if (mutation.tags !== undefined) add("tags", mutation.tags.join(","));
      if (typeof item.sort_order === "number") add("sort_order", item.sort_order);
      if (updates.length > 0) {
        add("updated_at", new Date().toISOString());
        await env.DB.prepare(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`)
          .bind(...bindings, id)
          .run();
      }
      null;
    }
    if (generated) issuedCredentials.push({ name: item.name, token });
    existingNames.add(item.name);
    created += 1;
  }
  return { created, skipped, issuedCredentials };
}

/** 仪表盘历史图返回的点数上限。 */
const DASHBOARD_CHART_POINTS = 160;

export async function queryLegacyAgentMetrics(env: Bindings, agentId: number, hours: number) {
  const contractMode = isContractMode(env);
  const agent = await env.DB.prepare(
    contractMode
      ? `SELECT 1 AS ok FROM agent_nodes
         WHERE id = ? AND deleted_at_ms IS NULL LIMIT 1`
      : `SELECT 1 AS ok FROM agents
         WHERE id = ? AND deleted_at IS NULL LIMIT 1`
  )
    .bind(agentId)
    .first<{ ok: number }>();
  if (!agent) return null;

  const toSec = Math.floor(Date.now() / 1000);
  const fromSec = toSec - hours * 3600;
  const { samples } = await queryAgentSamples(env, agentId, fromSec, toSec);

  return downsample(
    samples.map((sample) => blockSampleToMetrics(agentId, sample)),
    DASHBOARD_CHART_POINTS
  );
}

/** 把还原出的块样本映射成仪表盘沿用的 Metrics 形状。 */
function blockSampleToMetrics(agentId: number, sample: BlockSample): Metrics {
  return {
    agent_id: agentId,
    timestamp: new Date(sample.timestampMs).toISOString(),
    cpu_usage: sample.cpuUsage ?? undefined,
    // CPU 型号与核数属于静态元数据，不入块；历史图不需要，留空
    memory_total: sample.memoryTotal,
    memory_used: sample.memoryUsed ?? undefined,
    memory_free: sample.memoryFree ?? undefined,
    memory_usage_rate: sample.memoryUsageRate ?? undefined,
    load_1: sample.load1 ?? undefined,
    load_5: sample.load5 ?? undefined,
    load_15: sample.load15 ?? undefined,
    disk_metrics: JSON.stringify(
      sample.disks.map((disk) => ({
        mount_point: disk.mountPoint,
        total: disk.total,
        used: disk.used,
        free: disk.free,
        usage_rate: disk.usageRate,
      }))
    ),
    network_metrics: JSON.stringify(
      sample.nets.map((net) => ({
        interface: net.iface,
        bytes_sent: net.bytesSent,
        bytes_recv: net.bytesRecv,
        packets_sent: net.packetsSent,
        packets_recv: net.packetsRecv,
      }))
    ),
    swap_total: sample.swapTotal,
    swap_used: sample.swapUsed ?? undefined,
    process_count: sample.processCount ?? undefined,
    tcp_connections: sample.tcpConnections ?? undefined,
    udp_connections: sample.udpConnections ?? undefined,
    ping_json: JSON.stringify(
      Object.fromEntries(
        sample.pings.map((ping) => [
          ping.key,
          { latency_ms: ping.latencyMs, loss: ping.loss },
        ])
      )
    ),
    ipv4_reachable:
      sample.ipv4Reachable === null ? undefined : sample.ipv4Reachable ? 1 : 0,
    ipv6_reachable:
      sample.ipv6Reachable === null ? undefined : sample.ipv6Reachable ? 1 : 0,
  } as Metrics;
}

export async function queryLatestLegacyAgentMetric(env: Bindings, agentId: number) {
  const contractMode = isContractMode(env);
  const exists = await env.DB.prepare(
    contractMode
      ? `SELECT id FROM agent_nodes WHERE id = ? AND deleted_at_ms IS NULL LIMIT 1`
      : `SELECT id FROM agents WHERE id = ? AND deleted_at IS NULL LIMIT 1`
  )
    .bind(agentId)
    .first<{ id: number }>();
  if (!exists) return null;
  const row = await env.DB.prepare(
    `SELECT agent_id, metrics_json,
            CASE WHEN collected_at_ms IS NULL THEN NULL
                 ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                               collected_at_ms / 1000.0, 'unixepoch') END
              AS collected_at,
            strftime('%Y-%m-%dT%H:%M:%fZ',
                     reported_at_ms / 1000.0, 'unixepoch') AS reported_at
     FROM agent_current_metrics WHERE agent_id = ? LIMIT 1`
  )
    .bind(agentId)
    .first<LatestMetricRow>();
  return row ? parseLatestMetric(row) : undefined;
}

export async function queryLatestAgentMetricsForIds(
  env: Bindings,
  agentIds: number[]
) {
  if (agentIds.length === 0) return new Map<number, Metrics>();
  const rows = await env.DB.prepare(
    `SELECT agent_id, metrics_json,
            CASE WHEN collected_at_ms IS NULL THEN NULL
                 ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                               collected_at_ms / 1000.0, 'unixepoch') END
              AS collected_at,
            strftime('%Y-%m-%dT%H:%M:%fZ',
                     reported_at_ms / 1000.0, 'unixepoch') AS reported_at
     FROM agent_current_metrics
     WHERE agent_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`
  )
    .bind(JSON.stringify(agentIds))
    .all<LatestMetricRow>();
  const metrics = new Map<number, Metrics>();
  for (const row of rows.results) {
    const parsed = parseLatestMetric(row);
    if (parsed) metrics.set(row.agent_id, parsed);
  }
  return metrics;
}
