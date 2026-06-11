// 定期检查客户端状态的任务
import {
  setAgentInactive,
  getAgentById,
  getFormattedIPAddresses,
} from "../services";
import { getAgentsToMarkOffline } from "../repositories";
import { shouldSendNotification, sendNotification } from "../services";
import { Hono } from "hono";
import { db } from "../config";
import { and, eq,lt } from "drizzle-orm";
import { notificationSettings, agentMetrics24h } from "../db/schema";
import { getEnvNumber } from "../utils/env";

const agentTask = new Hono<{}>();
const DEFAULT_AGENT_OFFLINE_BATCH_SIZE = 50;

interface AgentResult {
  id: number;
  name: string;
  status: string;
  updated_at: string;
  keepalive: string;
  created_by: number; // 添加 created_by 以便获取 userId
  last_seen_at?: string | null;
  next_offline_at?: string | null;
}

type ThresholdMetricValue = {
  cpu?: number | null;
  memory?: number | null;
  disk?: number | null;
};

export const checkAgentsStatus = async (c: any) => {
  try {
    const batchSize = getEnvNumber(
      c?.env,
      "AGENT_OFFLINE_BATCH_SIZE",
      DEFAULT_AGENT_OFFLINE_BATCH_SIZE,
      { min: 1, max: 500 }
    );
    const activeAgents = await getAgentsToMarkOffline(batchSize);

    if (!activeAgents || activeAgents.length === 0) {
      return;
    }

    for (const agent of activeAgents as AgentResult[]) {
      await setAgentInactive(agent.id);
      await handleAgentOfflineNotification(c.env, agent.id, agent.name, agent.created_by);
    }
  } catch (error) {
    console.error("定时任务: 检查客户端状态出错:", error);
  }
};

/**
 * 处理客户端离线通知
 * @param env 环境变量
 * @param agentId 客户端ID
 * @param agentName 客户端名称
 * @param userId 用户ID
 */
async function handleAgentOfflineNotification(
  env: any,
  agentId: number,
  agentName: string,
  userId: number
) {
  try {
    // 检查是否需要发送通知
    const notificationCheck = await shouldSendNotification(
      userId, // 修复: 传入 userId
      "agent",
      agentId,
      "online", // 上一个状态
      "offline" // 当前状态
    );

    if (
      !notificationCheck.shouldSend ||
      notificationCheck.channels.length === 0
    ) {
      return;
    }

    // 获取客户端完整信息
    const agent = await getAgentById(agentId);
    if (!agent) {
      console.error(`找不到客户端数据 (ID: ${agentId})`);
      return;
    }

    // 准备通知变量
    const formattedIP = getFormattedIPAddresses(agent.ip_addresses);
    const variables = {
      name: agentName,
      status: "offline",
      previous_status: "online", // 添加previous_status变量
      time: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      hostname: agent.hostname || "未知",
      ip_addresses: formattedIP,
      ip_address: formattedIP, // 兼容旧模板
      os: agent.os || "未知",
      error: "客户端连接超时 🔴",
      details: `主机名: ${agent.hostname || "未知"}\nIP地址: ${formattedIP}\n操作系统: ${agent.os || "未知"}\n最后连接时间: ${new Date(agent.last_seen_at || agent.updated_at).toLocaleString("zh-CN")}`,
    };

    // 发送通知
    const notificationResult = await sendNotification(
      "agent",
      agentId,
      variables,
      notificationCheck.channels,
      userId, // 修复: 传入 userId
      notificationCheck.cooldownMinutes
    );

    if (!notificationResult.success) {
      console.error(`客户端 ${agentName} (ID: ${agentId}) 离线通知发送失败`);
    }
  } catch (error) {
    console.error(
      `处理客户端离线通知时出错 (${agentName}, ID: ${agentId}):`,
      error
    );
  }
}

/**
 * 处理客户端上线通知
 * @param env 环境变量
 * @param agentId 客户端ID
 * @param agentName 客户端名称
 * @param userId 用户ID
 */
export async function handleAgentOnlineNotification(
  env: any,
  agentId: number,
  agentName: string,
  userId: number
) {
  try {
    // 检查是否需要发送通知
    // 注意：这里状态是从 offline 变为 online
    const notificationCheck = await shouldSendNotification(
      userId,
      "agent",
      agentId,
      "offline", // 上一个状态
      "online"   // 当前状态
    );

    if (
      !notificationCheck.shouldSend ||
      notificationCheck.channels.length === 0
    ) {
      return;
    }

    // 获取客户端完整信息
    const agent = await getAgentById(agentId);
    if (!agent) {
      console.error(`找不到客户端数据 (ID: ${agentId})`);
      return;
    }

    // 准备通知变量
    const formattedIP = getFormattedIPAddresses(agent.ip_addresses);
    const variables = {
      name: agentName,
      status: "online",
      previous_status: "offline",
      time: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      hostname: agent.hostname || "未知",
      ip_addresses: formattedIP,
      ip_address: formattedIP, // 兼容旧模板
      os: agent.os || "未知",
      error: "客户端连接已恢复 🟢",
      details: `主机名: ${agent.hostname || "未知"}\nIP地址: ${formattedIP}\n操作系统: ${agent.os || "未知"}\n恢复时间: ${new Date().toLocaleString("zh-CN")}`,
    };

    // 发送通知
    const notificationResult = await sendNotification(
      "agent",
      agentId,
      variables,
      notificationCheck.channels,
      userId,
      notificationCheck.cooldownMinutes
    );

    if (!notificationResult.success) {
      console.error(`客户端 ${agentName} (ID: ${agentId}) 上线通知发送失败`);
    }
  } catch (error) {
    console.error(
      `处理客户端上线通知时出错 (${agentName}, ID: ${agentId}):`,
      error
    );
  }
}

/**
 * 处理客户端阈值超出通知
 * 此函数可以单独调用，也可以在客户端上报数据时触发
 */
export async function handleAgentThresholdNotification(
  agentId: number,
  metricType: string,
  value: number
) {
  return handleAgentThresholdNotifications(agentId, {
    [metricType]: value,
  });
}

export async function handleAgentThresholdNotifications(
  agentId: number,
  values: ThresholdMetricValue
) {
  try {
    // 获取客户端配置
    const agent = await getAgentById(agentId);

    if (!agent) {
      console.error(`找不到客户端 (ID: ${agentId})`);
      throw new Error(`找不到客户端 (ID: ${agentId})`);
    }

    const userId = agent.created_by; // 获取 userId

    // 查询特定设置
    const settings = await db
      .select()
      .from(notificationSettings)
      .where(
        and(
          eq(notificationSettings.enabled, 1),
          eq(notificationSettings.target_id, agentId),
          eq(notificationSettings.target_type, "agent"),
          eq(notificationSettings.user_id, userId) // 增加 userId 过滤
        )
      );

    // 如果没有特定设置，查询全局设置
    const globalSettings = settings.length === 0
      ? await db
          .select()
          .from(notificationSettings)
          .where(
            and(
              eq(notificationSettings.enabled, 1),
              eq(notificationSettings.target_type, "global-agent"),
              eq(notificationSettings.user_id, userId) // 增加 userId 过滤
            )
          )
      : null;
    
    // 使用特定设置或全局设置
    const finalSettings = settings.length === 0 ? globalSettings?.[0] : settings[0];

    if (!finalSettings) {
      return;
    }

    const thresholdEvents = [
      {
        key: "cpu",
        name: "CPU使用率",
        value: values.cpu,
        threshold: finalSettings.cpu_threshold,
        enabled: Boolean(finalSettings.on_cpu_threshold),
      },
      {
        key: "memory",
        name: "内存使用率",
        value: values.memory,
        threshold: finalSettings.memory_threshold,
        enabled: Boolean(finalSettings.on_memory_threshold),
      },
      {
        key: "disk",
        name: "磁盘使用率",
        value: values.disk,
        threshold: finalSettings.disk_threshold,
        enabled: Boolean(finalSettings.on_disk_threshold),
      },
    ].filter(
      (event) =>
        event.enabled &&
        typeof event.value === "number" &&
        Number.isFinite(event.value) &&
        event.value >= event.threshold
    );

    if (thresholdEvents.length === 0) {
      return;
    }

    // 获取通知渠道
    let channels = [];
    try {
      channels = JSON.parse(finalSettings.channels);
    } catch (e) {
      console.error(`解析通知渠道失败 (${agent.name}, ID: ${agentId}):`, e);
      return;
    }

    if (channels.length === 0) {
      return;
    }

    // 准备通知变量
    const formattedIP = getFormattedIPAddresses(agent.ip_addresses);
    const metricNames = thresholdEvents.map((event) => event.name).join("、");
    const details = thresholdEvents
      .map(
        (event) =>
          `${event.name}: ${event.value!.toFixed(2)}%\n阈值: ${event.threshold}%`
      )
      .join("\n\n");

    const variables = {
      name: agent.name,
      status: `资源阈值告警: ${metricNames}`,
      previous_status: "normal", // 添加previous_status变量
      time: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      hostname: agent.hostname || "未知",
      ip_addresses: formattedIP,
      ip_address: formattedIP, // 兼容旧模板
      os: agent.os || "未知",
      error: `${metricNames}超过阈值`,
      details: `${details}\n\n主机名: ${agent.hostname || "未知"}\nIP地址: ${formattedIP}\n操作系统: ${agent.os || "未知"}`,
    };

    // 发送通知
    const notificationResult = await sendNotification(
      "agent",
      agentId,
      variables,
      channels,
      userId, // 修复: 传入 userId
      finalSettings.cooldown_minutes
    );

    if (!notificationResult.success) {
      console.error(
        `客户端 ${agent.name} (ID: ${agentId}) 资源阈值聚合通知发送失败`
      );
    }
  } catch (error) {
    console.error(`处理客户端阈值通知时出错 (ID: ${agentId}):`, error);
  }
}

// 在 Cloudflare Workers 中设置定时触发器
export default {
  async scheduled(event: any, env: any, ctx: any) {
    const c = { env };

    // 默认执行监控检查任务
    let result: any = await checkAgentsStatus(c);
    // 获取24小时前的时间
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const hour = new Date().getUTCHours();
    const minute = new Date().getUTCMinutes();
    // 每隔6小时清理一次 metrics 24h 表数据

    if (hour % 6 === 0 && minute === 5) {
      await db.delete(agentMetrics24h).where(lt(agentMetrics24h.timestamp, yesterday));
    }

    return result;
  },
  fetch: agentTask.fetch,
};
