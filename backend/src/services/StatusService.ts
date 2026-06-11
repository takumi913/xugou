import * as repositories from "../repositories";
import { Agent } from "../models";
import { getEnvNumber } from "../utils/env";
import { dedupeResourceIds, getMissingResourceIds } from "../utils/access";

const PUBLIC_METRICS_MAX_POINTS = 288;
const DEFAULT_STATUS_PAGE_CACHE_TTL_SECONDS = 60;
const DEFAULT_STATUS_SNAPSHOT_DIRTY_COALESCE_SECONDS = 30;

export class StatusPageConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatusPageConfigValidationError";
  }
}

function downsampleMetrics<T>(rows: T[], maxPoints = PUBLIC_METRICS_MAX_POINTS) {
  if (rows.length <= maxPoints) {
    return rows;
  }

  const step = Math.ceil(rows.length / maxPoints);
  return rows.filter((_, index) => index % step === 0).slice(0, maxPoints);
}

function createSnapshotEtag(userId: number, snapshotJson: string) {
  return `"status-${userId}-${snapshotJson.length}-${Date.now()}"`;
}

function parseSnapshot(snapshotJson: string) {
  try {
    return JSON.parse(snapshotJson);
  } catch {
    return null;
  }
}

function mapAgentRollupToMetricHistory(row: any) {
  return {
    id: row.id,
    agent_id: row.agent_id,
    timestamp: row.bucket_start,
    cpu_usage: row.cpu_avg ?? row.cpu_max ?? undefined,
    memory_usage_rate: row.memory_avg ?? row.memory_max ?? undefined,
    load_1: row.load_avg ?? undefined,
    load_5: row.load_avg ?? undefined,
    load_15: row.load_avg ?? undefined,
    disk_metrics:
      typeof row.disk_max === "number"
        ? JSON.stringify([
            {
              device: "rollup",
              mount_point: "/",
              total: 0,
              used: 0,
              free: 0,
              usage_rate: row.disk_max,
              fs_type: "rollup",
            },
          ])
        : "[]",
    network_metrics: row.network_delta_json ?? "[]",
  };
}

/**
 * 获取状态页配置
 * @param userId - 当前用户的ID
 * @returns 状态页配置对象
 */
export async function getStatusPageConfig(userId: number) {
  try {
    // 获取指定用户的状态页配置
    let existingConfig = await repositories.getStatusPageConfigByUserId(userId);

    // 如果用户没有配置，则为该用户创建一个新的默认配置
    if (!existingConfig) {
      const newConfigId = await repositories.createStatusPageConfig(
        userId,
        "系统状态", // 默认标题
        "实时监控系统运行状态", // 默认描述
        "", // logoUrl
        "" // customCss
      );

      if (!newConfigId) {
        throw new Error("为新用户创建状态页配置失败");
      }

      // 重新获取刚刚创建的配置
      existingConfig = await repositories.getStatusPageConfigById(newConfigId);

      if (!existingConfig) {
        throw new Error("获取新创建的状态页配置失败");
      }
    }

    // 获取被选中的监控项
    const monitorsResult = await repositories.getConfigMonitors(
      existingConfig.id
    );

    // 获取该用户的所有监控项
    const allMonitors = await repositories.getAllMonitors(userId);

    // 获取被选中的客户端
    const agentsResult = await repositories.getConfigAgents(existingConfig.id);

    // 获取该用户的所有客户端
    const allAgents = await repositories.getAllAgents(userId);

    const selectedMonitorIds = new Set(
      monitorsResult.map((monitor: any) => monitor.monitor_id)
    );
    const selectedAgentIds = new Set(
      agentsResult.map((agent: any) => agent.agent_id)
    );

    // 构建返回的监控列表，标记哪些监控项被选中
    const monitors = allMonitors.map((monitor: any) => {
      const isSelected = selectedMonitorIds.has(monitor.id);
      return { ...monitor, selected: isSelected };
    });

    // 构建返回的客户端列表，标记哪些客户端被选中
    const agents = allAgents.map((agent: any) => {
      const isSelected = selectedAgentIds.has(agent.id);
      return { ...agent, selected: isSelected };
    });

    return {
      title: existingConfig?.title || "",
      description: existingConfig?.description || "",
      logoUrl: existingConfig?.logo_url || "",
      customCss: existingConfig?.custom_css || "",
      monitors: monitors,
      agents: agents,
    };
  } catch (error) {
    console.error("获取状态页配置失败:", error);
    throw new Error("获取状态页配置失败");
  }
}

/**
 * 保存状态页配置
 * @param userId - 当前操作用户的ID
 * @param data - 要保存的配置数据
 * @returns 保存结果
 */
export async function saveStatusPageConfig(
  userId: number,
  data: {
    title: string;
    description: string;
    logoUrl: string;
    customCss: string;
    monitors: number[];
    agents: number[];
  },
  env?: any
) {
  try {
    const monitorIds = dedupeResourceIds(data.monitors ?? []);
    const agentIds = dedupeResourceIds(data.agents ?? []);

    const [ownedMonitors, ownedAgents] = await Promise.all([
      repositories.getMonitorsByIds(monitorIds, userId),
      repositories.getAgentsByIdsForUser(agentIds, userId),
    ]);
    const missingMonitorIds = getMissingResourceIds(
      monitorIds,
      (ownedMonitors as any[]).map((monitor) => monitor.id)
    );
    const missingAgentIds = getMissingResourceIds(
      agentIds,
      (ownedAgents as any[]).map((agent) => agent.id)
    );

    if (missingMonitorIds.length > 0 || missingAgentIds.length > 0) {
      throw new StatusPageConfigValidationError(
        "状态页配置包含不存在或无权访问的资源"
      );
    }

    const existingConfig = await repositories.getStatusPageConfigByUserId(
      userId
    );

    let configId: number;

    if (existingConfig && existingConfig.id) {
      // 更新现有配置
      await repositories.updateStatusPageConfig(
        existingConfig.id,
        data.title,
        data.description,
        data.logoUrl,
        data.customCss
      );
      configId = existingConfig.id;
    } else {
      // 如果不存在，则为当前用户创建一个新的全局配置
      const newConfigId = await repositories.createStatusPageConfig(
        userId,
        data.title,
        data.description,
        data.logoUrl,
        data.customCss
      );

      if (!newConfigId) {
        throw new Error("创建状态页配置失败");
      }
      configId = newConfigId;
    }

    // 清除并重新关联选定的监控项
    await repositories.clearConfigMonitorLinks(configId);
    if (monitorIds.length > 0) {
      await repositories.addMonitorsToConfig(configId, monitorIds);
    }

    // 清除并重新关联选定的客户端
    await repositories.clearConfigAgentLinks(configId);
    if (agentIds.length > 0) {
      await repositories.addAgentsToConfig(configId, agentIds);
    }

    await repositories.markPublicStatusSnapshotDirty(
      userId,
      getEnvNumber(
        env,
        "STATUS_SNAPSHOT_DIRTY_COALESCE_SECONDS",
        DEFAULT_STATUS_SNAPSHOT_DIRTY_COALESCE_SECONDS,
        { min: 0, max: 3600 }
      )
    );

    // 返回成功信息
    return { success: true, message: "配置已保存" };
  } catch (error) {
    if (error instanceof StatusPageConfigValidationError) {
      throw error;
    }
    console.error("保存状态页配置失败:", error);
    throw new Error("保存状态页配置失败");
  }
}

/**
 * 获取公共状态页所需的数据
 * @param userId - 用户ID
 * @returns 公共状态页数据
 */
async function buildStatusPagePublicData(userId: number) {
  // 获取用户的配置
  const config = await repositories.getStatusPageConfigByUserId(userId);

  if (!config) {
    return {
      title: "系统状态",
      description: "当前没有可用的状态页配置。",
      logoUrl: "",
      customCss: "",
      monitors: [],
      agents: [],
    };
  }

  // 获取选中的监控项ID
  const selectedMonitors = await repositories.getSelectedMonitors(
    config.id as number
  );

  // 获取选中的客户端ID
  const selectedAgents = await repositories.getSelectedAgents(
    config.id as number
  );

  const monitorIds = selectedMonitors.map((m: any) => m.monitor_id);
  const selectedMonitorIdSet = new Set(monitorIds);
  const [monitorRows, dailyStatsRows, historyRows] =
    monitorIds.length > 0
      ? await Promise.all([
          repositories.getMonitorsByIds(monitorIds, userId),
          repositories.getMonitorDailyStatsByIds(monitorIds),
          repositories.getMonitorStatusHistoryIn24hByIds(monitorIds),
        ])
      : [[], [], []];

  const dailyStatsByMonitor = new Map<number, any[]>();
  for (const stat of dailyStatsRows as any[]) {
    const stats = dailyStatsByMonitor.get(stat.monitor_id) ?? [];
    stats.push(stat);
    dailyStatsByMonitor.set(stat.monitor_id, stats);
  }

  const historyByMonitor = new Map<number, any[]>();
  for (const history of historyRows as any[]) {
    const rows = historyByMonitor.get(history.monitor_id) ?? [];
    rows.push(history);
    historyByMonitor.set(history.monitor_id, rows);
  }

  const monitors = (monitorRows as any[])
    .filter((monitor) => selectedMonitorIdSet.has(monitor.id))
    .map((monitor) => ({
      ...monitor,
      dailyStats: dailyStatsByMonitor.get(monitor.id) ?? [],
      history: historyByMonitor.get(monitor.id) ?? [],
    }));

  // 获取客户端的详细信息和最新指标
  let agents: Array<Omit<Agent, "token"> & { metrics?: any }> = [];
  if (selectedAgents && selectedAgents.length > 0) {
    const agentIds = selectedAgents.map((a: any) => a.agent_id);
    if (agentIds.length > 0) {
      const agentsResult = await repositories.getAgentsByIdsForUser(
        agentIds,
        userId
      );
      const ownedAgentIds = agentsResult.map((agent: any) => agent.id);
      const latestMetrics = await repositories.getLatestAgentMetricsByIds(
        ownedAgentIds
      );
      const latestMetricsByAgent = new Map(
        latestMetrics.map((metric: any) => [metric.agent_id, metric])
      );

      if (Array.isArray(agentsResult)) {
        agents = agentsResult.map(({ token, ...agent }) => ({
          ...agent,
          metrics: latestMetricsByAgent.get(agent.id) ?? null,
        }));
      }
    }
  }

  return {
    title: config.title,
    description: config.description,
    logoUrl: config.logo_url,
    customCss: config.custom_css,
    monitors: monitors,
    agents: agents,
  };
}

export async function getStatusPagePublicData(
  userId: number,
  env?: any,
  refreshInBackground?: (promise: Promise<unknown>) => void
) {
  return getStatusPagePublicDataWithSnapshot(
    userId,
    env,
    refreshInBackground
  );
}

async function refreshStatusPagePublicData(userId: number, env?: any) {
  const data = await buildStatusPagePublicData(userId);
  const snapshotJson = JSON.stringify(data);
  const ttlSeconds = getEnvNumber(
    env,
    "STATUS_PAGE_CACHE_TTL_SECONDS",
    DEFAULT_STATUS_PAGE_CACHE_TTL_SECONDS,
    { min: 0, max: 3600 }
  );
  const expiresAt = new Date(
    Date.now() + Math.max(ttlSeconds, 0) * 1000
  ).toISOString();

  try {
    await repositories.upsertPublicStatusSnapshot(
      userId,
      snapshotJson,
      createSnapshotEtag(userId, snapshotJson),
      expiresAt
    );
  } catch (error) {
    console.warn("写入公共状态页快照失败，已回退为直接返回数据:", error);
  }

  return data;
}

export async function getStatusPagePublicDataWithSnapshot(
  userId: number,
  env?: any,
  refreshInBackground?: (promise: Promise<unknown>) => void
) {
  const now = new Date();
  const snapshot = await repositories.getPublicStatusSnapshot(userId);
  let parsedSnapshot: any = null;

  if (snapshot) {
    parsedSnapshot = parseSnapshot(snapshot.snapshot_json);
    const expiresAt = new Date(snapshot.expires_at).getTime();
    const refreshAfter = snapshot.refresh_after
      ? new Date(snapshot.refresh_after).getTime()
      : 0;

    if (
      parsedSnapshot &&
      Number.isFinite(expiresAt) &&
      expiresAt > now.getTime() &&
      (!snapshot.dirty_at || refreshAfter > now.getTime())
    ) {
      return parsedSnapshot;
    }
  }

  const refreshPromise = refreshStatusPagePublicData(userId, env);

  if (parsedSnapshot && refreshInBackground) {
    refreshInBackground(
      refreshPromise.catch((error) => {
        console.warn("后台刷新公共状态页快照失败:", error);
      })
    );
    return parsedSnapshot;
  }

  try {
    return await refreshPromise;
  } catch (error) {
    if (parsedSnapshot) {
      return parsedSnapshot;
    }
    throw error;
  }
}

export async function getPublicAgentMetrics(userId: number, agentId: number) {
  const isSelected = await repositories.isAgentSelectedForStatusPage(
    userId,
    agentId
  );

  if (!isSelected) {
    return {
      success: false,
      status: 404,
      message: "客户端不存在或未公开",
      metrics: [],
    };
  }

  const rollups = await repositories.getAgentMetricRollups(
    agentId,
    PUBLIC_METRICS_MAX_POINTS
  );
  const metrics =
    rollups.length > 0
      ? rollups.map(mapAgentRollupToMetricHistory)
      : await repositories.getAgentMetrics(agentId);

  return {
    success: true,
    status: 200,
    metrics: downsampleMetrics(metrics),
  };
}
