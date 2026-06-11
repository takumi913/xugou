import type { Agent } from "../models/agent";
import * as AgentRepository from "../repositories";
import { generateToken, verifyToken } from "../utils/jwt";
import { handleAgentThresholdNotifications, handleAgentOnlineNotification } from "../jobs/agent-task"; // 引入上线通知处理函数
import { getEnvNumber } from "../utils/env";
import { canAccessOwnedResource } from "../utils/access";

const DEFAULT_MIN_AGENT_REPORT_INTERVAL_SECONDS = 300;
const DEFAULT_AGENT_OFFLINE_FACTOR = 5;
const DEFAULT_STATUS_SNAPSHOT_DIRTY_COALESCE_SECONDS = 30;

function normalizeKeepaliveSeconds(value: unknown, fallback = 60) {
  const keepalive = Number(value);
  if (!Number.isFinite(keepalive) || keepalive <= 0) {
    return fallback;
  }
  return Math.round(keepalive);
}

function getNextOfflineAt(
  now: Date,
  keepaliveSeconds: number,
  reportIntervalSeconds: number
) {
  const thresholdSeconds =
    Math.max(keepaliveSeconds, reportIntervalSeconds) *
    DEFAULT_AGENT_OFFLINE_FACTOR;
  return new Date(now.getTime() + thresholdSeconds * 1000).toISOString();
}

function shouldPersistAgentMetrics(
  lastSeenAt: string | null | undefined,
  now: Date,
  minIntervalSeconds: number
) {
  if (!lastSeenAt) {
    return true;
  }

  const lastSeenTime = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(lastSeenTime)) {
    return true;
  }

  return now.getTime() - lastSeenTime >= minIntervalSeconds * 1000;
}

function getMaxDiskUsage(diskMetricsJson: string | null | undefined) {
  try {
    const diskMetrics = JSON.parse(diskMetricsJson || "[]") as Array<{
      usage_rate?: number;
    }>;
    return diskMetrics.reduce<number | null>((max, disk) => {
      if (typeof disk.usage_rate !== "number") return max;
      return max === null ? disk.usage_rate : Math.max(max, disk.usage_rate);
    }, null);
  } catch {
    return null;
  }
}

function maxMetric(values: Array<number | null | undefined>) {
  return values.reduce<number | null>((max, value) => {
    if (typeof value !== "number") return max;
    return max === null ? value : Math.max(max, value);
  }, null);
}

function minMetric(values: Array<number | null | undefined>) {
  return values.reduce<number | null>((min, value) => {
    if (typeof value !== "number") return min;
    return min === null ? value : Math.min(min, value);
  }, null);
}

function avgMetric(values: Array<number | null | undefined>) {
  const numbers = values.filter(
    (value): value is number => typeof value === "number"
  );
  if (numbers.length === 0) {
    return null;
  }
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function percentileMetric(values: Array<number | null | undefined>, percentile: number) {
  const numbers = values
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  if (numbers.length === 0) {
    return null;
  }
  const index = Math.min(
    numbers.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * numbers.length) - 1)
  );
  return numbers[index];
}

function normalizeTimestamp(value: unknown, fallback: Date) {
  if (!value) {
    return fallback.toISOString();
  }

  const date = new Date(value as string);
  if (!Number.isFinite(date.getTime())) {
    return fallback.toISOString();
  }

  return date.toISOString();
}

function getBucketStart(date: Date, bucketSizeSeconds: number) {
  const bucketMs = bucketSizeSeconds * 1000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs).toISOString();
}

/**
 * 获取所有客户端
 * @param db 数据库连接
 * @returns 客户端列表
 */
export async function getAgents(userId: number) {
  try {
    const result = (await AgentRepository.getAllAgents(userId)) as Agent[];
    const agents = (result || []).map(({ token, ...agent }) => agent);

    return {
      success: true,
      agents,
      status: 200,
    };
  } catch (error) {
    console.error("获取客户端列表错误:", error);
    return {
      success: false,
      message: "获取客户端列表失败",
      error: error instanceof Error ? error.message : String(error),
      status: 500,
    };
  }
}

export async function getAgentsWithLatestMetrics(userId: number) {
  try {
    const agents = (await AgentRepository.getAllAgents(userId)) as Agent[];
    const agentIds = agents.map((agent) => agent.id);
    const latestMetrics = await AgentRepository.getLatestAgentMetricsByIds(
      agentIds
    );
    const latestByAgentId = new Map(
      latestMetrics.map((metric) => [metric.agent_id, metric])
    );

    return {
      success: true,
      agents: agents.map(({ token, ...agent }) => ({
        ...agent,
        metrics: latestByAgentId.get(agent.id) ?? null,
      })),
      status: 200,
    };
  } catch (error) {
    console.error("获取客户端列表和最新指标错误:", error);
    return {
      success: false,
      message: "获取客户端列表失败",
      error: error instanceof Error ? error.message : String(error),
      status: 500,
    };
  }
}

/**
 * 根据ID获取客户端详情
 * @param db 数据库连接
 * @param agentId 客户端ID
 * @returns 客户端详情
 */
export async function getAgentDetail(
  agentId: number,
  userId: number,
  role?: string
) {
  // 获取客户端信息
  const agent = await AgentRepository.getAgentById(agentId);

  if (!canAccessAgent(agent, userId, role)) {
    return null;
  }

  // 不返回令牌，但保留其他所有字段
  const { token, ...rest } = agent;

  return {
    ...rest,
    ip_addresses: getFormattedIPAddresses(agent.ip_addresses as any),
  };
}

/**
 * 更新客户端信息
 * @param db 数据库连接
 * @param agentId 客户端ID
 * @param updateData 更新数据
 * @returns 更新结果
 */
export async function updateAgentService(
  agentId: number,
  updateData: {
    name?: string;
    hostname?: string | null;
    ip_addresses?: string[];
    os?: string | null;
    version?: string | null;
    status?: string | null;
  },
  userId: number,
  role?: string
) {
  try {
    // 获取当前客户端数据
    const agent = await AgentRepository.getAgentById(agentId);

    if (!canAccessAgent(agent, userId, role)) {
      return { success: false, message: "客户端不存在", status: 404 };
    }

    // 验证数据
    if (updateData.name && updateData.name.trim() === "") {
      return { success: false, message: "客户端名称不能为空", status: 400 };
    }

    if (updateData.ip_addresses && updateData.ip_addresses.length > 0) {
      agent.ip_addresses = JSON.stringify(updateData.ip_addresses);
    } else if (updateData.ip_addresses) {
      agent.ip_addresses = "[]";
    }

    if (typeof updateData.name === "string") {
      agent.name = updateData.name;
    }

    if (updateData.hostname !== undefined) {
      agent.hostname = updateData.hostname ?? null;
    }

    if (updateData.os !== undefined) {
      agent.os = updateData.os ?? null;
    }

    if (updateData.version !== undefined) {
      agent.version = updateData.version ?? null;
    }

    if (updateData.status !== undefined) {
      agent.status = updateData.status ?? null;
    }

    // 执行更新
    const updatedAgent = await AgentRepository.updateAgent(agent);

    return {
      success: true,
      message: "客户端信息已更新",
      agent: updatedAgent,
      status: 200,
    };
  } catch (error) {
    console.error("更新客户端错误:", error);
    return {
      success: false,
      message: "更新客户端失败",
      error: error instanceof Error ? error.message : String(error),
      status: 500,
    };
  }
}

/**
 * 删除客户端
 * @param agentId 客户端ID
 * @param userId 用户ID
 * @returns 删除结果
 */
export async function deleteAgentService(
  agentId: number,
  userId: number,
  role?: string
) {
  try {
    // 获取客户端信息
    const agent = await AgentRepository.getAgentById(agentId);
    if (!canAccessAgent(agent, userId, role)) {
      return { success: false, message: "客户端不存在", status: 404 };
    }

    // 删除客户端通知设置
    await AgentRepository.deleteNotificationSettings(
      "agent",
      agent.id,
      agent.created_by
    );

    // 执行删除客户端
    await AgentRepository.deleteAgent(agent.id);

    return { success: true, message: "客户端已删除", status: 200 };
  } catch (error) {
    console.error("删除客户端错误:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
      status: 500,
    };
  }
}

/**
 * 生成客户端注册令牌
 * @param env 环境变量
 * @returns 生成结果
 */
export async function generateAgentToken(env: any) {
  try {
    return await generateToken(env);
  } catch (error) {
    console.error("生成令牌错误:", error);
    throw new Error("生成令牌失败");
  }
}

/**
 * 验证客户端注册令牌
 * @param token 令牌
 * @param env 环境变量
 * @returns 验证结果
 */
export async function verifyAgentToken(token: string, env: any) {
  try {
    return await verifyToken(token, env);
  } catch (error) {
    console.error("验证令牌错误:", error);
    return { valid: false, message: "令牌验证失败" };
  }
}

/**
 * 获取格式化后的IP地址
 * @param ipAddressesJson IP地址的JSON字符串
 * @returns 格式化后的IP地址
 */
export function getFormattedIPAddresses(
  ipAddressesJson: string | null
): string {
  try {
    if (!ipAddressesJson) return "未知";
    const ipArray = JSON.parse(String(ipAddressesJson));
    return Array.isArray(ipArray) && ipArray.length > 0
      ? ipArray.join(", ")
      : "未知";
  } catch (e) {
    return String(ipAddressesJson || "未知");
  }
}

export async function registerAgentService(
  env: any,
  token: string,
  name: string,
  hostname: string | null = null,
  ipAddresses: string[] | null = null,
  os: string | null = null,
  version: string | null = null
) {
  try {
    // 验证令牌
    if (!token) {
      return { success: false, message: "缺少注册令牌", status: 400 };
    }

    // 通过token查找客户端
    const existingAgent = await AgentRepository.getAgentByToken(token);

    if (existingAgent && existingAgent.id) {
      return {
        success: true,
        message: "客户端已存在",
        status: 200,
        agent: {
          id: existingAgent.id,
        },
      };
    }

    // 验证令牌
    const tokenVerification = await verifyAgentToken(token, env);

    // 如果令牌无效，返回错误
    if (!tokenVerification.valid) {
      return {
        success: false,
        message: `注册令牌无效: ${tokenVerification.message}`,
        status: 400,
      };
    }

    // 查找管理员用户作为客户端创建者
    const adminId = await AgentRepository.getAdminUserId();

    // 创建新客户端
    const newAgent = await AgentRepository.createAgent(
      name,
      token,
      adminId,
      "active",
      hostname || "unknown",
      os || "unknown",
      version || "unknown",
      ipAddresses || []
    );

    return {
      success: true,
      message: "客户端注册成功",
      agent: { id: newAgent.id },
      status: 201,
    };
  } catch (error) {
    console.error("客户端注册错误:", error);
    return {
      success: false,
      message: "客户端注册失败",
      error: error instanceof Error ? error.message : String(error),
      status: 500,
    };
  }
}

/**
 * 更新客户端状态
 * @param db 数据库连接
 * @param env 环境变量
 * @param status 客户端指标
 * @returns 更新结果
 */
export async function updateAgentStatusService(status: any, env?: any) {
  try {
    const statusData = Array.isArray(status) ? status : [status];
    const now = new Date();
    const norlmalInfo = {
      token: statusData[0]?.token,
      ip_addresses: statusData[0]?.ip_addresses,
      hostname: statusData[0]?.hostname,
      os: statusData[0]?.os,
      version: statusData[0]?.version,
      keepalive: statusData[0]?.keepalive,
      status: "active",
    };

    if (!norlmalInfo.token) {
      throw new Error("缺少API令牌");
    }
    // 通过token查找客户端
    const agent = await AgentRepository.getAgentByToken(norlmalInfo.token);

    if (!agent) {
      throw new Error("找不到对应的Agent");
    }

    const keepaliveSeconds = normalizeKeepaliveSeconds(norlmalInfo.keepalive);
    const minReportIntervalSeconds = getEnvNumber(
      env,
      "MIN_AGENT_REPORT_INTERVAL_SECONDS",
      DEFAULT_MIN_AGENT_REPORT_INTERVAL_SECONDS,
      { min: 1, max: 86400 }
    );
    const reportedIntervalSeconds = normalizeKeepaliveSeconds(
      statusData[0]?.report_interval_seconds,
      minReportIntervalSeconds
    );
    const nextOfflineAt = getNextOfflineAt(
      now,
      keepaliveSeconds,
      Math.max(minReportIntervalSeconds, reportedIntervalSeconds)
    );
    const statusChanged = agent.status !== "active";
    const normalizedIpAddresses = JSON.stringify(
      norlmalInfo.ip_addresses ?? []
    );
    const shouldPersistMetrics = shouldPersistAgentMetrics(
      agent.last_seen_at ?? agent.updated_at,
      now,
      minReportIntervalSeconds
    );

    // 检测上线状态
    if (statusChanged) {
      // 异步触发上线通知，不阻塞主流程
      handleAgentOnlineNotification(
        {},
        agent.id,
        agent.name,
        agent.created_by
      ).catch((err) => console.error(`[AgentService] 触发上线通知失败:`, err));
    }

    if (statusChanged || shouldPersistMetrics) {
      await AgentRepository.markPublicStatusSnapshotDirty(
        agent.created_by,
        getEnvNumber(
          env,
          "STATUS_SNAPSHOT_DIRTY_COALESCE_SECONDS",
          DEFAULT_STATUS_SNAPSHOT_DIRTY_COALESCE_SECONDS,
          { min: 0, max: 3600 }
        )
      );
    }

    if (
      agent.hostname != norlmalInfo.hostname ||
      agent.ip_addresses != normalizedIpAddresses ||
      agent.os != norlmalInfo.os ||
      agent.version != norlmalInfo.version
    ) {
      agent.ip_addresses = normalizedIpAddresses;
      agent.hostname = norlmalInfo.hostname;
      agent.os = norlmalInfo.os;
      agent.version = norlmalInfo.version;
      agent.keepalive = norlmalInfo.keepalive;

      await AgentRepository.updateAgent(agent);
    }

    await AgentRepository.updateAgentHeartbeat(agent.id, {
      lastSeenAt: now.toISOString(),
      nextOfflineAt,
      keepalive: String(keepaliveSeconds),
      statusChanged,
    });

    // 插入 metric 信息

    const metrics = statusData.map((item) => ({
      agent_id: agent.id,
      timestamp: normalizeTimestamp(item?.timestamp, now),
      cpu_usage: item?.cpu?.usage,
      cpu_cores: item?.cpu?.cores,
      cpu_model: item?.cpu?.model_name,
      memory_total: item?.memory?.total,
      memory_used: item?.memory?.used,
      memory_free: item?.memory?.free,
      memory_usage_rate: item?.memory?.usage_rate,
      load_1: item?.load?.load1,
      load_5: item?.load?.load5,
      load_15: item?.load?.load15,
      disk_metrics: JSON.stringify(item?.disks || []),
      network_metrics: JSON.stringify(item?.network || []),
    }));

    const latestMetric = metrics[metrics.length - 1];
    await AgentRepository.upsertAgentLatestMetric(latestMetric);

    if (!shouldPersistMetrics) {
      return {
        agentId: agent.id,
        sampled: true,
        recommendedReportIntervalSeconds: minReportIntervalSeconds,
      };
    }

    // 旧 24h 明细表仅保留每个上报窗口的兼容点，避免把本地采样点逐条写入 D1。
    await AgentRepository.insertAgentMetrics([latestMetric]);

    const bucketSizeSeconds = minReportIntervalSeconds;
    await AgentRepository.insertAgentMetricRollup({
      agent_id: agent.id,
      bucket_start: getBucketStart(now, bucketSizeSeconds),
      bucket_size_seconds: bucketSizeSeconds,
      sample_count: metrics.length,
      cpu_avg: avgMetric(metrics.map((metric) => metric.cpu_usage)),
      cpu_min: minMetric(metrics.map((metric) => metric.cpu_usage)),
      cpu_max: maxMetric(metrics.map((metric) => metric.cpu_usage)),
      cpu_p95: percentileMetric(metrics.map((metric) => metric.cpu_usage), 95),
      memory_avg: avgMetric(metrics.map((metric) => metric.memory_usage_rate)),
      memory_min: minMetric(metrics.map((metric) => metric.memory_usage_rate)),
      memory_max: maxMetric(metrics.map((metric) => metric.memory_usage_rate)),
      memory_p95: percentileMetric(
        metrics.map((metric) => metric.memory_usage_rate),
        95
      ),
      disk_max: maxMetric(
        metrics.map((metric) => getMaxDiskUsage(metric.disk_metrics))
      ),
      load_avg: avgMetric(metrics.map((metric) => metric.load_1)),
      network_delta_json: null,
      threshold_events_json: JSON.stringify(
        statusData.flatMap((item) => item?.threshold_events || [])
      ),
      created_at: now.toISOString(),
    });

    const maxDiskUsage = maxMetric(
      metrics.map((metric) => getMaxDiskUsage(metric.disk_metrics))
    );

    await handleAgentThresholdNotifications(agent.id, {
      cpu: maxMetric(metrics.map((metric) => metric.cpu_usage)),
      memory: maxMetric(metrics.map((metric) => metric.memory_usage_rate)),
      disk: maxDiskUsage,
    });

    return {
      agentId: agent.id,
      sampled: false,
      recommendedReportIntervalSeconds: minReportIntervalSeconds,
    };
  } catch (error) {
    console.error("更新客户端状态错误:", error);
    throw error;
  }
}

export async function getAgentById(id: number): Promise<Agent | null> {
  const agent = await AgentRepository.getAgentById(id);
  return agent ?? null;
}

export function canAccessAgent(
  agent: Agent | null | undefined,
  userId: number,
  role?: string
): agent is Agent {
  return canAccessOwnedResource(agent, userId, role);
}

export async function getActiveAgents() {
  return await AgentRepository.getActiveAgents();
}

export async function setAgentInactive(id: number) {
  return await AgentRepository.setAgentInactive(id);
}

export async function getAgentMetrics(
  agentId: number,
  userId?: number,
  role?: string
) {
  if (typeof userId === "number") {
    const agent = await AgentRepository.getAgentById(agentId);
    if (!canAccessAgent(agent, userId, role)) {
      return null;
    }
  }
  return await AgentRepository.getAgentMetrics(agentId);
}

export async function getLatestAgentMetrics(
  agentId: number,
  userId?: number,
  role?: string
) {
  if (typeof userId === "number") {
    const agent = await AgentRepository.getAgentById(agentId);
    if (!canAccessAgent(agent, userId, role)) {
      return null;
    }
  }
  return await AgentRepository.getLatestAgentMetrics(agentId);
}
