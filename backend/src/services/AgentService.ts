import { z } from "zod";
import type { Agent, Metrics } from "../models/agent";
import type { Bindings } from "../models/db";
import * as AgentRepository from "../repositories";
import {
  fetchLatestReportUpdates,
  queueMetricsBroadcast,
  toBroadcastSample,
  type BroadcastEnv,
  type WaitUntilContext,
} from "./BroadcastService";
import { generateToken, verifyToken } from "../utils/jwt";
import { handleAgentThresholdNotifications, handleAgentOnlineNotification } from "../jobs/agent-task"; // 引入上线通知处理函数
import { getEnvNumber } from "../utils/env";
import { canAccessOwnedResource } from "../utils/access";
import {
  MAX_REPORT_SAMPLES,
  normalizeAgentIntervals,
} from "../utils/agentConfig";
import {
  agentImportItemSchema,
  agentStatusItemSchema,
  agentStatusSampleSchema,
  agentStatusSchema,
  agentUpdateSchema,
} from "../api/schemas";
import {
  DEFAULT_AGENT_METRICS_HOURS,
  normalizeHistoryPartitionId,
} from "../utils/historyId";
import {
  computeTraffic,
  getTrafficPeriodStart,
  normalizeTrafficResetDay,
  sumNetworkTotals,
  type TrafficState,
} from "../utils/traffic";
import { normalizeAgentGeo, type AgentGeoInput } from "../utils/geo";

// ---- 上报体类型（由 zod schema 派生，api 层已校验）----
type AgentStatusInput = z.infer<typeof agentStatusSchema>;
type AgentStatusItem = z.infer<typeof agentStatusItemSchema>;
type AgentStatusSample = z.infer<typeof agentStatusSampleSchema>;
// 展开后的样本条目：顶层 item（旧协议/无 samples）或 samples 内的单个样本
type AgentStatusEntry =
  | AgentStatusItem
  | (AgentStatusSample & { timestamp?: string | Date });
type AgentUpdateData = z.infer<typeof agentUpdateSchema>;

export { normalizeAgentMetricsHours } from "../utils/historyId";

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

  // last_seen_at 每次上报都会刷新，按时间差判定会让上报间隔小于阈值的 agent
  // 永远达不到落库条件（历史/rollup 一行都写不进去）。
  // 改按对齐窗口边界判定：跨窗口即落库，每个窗口恰好持久化一次，
  // 且与 rollup 的 bucket_start（同一 getBucketStart 对齐）天然一致。
  return (
    getBucketStart(now, minIntervalSeconds) !==
    getBucketStart(new Date(lastSeenTime), minIntervalSeconds)
  );
}

// 从上报的磁盘对象列表（stringify 之前的形态）计算峰值使用率
function getMaxDiskUsage(
  disks: Array<{ usage_rate?: number }> | null | undefined
) {
  if (!Array.isArray(disks)) {
    return null;
  }
  return disks.reduce<number | null>((max, disk) => {
    if (typeof disk.usage_rate !== "number") return max;
    return max === null ? disk.usage_rate : Math.max(max, disk.usage_rate);
  }, null);
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

// 宽容地转换上报数值：非有限数值返回 null（旧 agent 缺字段时保持空）
function toFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// 布尔可达性标记转 0/1，缺失返回 null
function toBooleanFlag(value: unknown): number | null {
  if (typeof value !== "boolean") return null;
  return value ? 1 : 0;
}

// 规范化上报来源地区码（ISO 3166-1 两位字母码），非法输入返回 null
function normalizeRegionCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const region = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(region) ? region : null;
}

/**
 * 将上报体展开为按时间升序的样本条目列表：
 * - 旧协议：单对象或数组，原样返回
 * - 新协议：顶层为最新样本 + samples[] 承载整个窗口的样本；
 *   samples 中的 ts（Unix 毫秒）转成 timestamp 供后续统一处理，
 *   顶层最新样本若不与最后一个 sample 重复则补到末尾
 * 返回列表保证非空且最后一项是最新样本（D1 只持久化该项，B2 链路不变）。
 */
function flattenStatusSamples(status: AgentStatusInput): AgentStatusEntry[] {
  if (Array.isArray(status)) {
    return status;
  }

  const samples = status.samples ?? [];
  if (samples.length === 0) {
    return [status];
  }

  // zod 已保证 samples 为对象数组且 ≤ MAX_REPORT_SAMPLES
  const items: AgentStatusEntry[] = samples
    .map((sample) => {
      const ts = Number(sample.ts);
      const timestamp =
        Number.isFinite(ts) && ts > 0
          ? new Date(ts).toISOString()
          : sample.timestamp;
      const { samples: _ignored, ...rest } = sample;
      return { ...rest, timestamp };
    })
    .sort(
      (a, b) =>
        new Date(a.timestamp ?? 0).getTime() -
        new Date(b.timestamp ?? 0).getTime()
    );

  // 顶层为最新样本：与最后一个 sample 时间不同才追加，避免广播重复样本
  const lastTs = new Date(items[items.length - 1].timestamp ?? 0).getTime();
  const topTs = status.timestamp ? new Date(status.timestamp).getTime() : NaN;
  if (Number.isFinite(topTs) && topTs > lastTs) {
    const { samples: _ignored, ...topItem } = status;
    items.push(topItem);
  }

  return items.slice(-MAX_REPORT_SAMPLES);
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

export async function getAgentsWithLatestMetrics(
  userId: number,
  env?: BroadcastEnv
) {
  try {
    const agents = (await AgentRepository.getAllAgents(userId)) as Agent[];
    const agentIds = agents.map((agent) => agent.id);
    // D1 最新指标与 DO 最近一包广播互不依赖，并行获取。
    // 首屏接续：合并 DO 内存中每个 agent 的最近一包广播（取时间较新者）。
    // DO 不可用时 fetchLatestReportUpdates 返回空数组，静默降级不影响原接口。
    const [latestMetrics, doUpdates] = await Promise.all([
      AgentRepository.getLatestAgentMetricsByIds(agentIds),
      fetchLatestReportUpdates(env, agentIds),
    ]);
    const latestByAgentId = new Map<number, Metrics>(
      latestMetrics.map((metric) => [metric.agent_id, metric])
    );
    for (const update of doUpdates) {
      const lastSample = update.samples[update.samples.length - 1];
      if (!lastSample) continue;
      const dbMetric = latestByAgentId.get(update.agentId);
      const dbTs = dbMetric ? Date.parse(dbMetric.timestamp) : NaN;
      if (Number.isFinite(dbTs) && dbTs >= lastSample.ts) continue;
      latestByAgentId.set(update.agentId, {
        ...(dbMetric ?? { agent_id: update.agentId, timestamp: "" }),
        ...lastSample.data,
        agent_id: update.agentId,
        timestamp: new Date(lastSample.ts).toISOString(),
      });
    }

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
  updateData: AgentUpdateData,
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

    // 间隔配置交叉校验：与现有值合并后 report >= collect
    if (
      updateData.collect_interval !== undefined ||
      updateData.report_interval !== undefined
    ) {
      const current = normalizeAgentIntervals(agent);
      const nextCollect =
        updateData.collect_interval ?? current.collect_interval;
      const nextReport = updateData.report_interval ?? current.report_interval;
      if (nextReport < nextCollect) {
        return {
          success: false,
          message: "上报间隔不能小于采集间隔",
          status: 400,
        };
      }
      agent.collect_interval = nextCollect;
      agent.report_interval = nextReport;
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

    // 账单与到期信息（可置空）
    if (updateData.price !== undefined) {
      agent.price = updateData.price ?? null;
    }
    if (updateData.currency !== undefined) {
      agent.currency = updateData.currency || "USD";
    }
    if (updateData.billing_cycle !== undefined) {
      agent.billing_cycle = updateData.billing_cycle ?? null;
    }
    if (updateData.expire_date !== undefined) {
      agent.expire_date = updateData.expire_date ?? null;
    }
    if (updateData.auto_renewal !== undefined) {
      agent.auto_renewal = updateData.auto_renewal;
    }

    // 公开状态页隐藏开关
    if (updateData.is_hidden !== undefined) {
      agent.is_hidden = updateData.is_hidden;
    }

    // 流量管理配置（上限可置空=不限；值域已由 zod 校验）
    if (updateData.traffic_limit_gb !== undefined) {
      agent.traffic_limit_gb = updateData.traffic_limit_gb ?? null;
    }
    if (updateData.traffic_reset_day !== undefined) {
      agent.traffic_reset_day = updateData.traffic_reset_day;
    }
    if (updateData.traffic_calc_type !== undefined) {
      agent.traffic_calc_type = updateData.traffic_calc_type;
    }

    // 自动升级开关（协议 v3 update 指令）
    if (updateData.auto_update !== undefined) {
      agent.auto_update = updateData.auto_update;
    }

    // 分组与标签（空串视为清空）
    if (updateData.group_name !== undefined) {
      agent.group_name = updateData.group_name || null;
    }
    if (updateData.tags !== undefined) {
      agent.tags = updateData.tags || null;
    }

    // 执行更新
    const updatedAgent = await AgentRepository.updateAgent(agent);

    // 隐藏开关/流量配置变化直接影响公开状态页，标记快照脏数据尽快重建
    if (
      updateData.is_hidden !== undefined ||
      updateData.traffic_limit_gb !== undefined ||
      updateData.traffic_reset_day !== undefined ||
      updateData.traffic_calc_type !== undefined
    ) {
      await AgentRepository.markPublicStatusSnapshotDirty(agent.created_by, 0);
    }

    // 响应剥离 token（与列表/详情接口口径一致，避免更新响应泄露令牌）
    const { token: _token, ...agentWithoutToken } = updatedAgent;

    return {
      success: true,
      message: "客户端信息已更新",
      agent: agentWithoutToken,
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
export async function updateAgentStatusService(
  status: AgentStatusInput,
  env?: Bindings,
  executionCtx?: WaitUntilContext,
  region?: string | null,
  geo?: AgentGeoInput | null
) {
  try {
    // 元数据（token/hostname 等）取自旧协议的首个条目或新协议的顶层对象
    const primaryItem = Array.isArray(status) ? status[0] : status;
    // 指标样本列表：新协议将 samples[] 展开，最后一项保证是最新样本
    const statusData = flattenStatusSamples(status);
    const now = new Date();
    const norlmalInfo = {
      token: primaryItem?.token,
      ip_addresses: primaryItem?.ip_addresses,
      hostname: primaryItem?.hostname,
      os: primaryItem?.os,
      version: primaryItem?.version,
      keepalive: primaryItem?.keepalive,
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
      primaryItem?.report_interval_seconds,
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

    // region 由服务端从 request.cf.country 判定，变化时随元数据一并落库
    const regionCode = normalizeRegionCode(region);
    const regionChanged = regionCode !== null && agent.region !== regionCode;

    // 地理位置由服务端从 request.cf.latitude/longitude/city/region 判定，
    // 与 region 同模式：仅当规范化后有值且与已落库值不同才更新（复用已读取的
    // agent 行，热路径零额外查询；坐标已在 normalizeAgentGeo 内定点舍入，
    // 与 D1 real 列读回的 double 可做严格相等比较，避免每次上报都触发 UPDATE）
    const normalizedGeo = normalizeAgentGeo(geo);
    const geoCoordsChanged =
      normalizedGeo.latitude !== null &&
      normalizedGeo.longitude !== null &&
      ((agent.geo_latitude ?? null) !== normalizedGeo.latitude ||
        (agent.geo_longitude ?? null) !== normalizedGeo.longitude);
    const geoCityChanged =
      normalizedGeo.city !== null &&
      (agent.geo_city ?? null) !== normalizedGeo.city;
    const geoRegionNameChanged =
      normalizedGeo.region_name !== null &&
      (agent.geo_region_name ?? null) !== normalizedGeo.region_name;
    const geoChanged = geoCoordsChanged || geoCityChanged || geoRegionNameChanged;

    // boot_time 为稳定元数据（Unix 秒），变化时（重启/首次上报）随元数据一并落库
    const bootTime = toFiniteNumber(primaryItem?.boot_time);
    const bootTimeChanged =
      bootTime !== null && (agent.boot_time ?? null) !== bootTime;

    if (
      agent.hostname != norlmalInfo.hostname ||
      agent.ip_addresses != normalizedIpAddresses ||
      agent.os != norlmalInfo.os ||
      agent.version != norlmalInfo.version ||
      regionChanged ||
      geoChanged ||
      bootTimeChanged
    ) {
      agent.ip_addresses = normalizedIpAddresses;
      // 上报缺省（undefined）的字段保持原值不覆盖
      if (norlmalInfo.hostname !== undefined) {
        agent.hostname = norlmalInfo.hostname;
      }
      if (norlmalInfo.os !== undefined) {
        agent.os = norlmalInfo.os;
      }
      if (norlmalInfo.version !== undefined) {
        agent.version = norlmalInfo.version;
      }
      if (norlmalInfo.keepalive !== undefined) {
        agent.keepalive = String(norlmalInfo.keepalive);
      }
      if (regionChanged) {
        agent.region = regionCode;
      }
      if (geoCoordsChanged) {
        agent.geo_latitude = normalizedGeo.latitude;
        agent.geo_longitude = normalizedGeo.longitude;
      }
      if (geoCityChanged) {
        agent.geo_city = normalizedGeo.city;
      }
      if (geoRegionNameChanged) {
        agent.geo_region_name = normalizedGeo.region_name;
      }
      if (bootTimeChanged) {
        agent.boot_time = bootTime;
      }

      await AgentRepository.updateAgent(agent);
    }

    await AgentRepository.updateAgentHeartbeat(agent.id, {
      lastSeenAt: now.toISOString(),
      nextOfflineAt,
      keepalive: String(keepaliveSeconds),
      statusChanged,
    });

    // 插入 metric 信息

    const metrics: Metrics[] = statusData.map((item) => ({
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
      // B4a 新增指标（旧 agent 不上报时保持 null）
      swap_total: toFiniteNumber(item?.swap?.total),
      swap_used: toFiniteNumber(item?.swap?.used),
      process_count: toFiniteNumber(item?.process_count),
      tcp_connections: toFiniteNumber(item?.tcp_connections),
      udp_connections: toFiniteNumber(item?.udp_connections),
      ping_json:
        item?.ping && typeof item.ping === "object"
          ? JSON.stringify(item.ping)
          : null,
      ipv4_reachable: toBooleanFlag(item?.ipv4_reachable),
      ipv6_reachable: toBooleanFlag(item?.ipv6_reachable),
    }));

    // C1：速率与月流量全部服务端计算（agent 协议不变）。
    // 单趟遍历样本序列：逐对算速率回填每个样本，月流量按 delta 累计法更新状态。
    // 热路径成本：仅当上报携带网络数据时多一次 agent_latest_metrics 主键 SELECT。
    const sampleTotals = statusData.map((item, index) => ({
      ts: Date.parse(metrics[index].timestamp),
      totals: sumNetworkTotals(item?.network),
    }));
    let trafficState:
      | {
          month_rx: number;
          month_tx: number;
          last_total_rx: number | null;
          last_total_tx: number | null;
          month_reset_at: string | null;
        }
      | undefined;
    if (sampleTotals.some((sample) => sample.totals !== null)) {
      try {
        const prevRow = await AgentRepository.getAgentTrafficState(agent.id);
        const prevTs = prevRow?.collected_at
          ? Date.parse(prevRow.collected_at)
          : NaN;
        const prev: TrafficState | null = prevRow
          ? {
              month_rx: prevRow.month_rx ?? 0,
              month_tx: prevRow.month_tx ?? 0,
              last_total_rx: prevRow.last_total_rx,
              last_total_tx: prevRow.last_total_tx,
              month_reset_at: prevRow.month_reset_at,
              last_ts: Number.isFinite(prevTs) ? prevTs : null,
            }
          : null;
        // 周期起点按 agent 的重置日以 UTC 判定，跨重置日 computeTraffic 内先清零再累计
        const periodStart = getTrafficPeriodStart(
          now,
          normalizeTrafficResetDay(agent.traffic_reset_day)
        );
        const result = computeTraffic(prev, sampleTotals, periodStart);
        result.speeds.forEach((speed, index) => {
          metrics[index].network_rx_speed = speed.rx;
          metrics[index].network_tx_speed = speed.tx;
        });
        // 最新样本携带月流量，随 metrics_json 落库并进入广播样本
        metrics[metrics.length - 1].month_rx = result.state.month_rx;
        metrics[metrics.length - 1].month_tx = result.state.month_tx;
        trafficState = {
          month_rx: result.state.month_rx,
          month_tx: result.state.month_tx,
          last_total_rx: result.state.last_total_rx,
          last_total_tx: result.state.last_total_tx,
          month_reset_at: result.state.month_reset_at,
        };
      } catch (error) {
        // 流量计算失败只丢当次速率/累计，不影响上报主流程
        console.error(
          `[AgentService] 流量计算失败 (agent ${agent.id}):`,
          error
        );
      }
    }

    const latestMetric = metrics[metrics.length - 1];
    await AgentRepository.upsertAgentLatestMetric(latestMetric, trafficState);

    // 指标落库成功后加入实时广播队列（5 秒窗口合并后推送到 DO，失败静默）
    queueMetricsBroadcast(
      env,
      executionCtx,
      agent.id,
      metrics.map((metric) => toBroadcastSample(metric))
    );

    // 探针间隔配置（供上报响应按 MD5 协商下发）与自升级开关（v3 update 指令）
    const agentIntervals = normalizeAgentIntervals(agent);
    const agentAutoUpdate = agent.auto_update === 1;

    if (!shouldPersistMetrics) {
      return {
        agentId: agent.id,
        sampled: true,
        recommendedReportIntervalSeconds: minReportIntervalSeconds,
        agentIntervals,
        agentAutoUpdate,
      };
    }

    // 历史分区表每个上报窗口只写 1 行（主键 = 分区 ID * 10^13 + YYMMDDHHmmss），
    // 已停止写入旧 agent_metrics_24h 表。分区未分配时先分配（并发冲突内部重试），
    // 分配失败只跳过历史写入，不影响上报主流程。
    const partitionId =
      normalizeHistoryPartitionId(agent.history_partition_id) ??
      (await AgentRepository.ensureAgentHistoryPartition(agent.id));
    if (partitionId) {
      try {
        await AgentRepository.insertAgentMetricsHistory(
          partitionId,
          latestMetric
        );
      } catch (error) {
        console.error(`[AgentService] 写入历史指标失败 (agent ${agent.id}):`, error);
      }
    }

    // 聚合值各算一次复用（rollup 与阈值通知共用）；磁盘峰值从对象形态计算，
    // 避免 stringify 后再 parse
    const cpuValues = metrics.map((metric) => metric.cpu_usage);
    const memoryValues = metrics.map((metric) => metric.memory_usage_rate);
    const diskPeaks = statusData.map((item) => getMaxDiskUsage(item?.disks));
    const maxCpuUsage = maxMetric(cpuValues);
    const maxMemoryUsage = maxMetric(memoryValues);
    const maxDiskUsage = maxMetric(diskPeaks);

    const bucketSizeSeconds = minReportIntervalSeconds;
    await AgentRepository.insertAgentMetricRollup({
      agent_id: agent.id,
      bucket_start: getBucketStart(now, bucketSizeSeconds),
      bucket_size_seconds: bucketSizeSeconds,
      sample_count: metrics.length,
      cpu_avg: avgMetric(cpuValues),
      cpu_min: minMetric(cpuValues),
      cpu_max: maxCpuUsage,
      cpu_p95: percentileMetric(cpuValues, 95),
      memory_avg: avgMetric(memoryValues),
      memory_min: minMetric(memoryValues),
      memory_max: maxMemoryUsage,
      memory_p95: percentileMetric(memoryValues, 95),
      disk_max: maxDiskUsage,
      load_avg: avgMetric(metrics.map((metric) => metric.load_1)),
      network_delta_json: null,
      threshold_events_json: JSON.stringify(
        statusData.flatMap((item) => item?.threshold_events || [])
      ),
      created_at: now.toISOString(),
    });

    await handleAgentThresholdNotifications(agent.id, {
      cpu: maxCpuUsage,
      memory: maxMemoryUsage,
      disk: maxDiskUsage,
    });

    return {
      agentId: agent.id,
      sampled: false,
      recommendedReportIntervalSeconds: minReportIntervalSeconds,
      agentIntervals,
      agentAutoUpdate,
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
  role?: string,
  hours: number = DEFAULT_AGENT_METRICS_HOURS
) {
  if (typeof userId === "number") {
    const agent = await AgentRepository.getAgentById(agentId);
    if (!canAccessAgent(agent, userId, role)) {
      return null;
    }
    // 访问校验已查到 agent 行，透传给 repository 避免二次查询
    return await AgentRepository.getAgentMetrics(agentId, hours, agent);
  }
  return await AgentRepository.getAgentMetrics(agentId, hours);
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

// ---- C3：手动排序 / 导入导出 ----

/**
 * 按前端给定的 id 顺序批量写 sort_order。
 * 全部 id 必须归属当前用户（admin 可跨用户），任一无权访问则整体拒绝。
 */
export async function updateAgentsOrderService(
  ids: number[],
  userId: number,
  role?: string
) {
  try {
    const uniqueIds = Array.from(new Set(ids));
    const rows =
      role === "admin"
        ? ((await AgentRepository.getAgentsByIds(uniqueIds)) as Agent[])
        : await AgentRepository.getAgentsByIdsForUser(uniqueIds, userId);

    if (!Array.isArray(rows) || rows.length !== uniqueIds.length) {
      return {
        success: false,
        message: "客户端不存在或无权访问",
        status: 400,
      };
    }

    await AgentRepository.updateAgentsOrder(uniqueIds);
    return { success: true, message: "排序已更新", status: 200 };
  } catch (error) {
    console.error("更新客户端排序错误:", error);
    return {
      success: false,
      message: "更新客户端排序失败",
      status: 500,
    };
  }
}

/**
 * 导出当前用户的全部客户端配置（含 token，供迁移/备份后重新导入）。
 * 不含运行时状态与指标数据。
 */
export async function exportAgentsService(userId: number) {
  const agents = (await AgentRepository.getAllAgents(userId)) as Agent[];
  return agents.map((agent) => ({
    name: agent.name,
    token: agent.token,
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
  }));
}

type AgentImportItem = z.infer<typeof agentImportItemSchema>;

/**
 * 导入客户端：按 name 去重（已存在则跳过，不覆盖）；
 * token 缺失或与现有 agent 冲突时重新生成。返回 {created, skipped}。
 */
export async function importAgentsService(
  env: any,
  items: AgentImportItem[],
  userId: number
) {
  const existing = (await AgentRepository.getAllAgents(userId)) as Agent[];
  const existingNames = new Set(existing.map((agent) => agent.name));
  let created = 0;
  let skipped = 0;

  for (const item of items) {
    if (existingNames.has(item.name)) {
      skipped++;
      continue;
    }

    let token = item.token ?? "";
    if (!token || (await AgentRepository.getAgentByToken(token))) {
      token = await generateToken(env);
    }

    const newAgent = await AgentRepository.createAgent(
      item.name,
      token,
      userId,
      "inactive",
      item.hostname ?? null,
      item.os ?? null,
      item.version ?? null,
      item.ip_addresses ?? null
    );

    // 回填配置字段（createAgent 只接受基础元数据；仅写导入项里明确出现的字段）
    const patch: Partial<Agent> = {};
    if (item.collect_interval !== undefined) patch.collect_interval = item.collect_interval;
    if (item.report_interval !== undefined) patch.report_interval = item.report_interval;
    if (item.price !== undefined) patch.price = item.price;
    if (item.currency !== undefined) patch.currency = item.currency;
    if (item.billing_cycle !== undefined) patch.billing_cycle = item.billing_cycle;
    if (item.expire_date !== undefined) patch.expire_date = item.expire_date;
    if (item.auto_renewal !== undefined) patch.auto_renewal = item.auto_renewal;
    if (item.is_hidden !== undefined) patch.is_hidden = item.is_hidden;
    if (item.traffic_limit_gb !== undefined) patch.traffic_limit_gb = item.traffic_limit_gb;
    if (item.traffic_reset_day !== undefined) patch.traffic_reset_day = item.traffic_reset_day;
    if (item.traffic_calc_type !== undefined) patch.traffic_calc_type = item.traffic_calc_type;
    if (item.auto_update !== undefined) patch.auto_update = item.auto_update;
    if (item.group_name !== undefined) patch.group_name = item.group_name;
    if (item.tags !== undefined) patch.tags = item.tags;
    if (item.sort_order !== undefined) patch.sort_order = item.sort_order;

    if (Object.keys(patch).length > 0) {
      await AgentRepository.updateAgent({ ...newAgent, ...patch } as Agent);
    }

    existingNames.add(item.name);
    created++;
  }

  return { created, skipped };
}
