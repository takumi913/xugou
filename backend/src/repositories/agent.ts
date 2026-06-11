import { Agent, Metrics } from "../models/agent";
import {
  agents,
  agentLatestMetrics,
  agentMetricRollups,
  agentMetrics24h,
} from "../db/schema";
import { db } from "../config";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
/**
 * 客户端相关的数据库操作
 */

function getTwentyFourHoursAgo() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

const SINGLE_METRICS_LIMIT = 1440;
const BATCH_METRICS_LIMIT = 10000;
const LATEST_FALLBACK_LIMIT = 1000;

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

// 获取所有客户端
export async function getAllAgents(userId: number) {
  return await db.select().from(agents).where(eq(agents.created_by, userId)).orderBy(desc(agents.created_at));
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

// 批量获取客户端指标
export async function getAgentMetricsByIds(agentIds: number[]) {
  if (agentIds.length === 0) {
    return { results: [] };
  }
  const rows = await db
    .select()
    .from(agentMetrics24h)
    .where(
      and(
        inArray(agentMetrics24h.agent_id, agentIds),
        gte(agentMetrics24h.timestamp, getTwentyFourHoursAgo())
      )
    )
    .orderBy(desc(agentMetrics24h.timestamp))
    .limit(BATCH_METRICS_LIMIT);

  return rows.reverse();
}

// 批量获取每个客户端的最新指标
export async function getLatestAgentMetricsByIds(agentIds: number[]) {
  if (agentIds.length === 0) {
    return [];
  }

  const latestRows = await db
    .select()
    .from(agentLatestMetrics)
    .where(inArray(agentLatestMetrics.agent_id, agentIds));

  const latestByAgent = new Map<number, Metrics>();
  for (const row of latestRows) {
    latestByAgent.set(row.agent_id, parseMetricsJson(row));
  }

  const missingAgentIds = agentIds.filter((id) => !latestByAgent.has(id));
  if (missingAgentIds.length === 0) {
    return Array.from(latestByAgent.values());
  }

  const rows = await db
    .select()
    .from(agentMetrics24h)
    .where(
      and(
        inArray(agentMetrics24h.agent_id, missingAgentIds),
        gte(agentMetrics24h.timestamp, getTwentyFourHoursAgo())
      )
    )
    .orderBy(desc(agentMetrics24h.timestamp))
    .limit(
      Math.min(
        LATEST_FALLBACK_LIMIT,
        Math.max(missingAgentIds.length * 10, missingAgentIds.length)
      )
    );

  for (const row of rows) {
    if (!latestByAgent.has(row.agent_id)) {
      latestByAgent.set(row.agent_id, row);
    }
  }

  return Array.from(latestByAgent.values());
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
  return result[0];
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
    return updatedAgent[0];
  } catch (error) {
    console.error("更新客户端失败:", error);
    throw new Error("更新客户端失败");
  }
}

// 删除客户端
export async function deleteAgent(id: number) {
  try {
    // 先删除关联的指标数据
    await db.delete(agentMetrics24h).where(eq(agentMetrics24h.agent_id, id));
    await db.delete(agentMetricRollups).where(eq(agentMetricRollups.agent_id, id));
    await db.delete(agentLatestMetrics).where(eq(agentLatestMetrics.agent_id, id));
    // 再删除客户端
    await db.delete(agents).where(eq(agents.id, id));
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

  // 批量删除关联的指标数据
  await db.delete(agentMetrics24h).where(inArray(agentMetrics24h.agent_id, agentIds));
  await db.delete(agentMetricRollups).where(inArray(agentMetricRollups.agent_id, agentIds));
  await db.delete(agentLatestMetrics).where(inArray(agentLatestMetrics.agent_id, agentIds));

  // 批量删除客户端
  await db.delete(agents).where(inArray(agents.id, agentIds));
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

  return await db
    .update(agents)
    .set({
      status: "inactive",
      updated_at: now,
      last_state_changed_at: now,
      next_offline_at: null,
    })
    .where(eq(agents.id, id));
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

  return await db
    .update(agents)
    .set(updateData)
    .where(eq(agents.id, id));
}

// 插入客户端资源指标
export async function insertAgentMetrics(metrics: Metrics[]) {
  return await db.batch(
    metrics.map((metric) => db.insert(agentMetrics24h).values(metric))
  );
}

export async function upsertAgentLatestMetric(metric: Metrics) {
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
    updated_at: now,
  };

  return await db
    .insert(agentLatestMetrics)
    .values(values)
    .onConflictDoUpdate({
      target: agentLatestMetrics.agent_id,
      set: values,
    });
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

// 获取指定客户端资源指标
export async function getAgentMetrics(agentId: number) {
  const rows = await db
    .select()
    .from(agentMetrics24h)
    .where(
      and(
        eq(agentMetrics24h.agent_id, agentId),
        gte(agentMetrics24h.timestamp, getTwentyFourHoursAgo())
      )
    )
    .orderBy(desc(agentMetrics24h.timestamp))
    .limit(SINGLE_METRICS_LIMIT);

  return rows.reverse();
}

// 获取指定客户端的最新指标
export async function getLatestAgentMetrics(agentId: number) {
  const latest = await db
    .select()
    .from(agentLatestMetrics)
    .where(eq(agentLatestMetrics.agent_id, agentId))
    .limit(1);

  if (latest[0]) {
    return parseMetricsJson(latest[0]);
  }

  const metrics = await db
    .select()
    .from(agentMetrics24h)
    .where(eq(agentMetrics24h.agent_id, agentId))
    .orderBy(desc(agentMetrics24h.timestamp))
    .limit(1);
  return metrics[0];
}
