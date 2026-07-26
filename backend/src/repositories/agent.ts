import { Agent, Metrics } from "../models/agent";
import {
  agents,
  agentLatestMetrics,
  agentMetricRollups,
  agentMetrics24h,
  agentMetricsHistory,
} from "../db/schema";
import { db } from "../config";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { tableExists } from "../db/introspect";
import {
  DEFAULT_AGENT_METRICS_HOURS,
  HISTORY_MAX_PARTITION_ID,
  MAX_HISTORY_POINTS,
  buildHistoryId,
  getHistoryIdRange,
  getLastRotationTime,
  normalizeHistoryPartitionId,
} from "../utils/historyId";
import {
  AGENTS_LIST_TTL_MS,
  AGENT_LATEST_TTL_MS,
  agentHistoryCache,
  agentLatestCache,
  agentsListCache,
  getCachedHistoryOldTableExists,
  getHistoryCacheTtlMs,
  invalidateAgentHistoryCache,
  invalidateAgentLatestCache,
  invalidateAgentsListCache,
  setCachedHistoryOldTableExists,
} from "../utils/memCache";
/**
 * 客户端相关的数据库操作
 */

function getTwentyFourHoursAgo() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function parseMetricsJson(row: typeof agentLatestMetrics.$inferSelect) {
  try {
    const parsed = JSON.parse(row.metrics_json) as Metrics;
    return {
      ...parsed,
      agent_id: row.agent_id,
      timestamp: parsed.timestamp ?? row.collected_at ?? row.reported_at,
    };
  } catch {
    return {
      agent_id: row.agent_id,
      timestamp: row.collected_at ?? row.reported_at,
      cpu_usage: row.cpu_usage,
      memory_usage_rate: row.memory_usage_rate,
      disk_metrics: "[]",
      network_metrics: "[]",
    } satisfies Metrics;
  }
}

function getMaxDiskUsage(metric: Metrics) {
  try {
    const disks = JSON.parse(metric.disk_metrics || "[]") as Array<{
      usage_rate?: number;
    }>;
    return disks.reduce<number | null>((max, disk) => {
      if (typeof disk.usage_rate !== "number") return max;
      return max === null ? disk.usage_rate : Math.max(max, disk.usage_rate);
    }, null);
  } catch {
    return null;
  }
}

// 获取所有客户端（isolate 内存缓存 60s；增删改/状态变化时主动失效）
export async function getAllAgents(userId: number) {
  const cacheKey = `list:${userId}`;
  const cached = agentsListCache.get(cacheKey);
  if (cached) {
    return cached as (typeof agents.$inferSelect)[];
  }

  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.created_by, userId))
    .orderBy(asc(agents.sort_order), asc(agents.id));
  agentsListCache.set(cacheKey, rows, AGENTS_LIST_TTL_MS);
  return rows;
}

// 按给定 id 顺序批量写 sort_order（归属权已在服务层校验）
export async function updateAgentsOrder(ids: number[]) {
  await Promise.all(
    ids.map((id, index) =>
      db.update(agents).set({ sort_order: index }).where(eq(agents.id, id))
    )
  );
  invalidateAgentsListCache();
}

// 批量获取客户端详情
export async function getAgentsByIds(agentIds: number[]) {
  if (agentIds.length === 0) {
    return { results: [] };
  }
  return await db.select().from(agents).where(inArray(agents.id, agentIds));
}

// 批量获取指定用户的客户端详情
export async function getAgentsByIdsForUser(
  agentIds: number[],
  userId: number
) {
  if (agentIds.length === 0) {
    return [];
  }

  return await db
    .select()
    .from(agents)
    .where(and(inArray(agents.id, agentIds), eq(agents.created_by, userId)));
}

// 无最新指标的负缓存哨兵：短期内不为无数据的 agent 反复回源
const LATEST_METRIC_MISSING = Symbol("latest-metric-missing");

// 批量获取每个客户端的最新指标（DB 部分按 agent 键控缓存 30s，上报只失效自己那个键；
// DO 实时数据在服务层另行合并，不进缓存）
export async function getLatestAgentMetricsByIds(agentIds: number[]) {
  if (agentIds.length === 0) {
    return [];
  }

  const result: Metrics[] = [];
  const missingIds: number[] = [];
  for (const id of new Set(agentIds)) {
    const cached = agentLatestCache.get(`latest:${id}`);
    if (cached === LATEST_METRIC_MISSING) continue;
    if (cached) {
      result.push(cached as Metrics);
    } else {
      missingIds.push(id);
    }
  }

  if (missingIds.length === 0) {
    return result;
  }

  const latestRows = await db
    .select()
    .from(agentLatestMetrics)
    .where(inArray(agentLatestMetrics.agent_id, missingIds));

  const foundIds = new Set<number>();
  for (const row of latestRows) {
    const metric = parseMetricsJson(row);
    foundIds.add(row.agent_id);
    agentLatestCache.set(`latest:${row.agent_id}`, metric, AGENT_LATEST_TTL_MS);
    result.push(metric);
  }

  const fallbackIds = missingIds.filter((id) => !foundIds.has(id));
  if (fallbackIds.length > 0) {
    // 兜底：agent_latest_metrics 缺失时从历史分区表补一条最新记录
    const fallbackRows = await Promise.all(
      fallbackIds.map((agentId) => getLatestHistoryMetric(agentId))
    );
    fallbackIds.forEach((agentId, index) => {
      const row = fallbackRows[index];
      if (row) {
        agentLatestCache.set(`latest:${agentId}`, row, AGENT_LATEST_TTL_MS);
        result.push(row);
      } else {
        agentLatestCache.set(
          `latest:${agentId}`,
          LATEST_METRIC_MISSING,
          AGENT_LATEST_TTL_MS
        );
      }
    });
  }

  return result;
}

// 获取单个客户端详情
export async function getAgentById(id: number): Promise<Agent | null> {
  const agent = await db
    .select()
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  if (!agent || agent.length === 0) {
    return null;
  }

  return agent[0];
}

// 创建新客户端
export async function createAgent(
  name: string,
  token: string,
  createdBy: number,
  status: string = "inactive",
  hostname: string | null = null,
  os: string | null = null,
  version: string | null = null,
  ipAddresses: string[] | null = null,
  keepalive: string | null = null
) {
  const now = new Date().toISOString();

  // 将 ipAddresses 数组转换为 JSON 字符串
  const ipAddressesJson = ipAddresses ? JSON.stringify(ipAddresses) : null;

  const result = await db
    .insert(agents)
    .values({
      name,
      token,
      created_by: createdBy,
      status,
      created_at: now,
      updated_at: now,
      hostname,
      ip_addresses: ipAddressesJson,
      os,
      version,
      keepalive,
      last_seen_at: now,
      last_state_changed_at: now,
      next_offline_at: null,
    })
    .returning();

  if (!result) {
    throw new Error("创建客户端失败");
  }

  const newAgent = result[0];
  invalidateAgentsListCache();

  // 注册时即分配历史分区 ID；失败不阻塞注册（上报时会重试分配）
  try {
    const partitionId = await ensureAgentHistoryPartition(newAgent.id);
    if (partitionId) {
      newAgent.history_partition_id = partitionId;
    }
  } catch (error) {
    console.error("分配历史分区 ID 失败:", error);
  }

  return newAgent;
}

/**
 * 确保客户端已分配历史分区 ID（1-900）。
 * 分配策略：当前最大值 +1；超过上限时回退为扫描第一个空闲 ID。
 * 并发冲突用带守卫条件的单条 UPDATE + 重试解决。
 */
export async function ensureAgentHistoryPartition(
  agentId: number
): Promise<number | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await db
      .select({ history_partition_id: agents.history_partition_id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!rows[0]) {
      return null;
    }

    const current = normalizeHistoryPartitionId(rows[0].history_partition_id);
    if (current) {
      return current;
    }

    const maxRows = (await db.all(
      sql`SELECT COALESCE(MAX(history_partition_id), 0) AS max_id FROM agents`
    )) as Array<{ max_id: number }>;
    let candidate: number | null = Number(maxRows[0]?.max_id ?? 0) + 1;

    if (candidate > HISTORY_MAX_PARTITION_ID) {
      // 分区号用尽时回收已删除客户端留下的空洞
      const usedRows = (await db.all(
        sql`SELECT history_partition_id AS pid FROM agents WHERE history_partition_id > 0`
      )) as Array<{ pid: number }>;
      const used = new Set(usedRows.map((row) => Number(row.pid)));
      candidate = null;
      for (let id = 1; id <= HISTORY_MAX_PARTITION_ID; id++) {
        if (!used.has(id)) {
          candidate = id;
          break;
        }
      }
      if (!candidate) {
        console.error("历史分区 ID 已用尽（最大 900）");
        return null;
      }
    }

    // 单条带守卫的 UPDATE：目标行仍未分配且候选 ID 未被其他行占用时才生效
    await db.run(sql`
      UPDATE agents SET history_partition_id = ${candidate}
      WHERE id = ${agentId}
        AND COALESCE(history_partition_id, 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM agents
          WHERE history_partition_id = ${candidate} AND id != ${agentId}
        )
    `);

    const verify = await db
      .select({ history_partition_id: agents.history_partition_id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    const assigned = normalizeHistoryPartitionId(
      verify[0]?.history_partition_id
    );
    if (assigned) {
      invalidateAgentsListCache();
      return assigned;
    }
  }

  return null;
}

// 更新客户端信息
export async function updateAgent(agent: Agent) {
  agent.updated_at = new Date().toISOString();

  // 从 agent 对象中排除 id 等索引相关属性，避免更新主键
  const { id, token, created_by, ...updateData } = agent;

  try {
    // 确保 updateData 中不包含 id
    const updatedAgent = await db
      .update(agents)
      .set(updateData)
      .where(eq(agents.id, id))
      .returning();
    invalidateAgentsListCache();
    return updatedAgent[0];
  } catch (error) {
    console.error("更新客户端失败:", error);
    throw new Error("更新客户端失败");
  }
}

// 删除某分区在主表/轮换旧表中的全部历史行（旧表不存在时优雅降级）
async function deleteAgentHistoryRows(
  partitionId: number | null | undefined
) {
  const normalized = normalizeHistoryPartitionId(partitionId);
  if (!normalized) {
    return;
  }
  const { startId, endId } = getHistoryIdRange(normalized);
  await db
    .delete(agentMetricsHistory)
    .where(
      and(
        gte(agentMetricsHistory.id, startId),
        lte(agentMetricsHistory.id, endId)
      )
    );
  try {
    await db.run(
      sql.raw(
        `DELETE FROM agent_metrics_history_old WHERE id BETWEEN ${startId} AND ${endId}`
      )
    );
  } catch {
    // agent_metrics_history_old 不存在时忽略
  }
}

// 删除客户端
export async function deleteAgent(id: number) {
  try {
    const agent = await getAgentById(id);
    // 先删除关联的指标数据
    await deleteAgentHistoryRows(agent?.history_partition_id);
    await db.delete(agentMetrics24h).where(eq(agentMetrics24h.agent_id, id));
    await db.delete(agentMetricRollups).where(eq(agentMetricRollups.agent_id, id));
    await db.delete(agentLatestMetrics).where(eq(agentLatestMetrics.agent_id, id));
    // 再删除客户端
    await db.delete(agents).where(eq(agents.id, id));

    invalidateAgentsListCache();
    invalidateAgentLatestCache(id);
    invalidateAgentHistoryCache(id);
  } catch (error) {
    console.error("删除客户端失败:", error);
    throw new Error("删除客户端失败");
  }

  return { success: true, message: "客户端已删除" };
}

// 新增：根据用户ID删除客户端
export async function deleteAgentsByUserId(userId: number) {
  const userAgents = await getAllAgents(userId);
  // fix: 为参数 'a' 明确添加 Agent 类型
  const agentIds = userAgents.map((a: Agent) => a.id);

  if (agentIds.length === 0) {
    return;
  }

  // 删除各客户端的分区历史行
  for (const agent of userAgents) {
    await deleteAgentHistoryRows(agent.history_partition_id);
  }

  // 批量删除关联的指标数据
  await db.delete(agentMetrics24h).where(inArray(agentMetrics24h.agent_id, agentIds));
  await db.delete(agentMetricRollups).where(inArray(agentMetricRollups.agent_id, agentIds));
  await db.delete(agentLatestMetrics).where(inArray(agentLatestMetrics.agent_id, agentIds));

  // 批量删除客户端
  await db.delete(agents).where(inArray(agents.id, agentIds));

  invalidateAgentsListCache();
  invalidateAgentLatestCache();
  invalidateAgentHistoryCache();
}


// 通过令牌获取客户端
export async function getAgentByToken(token: string) {
  const agent = await db.select().from(agents).where(eq(agents.token, token));
  return agent[0];
}

// 获取活跃状态的客户端
export async function getActiveAgents() {
  const activeAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.status, "active"));
  return activeAgents;
}

export async function getAgentsToMarkOffline(limit: number) {
  const now = new Date().toISOString();

  const dueAgents = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.status, "active"),
        lte(agents.next_offline_at, now)
      )
    )
    .orderBy(asc(agents.next_offline_at))
    .limit(limit);

  return dueAgents;
}

// 设置客户端为离线状态
export async function setAgentInactive(id: number) {
  const now = new Date().toISOString();

  const result = await db
    .update(agents)
    .set({
      status: "inactive",
      updated_at: now,
      last_state_changed_at: now,
      next_offline_at: null,
    })
    .where(eq(agents.id, id));

  invalidateAgentsListCache();
  return result;
}

export async function updateAgentHeartbeat(
  id: number,
  data: {
    lastSeenAt: string;
    nextOfflineAt: string;
    keepalive?: string | null;
    statusChanged: boolean;
  }
) {
  const updateData: Partial<typeof agents.$inferInsert> = {
    status: "active",
    keepalive: data.keepalive,
    last_seen_at: data.lastSeenAt,
    next_offline_at: data.nextOfflineAt,
  };

  if (data.statusChanged) {
    updateData.last_state_changed_at = data.lastSeenAt;
    updateData.updated_at = data.lastSeenAt;
  }

  const result = await db
    .update(agents)
    .set(updateData)
    .where(eq(agents.id, id));

  // 心跳仅更新 last_seen/next_offline，状态变化时才失效列表缓存，保持缓存命中率
  if (data.statusChanged) {
    invalidateAgentsListCache();
  }
  return result;
}

/**
 * 写入历史分区表（每次上报只写 1 行）。
 * 主键 = partitionId * 10^13 + YYMMDDHHmmss；同秒重复上报用 upsert 覆盖处理冲突。
 *
 * ⚠️ 列映射与 db/schema.ts 的 agentMetricsHistory 保持同步：
 * schema 增删列时必须同步更新此处与 queryHistoryRows 的聚合 SELECT 列清单
 * （轮换建表 DDL 已由 schema 运行时生成，不需要手动同步）。
 */
export async function insertAgentMetricsHistory(
  partitionId: number,
  metric: Metrics
) {
  const values: typeof agentMetricsHistory.$inferInsert = {
    id: buildHistoryId(partitionId, metric.timestamp),
    agent_id: metric.agent_id,
    timestamp: metric.timestamp,
    cpu_usage: metric.cpu_usage,
    cpu_cores: metric.cpu_cores,
    cpu_model: metric.cpu_model,
    memory_total: metric.memory_total,
    memory_used: metric.memory_used,
    memory_free: metric.memory_free,
    memory_usage_rate: metric.memory_usage_rate,
    load_1: metric.load_1,
    load_5: metric.load_5,
    load_15: metric.load_15,
    disk_metrics: metric.disk_metrics,
    network_metrics: metric.network_metrics,
    swap_total: metric.swap_total,
    swap_used: metric.swap_used,
    process_count: metric.process_count,
    tcp_connections: metric.tcp_connections,
    udp_connections: metric.udp_connections,
    ping_json: metric.ping_json,
    ipv4_reachable: metric.ipv4_reachable,
    ipv6_reachable: metric.ipv6_reachable,
    network_rx_speed: metric.network_rx_speed ?? null,
    network_tx_speed: metric.network_tx_speed ?? null,
  };

  const { id, ...updateValues } = values;
  return await db
    .insert(agentMetricsHistory)
    .values(values)
    .onConflictDoUpdate({
      target: agentMetricsHistory.id,
      set: updateValues,
    });
}

/** 月流量累计状态（agent_latest_metrics 行上的流量列 + 上次采集时间） */
export interface AgentTrafficStateRow {
  month_rx: number | null;
  month_tx: number | null;
  last_total_rx: number | null;
  last_total_tx: number | null;
  month_reset_at: string | null;
  collected_at: string | null;
}

// 读取某客户端的月流量累计状态（上报热路径专用，单主键 SELECT，不进缓存）
export async function getAgentTrafficState(
  agentId: number
): Promise<AgentTrafficStateRow | null> {
  const rows = await db
    .select({
      month_rx: agentLatestMetrics.month_rx,
      month_tx: agentLatestMetrics.month_tx,
      last_total_rx: agentLatestMetrics.last_total_rx,
      last_total_tx: agentLatestMetrics.last_total_tx,
      month_reset_at: agentLatestMetrics.month_reset_at,
      collected_at: agentLatestMetrics.collected_at,
    })
    .from(agentLatestMetrics)
    .where(eq(agentLatestMetrics.agent_id, agentId))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertAgentLatestMetric(
  metric: Metrics,
  trafficState?: {
    month_rx: number;
    month_tx: number;
    last_total_rx: number | null;
    last_total_tx: number | null;
    month_reset_at: string | null;
  }
) {
  const now = new Date().toISOString();
  const diskUsage = getMaxDiskUsage(metric);
  const values = {
    agent_id: metric.agent_id,
    metrics_json: JSON.stringify(metric),
    collected_at: metric.timestamp,
    reported_at: now,
    cpu_usage: metric.cpu_usage,
    memory_usage_rate: metric.memory_usage_rate,
    disk_usage_rate: diskUsage,
    swap_total: metric.swap_total,
    swap_used: metric.swap_used,
    process_count: metric.process_count,
    tcp_connections: metric.tcp_connections,
    udp_connections: metric.udp_connections,
    ping_json: metric.ping_json,
    ipv4_reachable: metric.ipv4_reachable,
    ipv6_reachable: metric.ipv6_reachable,
    updated_at: now,
    network_rx_speed: metric.network_rx_speed ?? null,
    network_tx_speed: metric.network_tx_speed ?? null,
    // 未传流量状态时保持列不动（无网络数据的上报不清空既有累计值）
    ...(trafficState ?? {}),
  };

  const result = await db
    .insert(agentLatestMetrics)
    .values(values)
    .onConflictDoUpdate({
      target: agentLatestMetrics.agent_id,
      set: values,
    });

  // 写路径主动失效最新指标缓存
  invalidateAgentLatestCache(metric.agent_id);
  return result;
}

export async function insertAgentMetricRollup(
  rollup: typeof agentMetricRollups.$inferInsert
) {
  return await db
    .insert(agentMetricRollups)
    .values(rollup)
    .onConflictDoUpdate({
      target: [
        agentMetricRollups.agent_id,
        agentMetricRollups.bucket_start,
        agentMetricRollups.bucket_size_seconds,
      ],
      set: rollup,
    });
}

// 获取指定客户端最近 24 小时的聚合资源指标
export async function getAgentMetricRollups(agentId: number, limit = 288) {
  const rows = await db
    .select()
    .from(agentMetricRollups)
    .where(
      and(
        eq(agentMetricRollups.agent_id, agentId),
        gte(agentMetricRollups.bucket_start, getTwentyFourHoursAgo())
      )
    )
    .orderBy(desc(agentMetricRollups.bucket_start))
    .limit(limit);

  return rows.reverse();
}

// 检查轮换旧表是否存在（表不存在/探测失败时优雅降级）。
// 结果用 isolate 级布尔缓存，轮换 clearAgentCaches 时重置；探测失败不进缓存。
async function historyOldTableExists(): Promise<boolean> {
  const cached = getCachedHistoryOldTableExists();
  if (cached !== null) {
    return cached;
  }

  let exists: boolean;
  try {
    exists = await tableExists("agent_metrics_history_old");
  } catch {
    return false;
  }
  setCachedHistoryOldTableExists(exists);
  return exists;
}

/**
 * 历史分区表主键 BETWEEN 范围扫描 + SQL 层时间桶聚合降采样（固定 ≤160 点）。
 * 时间窗跨轮换边界时 UNION agent_metrics_history_old。
 * 聚合规则：数值列取桶内 AVG（连接数/进程数取 MAX）；MAX(id) 作为桶代表行，其余裸列
 * （timestamp / cpu_cores / cpu_model / memory_total / disk_metrics / network_metrics /
 *   swap_total / ping_json / ipv4_reachable / ipv6_reachable）
 * 取该行的值（SQLite 单 MAX 聚合裸列语义，即桶内最新一条）。
 *
 * ⚠️ SELECT 列清单与 db/schema.ts 的 agentMetricsHistory 保持同步：
 * schema 增删列时必须同步更新此处与 insertAgentMetricsHistory 的插入映射。
 */
async function queryHistoryRows(
  startId: number,
  endId: number,
  intervalSec: number,
  includeOldTable: boolean
): Promise<Metrics[]> {
  const buildQuery = (withOld: boolean) => {
    const sources = [
      `SELECT * FROM agent_metrics_history WHERE id BETWEEN ${startId} AND ${endId}`,
    ];
    if (withOld) {
      sources.push(
        `SELECT * FROM agent_metrics_history_old WHERE id BETWEEN ${startId} AND ${endId}`
      );
    }
    return `
      SELECT
        MAX(id) AS id,
        agent_id,
        timestamp,
        AVG(cpu_usage) AS cpu_usage,
        cpu_cores,
        cpu_model,
        memory_total,
        AVG(memory_used) AS memory_used,
        AVG(memory_free) AS memory_free,
        AVG(memory_usage_rate) AS memory_usage_rate,
        AVG(load_1) AS load_1,
        AVG(load_5) AS load_5,
        AVG(load_15) AS load_15,
        disk_metrics,
        network_metrics,
        swap_total,
        AVG(swap_used) AS swap_used,
        MAX(process_count) AS process_count,
        MAX(tcp_connections) AS tcp_connections,
        MAX(udp_connections) AS udp_connections,
        ping_json,
        ipv4_reachable,
        ipv6_reachable,
        AVG(network_rx_speed) AS network_rx_speed,
        AVG(network_tx_speed) AS network_tx_speed
      FROM (${sources.join(" UNION ALL ")})
      GROUP BY CAST(strftime('%s', timestamp) AS INTEGER) / ${intervalSec}
      ORDER BY id ASC
    `;
  };

  try {
    return (await db.all(sql.raw(buildQuery(includeOldTable)))) as Metrics[];
  } catch (error) {
    if (includeOldTable) {
      // 旧表可能在查询期间被轮换删除，降级为只查主表
      return (await db.all(sql.raw(buildQuery(false)))) as Metrics[];
    }
    throw error;
  }
}

// 获取指定客户端资源指标（hours 取白名单值，默认 24）。
// 服务层已查过的 agent 行可透传进来，避免二次 getAgentById。
export async function getAgentMetrics(
  agentId: number,
  hours: number = DEFAULT_AGENT_METRICS_HOURS,
  agent?: Agent | null
) {
  const cacheKey = `${agentId}:${hours}`;
  const cached = agentHistoryCache.get(cacheKey);
  if (cached) {
    return cached as Metrics[];
  }

  const now = Date.now();
  const startMs = now - hours * 60 * 60 * 1000;
  // 时间窗早于最近一次周日 UTC 0 点轮换时，需要 UNION 旧表
  const needOldTable = startMs < getLastRotationTime(now);

  const [agentRow, oldTableExists] = await Promise.all([
    agent !== undefined ? Promise.resolve(agent) : getAgentById(agentId),
    needOldTable ? historyOldTableExists() : Promise.resolve(false),
  ]);

  const partitionId = normalizeHistoryPartitionId(
    agentRow?.history_partition_id
  );
  if (!partitionId) {
    return [];
  }

  const intervalSec = Math.max(
    10,
    Math.ceil((hours * 3600) / MAX_HISTORY_POINTS)
  );
  const { startId, endId } = getHistoryIdRange(partitionId, startMs, now);

  const rows = await queryHistoryRows(
    startId,
    endId,
    intervalSec,
    needOldTable && oldTableExists
  );
  agentHistoryCache.set(cacheKey, rows, getHistoryCacheTtlMs(hours));
  return rows;
}

// 从历史分区表取某客户端最新一行（agent_latest_metrics 缺失时的兜底）
async function getLatestHistoryMetric(
  agentId: number
): Promise<Metrics | undefined> {
  const agent = await getAgentById(agentId);
  const partitionId = normalizeHistoryPartitionId(agent?.history_partition_id);
  if (!partitionId) {
    return undefined;
  }

  const { startId, endId } = getHistoryIdRange(partitionId);
  try {
    const rows = (await db.all(
      sql`SELECT * FROM agent_metrics_history WHERE id BETWEEN ${startId} AND ${endId} ORDER BY id DESC LIMIT 1`
    )) as Metrics[];
    return rows[0];
  } catch {
    return undefined;
  }
}

// 获取指定客户端的最新指标
export async function getLatestAgentMetrics(agentId: number) {
  const cacheKey = `latest:${agentId}`;
  const cached = agentLatestCache.get(cacheKey);
  if (cached === LATEST_METRIC_MISSING) {
    return undefined;
  }
  if (cached) {
    return cached as Metrics;
  }

  const latest = await db
    .select()
    .from(agentLatestMetrics)
    .where(eq(agentLatestMetrics.agent_id, agentId))
    .limit(1);

  const metric = latest[0]
    ? parseMetricsJson(latest[0])
    : await getLatestHistoryMetric(agentId);
  agentLatestCache.set(
    cacheKey,
    metric ?? LATEST_METRIC_MISSING,
    AGENT_LATEST_TTL_MS
  );
  return metric;
}

// 轻量查询：某用户全部客户端的 id 列表（WebSocket 订阅范围计算用，不取整行）
export async function getAgentIds(userId: number): Promise<number[]> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.created_by, userId));
  return rows.map((row: { id: number }) => row.id);
}

// 获取设置了到期日的全部客户端（每日到期检测任务用）
export async function getAgentsWithExpireDate() {
  return await db
    .select()
    .from(agents)
    .where(isNotNull(agents.expire_date));
}

// 批量顺延到期日（自动续费），并发执行且由本层负责列表缓存失效
export async function updateAgentExpireDates(
  updates: Array<{ id: number; expire_date: string }>
) {
  if (updates.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  await Promise.all(
    updates.map((update) =>
      db
        .update(agents)
        .set({ expire_date: update.expire_date, updated_at: now })
        .where(eq(agents.id, update.id))
    )
  );
  invalidateAgentsListCache();
}
