import api from "./client";
import type { AxiosResponse } from "axios";
import type {
  NotificationChannel,
  NotificationConfig,
  NotificationTemplate,
} from "../types/notification";

type BackendNotificationChannel = {
  id: number;
  name: string;
  type: string;
  config: string | Record<string, unknown> | null;
  enabled: number | boolean;
  created_by?: number;
  created_at?: string;
  updated_at?: string;
};

type BackendNotificationTemplate = {
  id: number;
  name: string;
  type: string;
  subject: string;
  content: string;
  is_default: number | boolean;
  created_by?: number;
  created_at?: string;
  updated_at?: string;
};

export type NotificationSettings = NotificationConfig["settings"];

type RawNotificationSettings = {
  monitors?: unknown;
  agents?: unknown;
  specificMonitors?: unknown;
  specificAgents?: unknown;
};

export interface NotificationConfigResponse {
  success: boolean;
  message?: string;
  data?: NotificationConfig;
}

const parseChannelConfig = (
  config: BackendNotificationChannel["config"]
): Record<string, unknown> => {
  if (!config) {
    return {};
  }

  if (typeof config === "string") {
    try {
      const parsed = JSON.parse(config);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      console.error("解析通知渠道配置失败:", error);
    }
    return {};
  }

  if (typeof config === "object" && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }

  return {};
};

const normalizeBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    return value === "1" || value.toLowerCase() === "true";
  }

  return fallback;
};

const normalizeNumber = (value: unknown, fallback: number): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const normalizeChannelIds = (value: unknown): number[] => {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item));
      }
    } catch (error) {
      console.error("解析通知渠道ID列表失败:", error);
      return [];
    }
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item));
  }

  return [];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const transformChannel = (
  channel: BackendNotificationChannel
): NotificationChannel => ({
  id: Number(channel.id),
  name: channel.name,
  type: channel.type,
  config: parseChannelConfig(channel.config),
  enabled: normalizeBoolean(channel.enabled, true),
  createdBy: channel.created_by,
  createdAt: channel.created_at,
  updatedAt: channel.updated_at,
});

const transformTemplate = (
  template: BackendNotificationTemplate
): NotificationTemplate => ({
  id: Number(template.id),
  name: template.name,
  type: template.type,
  subject: template.subject,
  content: template.content,
  isDefault: normalizeBoolean(template.is_default, false),
  createdBy: template.created_by,
  createdAt: template.created_at,
  updatedAt: template.updated_at,
});

const normalizeSettings = (settings: unknown): NotificationSettings => {
  const normalized: NotificationSettings = {
    monitors: {
      enabled: false,
      onDown: false,
      onRecovery: false,
      cooldownMinutes: 30,
      channels: [],
    },
    agents: {
      enabled: false,
      onOffline: false,
      onRecovery: false,
      onCpuThreshold: false,
      cpuThreshold: 90,
      onMemoryThreshold: false,
      memoryThreshold: 85,
      onDiskThreshold: false,
      diskThreshold: 90,
      cooldownMinutes: 30,
      channels: [],
    },
    specificMonitors: {},
    specificAgents: {},
  };

  if (!settings || !isRecord(settings)) {
    return normalized;
  }

  const rawSettings = settings as RawNotificationSettings;
  const monitorSettings = isRecord(rawSettings.monitors)
    ? rawSettings.monitors
    : undefined;
  const agentSettings = isRecord(rawSettings.agents)
    ? rawSettings.agents
    : undefined;

  if (monitorSettings) {
    normalized.monitors = {
      enabled: normalizeBoolean(monitorSettings.enabled),
      onDown: normalizeBoolean(monitorSettings.onDown ?? monitorSettings.on_down),
      onRecovery: normalizeBoolean(
        monitorSettings.onRecovery ?? monitorSettings.on_recovery
      ),
      cooldownMinutes: normalizeNumber(
        monitorSettings.cooldownMinutes ?? monitorSettings.cooldown_minutes,
        30
      ),
      channels: normalizeChannelIds(monitorSettings.channels),
    };
  }

  if (agentSettings) {
    normalized.agents = {
      enabled: normalizeBoolean(agentSettings.enabled),
      onOffline: normalizeBoolean(agentSettings.onOffline ?? agentSettings.on_offline),
      onRecovery: normalizeBoolean(
        agentSettings.onRecovery ?? agentSettings.on_recovery
      ),
      onCpuThreshold: normalizeBoolean(
        agentSettings.onCpuThreshold ?? agentSettings.on_cpu_threshold
      ),
      cpuThreshold: normalizeNumber(agentSettings.cpuThreshold ?? agentSettings.cpu_threshold, 90),
      onMemoryThreshold: normalizeBoolean(
        agentSettings.onMemoryThreshold ?? agentSettings.on_memory_threshold
      ),
      memoryThreshold: normalizeNumber(
        agentSettings.memoryThreshold ?? agentSettings.memory_threshold,
        85
      ),
      onDiskThreshold: normalizeBoolean(
        agentSettings.onDiskThreshold ?? agentSettings.on_disk_threshold
      ),
      diskThreshold: normalizeNumber(
        agentSettings.diskThreshold ?? agentSettings.disk_threshold,
        90
      ),
      cooldownMinutes: normalizeNumber(
        agentSettings.cooldownMinutes ?? agentSettings.cooldown_minutes,
        30
      ),
      channels: normalizeChannelIds(agentSettings.channels),
    };
  }

  if (isRecord(rawSettings.specificMonitors)) {
    Object.entries(rawSettings.specificMonitors).forEach(
      ([monitorId, monitorSetting]) => {
        if (isRecord(monitorSetting)) {
          normalized.specificMonitors[monitorId] = {
            enabled: normalizeBoolean(monitorSetting.enabled),
            onDown: normalizeBoolean(
              monitorSetting.onDown ?? monitorSetting.on_down
            ),
            onRecovery: normalizeBoolean(
              monitorSetting.onRecovery ?? monitorSetting.on_recovery
            ),
            cooldownMinutes: normalizeNumber(
              monitorSetting.cooldownMinutes ?? monitorSetting.cooldown_minutes,
              normalized.monitors.cooldownMinutes
            ),
            channels: normalizeChannelIds(monitorSetting.channels),
          };
        }
      }
    );
  }

  if (isRecord(rawSettings.specificAgents)) {
    Object.entries(rawSettings.specificAgents).forEach(
      ([agentId, agentSetting]) => {
        if (isRecord(agentSetting)) {
          normalized.specificAgents[agentId] = {
            enabled: normalizeBoolean(agentSetting.enabled),
            onOffline: normalizeBoolean(
              agentSetting.onOffline ?? agentSetting.on_offline
            ),
            onRecovery: normalizeBoolean(
              agentSetting.onRecovery ?? agentSetting.on_recovery
            ),
            onCpuThreshold: normalizeBoolean(
              agentSetting.onCpuThreshold ?? agentSetting.on_cpu_threshold
            ),
            cpuThreshold: normalizeNumber(
              agentSetting.cpuThreshold ?? agentSetting.cpu_threshold,
              normalized.agents.cpuThreshold
            ),
            onMemoryThreshold: normalizeBoolean(
              agentSetting.onMemoryThreshold ?? agentSetting.on_memory_threshold
            ),
            memoryThreshold: normalizeNumber(
              agentSetting.memoryThreshold ?? agentSetting.memory_threshold,
              normalized.agents.memoryThreshold
            ),
            onDiskThreshold: normalizeBoolean(
              agentSetting.onDiskThreshold ?? agentSetting.on_disk_threshold
            ),
            diskThreshold: normalizeNumber(
              agentSetting.diskThreshold ?? agentSetting.disk_threshold,
              normalized.agents.diskThreshold
            ),
            cooldownMinutes: normalizeNumber(
              agentSetting.cooldownMinutes ?? agentSetting.cooldown_minutes,
              normalized.agents.cooldownMinutes
            ),
            channels: normalizeChannelIds(agentSetting.channels),
          };
        }
      }
    );
  }

  return normalized;
};

// 获取完整的通知配置
export const getNotificationConfig =
  async (): Promise<NotificationConfigResponse> => {
    try {
      const response = await api.get<{
        success: boolean;
        message?: string;
        data?: {
          channels?: BackendNotificationChannel[];
          templates?: BackendNotificationTemplate[];
          settings?: unknown;
        };
      }>("/api/notifications");

      const backendData = response.data.data;

      if (!backendData) {
        return {
          success: response.data.success,
          message: response.data.message,
        };
      }

      const channels = Array.isArray(backendData.channels)
        ? (backendData.channels as BackendNotificationChannel[]).map(
            transformChannel
          )
        : [];

      const templates = Array.isArray(backendData.templates)
        ? (backendData.templates as BackendNotificationTemplate[]).map(
            transformTemplate
          )
        : [];

      return {
        success: response.data.success,
        message: response.data.message,
        data: {
          channels,
          templates,
          settings: normalizeSettings(backendData.settings),
        },
      };
    } catch (error) {
      console.error("获取通知配置失败:", error);
      return {
        success: false,
        message: "获取通知配置失败",
      };
    }
  };

// 获取通知渠道列表
export const getNotificationChannels = async (): Promise<{
  success: boolean;
  message?: string;
  channels?: NotificationChannel[];
}> => {
  try {
    const response = await api.get<{
      success: boolean;
      message?: string;
      data?: BackendNotificationChannel[];
    }>("/api/notifications/channels");

    const channels = Array.isArray(response.data.data)
      ? response.data.data.map(transformChannel)
      : [];

    return {
      success: response.data.success,
      message: response.data.message,
      channels,
    };
  } catch (error) {
    console.error("获取通知渠道失败:", error);
    return {
      success: false,
      message: "获取通知渠道失败",
    };
  }
};

// 获取通知模板列表
export const getNotificationTemplates = async (): Promise<{
  success: boolean;
  message?: string;
  templates?: NotificationTemplate[];
}> => {
  try {
    const response = await api.get<{
      success: boolean;
      message?: string;
      data?: BackendNotificationTemplate[];
    }>("/api/notifications/templates");

    const templates = Array.isArray(response.data.data)
      ? response.data.data.map(transformTemplate)
      : [];

    return {
      success: response.data.success,
      message: response.data.message,
      templates,
    };
  } catch (error) {
    console.error("获取通知模板失败:", error);
    return {
      success: false,
      message: "获取通知模板失败",
    };
  }
};

// 保存通知设置
export const saveNotificationSettings = async (
  settings: NotificationSettings
): Promise<{
  success: boolean;
  message?: string;
}> => {
  try {
    // 创建一个请求队列，用于批量保存设置
    const saveRequests: Promise<AxiosResponse<{ success?: boolean }>>[] = [];

    // 转换全局监控设置
    const monitorSettings = {
      target_type: "global-monitor",
      enabled: settings.monitors.enabled,
      on_down: settings.monitors.onDown,
      on_recovery: settings.monitors.onRecovery,
      cooldown_minutes: settings.monitors.cooldownMinutes,
      channels: JSON.stringify(settings.monitors.channels),
    };

    saveRequests.push(api.post("/api/notifications/settings", monitorSettings));

    // 转换全局客户端设置
    const agentSettings = {
      target_type: "global-agent",
      enabled: settings.agents.enabled,
      on_offline: settings.agents.onOffline,
      on_recovery: settings.agents.onRecovery,
      on_cpu_threshold: settings.agents.onCpuThreshold,
      cpu_threshold: settings.agents.cpuThreshold,
      on_memory_threshold: settings.agents.onMemoryThreshold,
      memory_threshold: settings.agents.memoryThreshold,
      on_disk_threshold: settings.agents.onDiskThreshold,
      disk_threshold: settings.agents.diskThreshold,
      cooldown_minutes: settings.agents.cooldownMinutes,
      channels: JSON.stringify(settings.agents.channels),
    };

    saveRequests.push(api.post("/api/notifications/settings", agentSettings));

    // 处理特定监控设置
    for (const monitorId in settings.specificMonitors) {
      const monitorSetting = settings.specificMonitors[monitorId];

      const specificMonitorSettings = {
        target_type: "monitor",
        target_id: parseInt(monitorId),
        enabled: monitorSetting.enabled,
        on_down: monitorSetting.onDown,
        on_recovery: monitorSetting.onRecovery,
        cooldown_minutes: monitorSetting.cooldownMinutes,
        channels: JSON.stringify(monitorSetting.channels),
      };

      saveRequests.push(
        api.post("/api/notifications/settings", specificMonitorSettings)
      );
    }

    // 处理特定客户端设置
    for (const agentId in settings.specificAgents) {
      const agentSetting = settings.specificAgents[agentId];

      const specificAgentSettings = {
        target_type: "agent",
        target_id: parseInt(agentId),
        enabled: agentSetting.enabled,
        on_offline: agentSetting.onOffline,
        on_recovery: agentSetting.onRecovery,
        on_cpu_threshold: agentSetting.onCpuThreshold,
        cpu_threshold: agentSetting.cpuThreshold,
        on_memory_threshold: agentSetting.onMemoryThreshold,
        memory_threshold: agentSetting.memoryThreshold,
        on_disk_threshold: agentSetting.onDiskThreshold,
        disk_threshold: agentSetting.diskThreshold,
        cooldown_minutes: agentSetting.cooldownMinutes,
        channels: JSON.stringify(agentSetting.channels),
      };

      saveRequests.push(
        api.post("/api/notifications/settings", specificAgentSettings)
      );
    }

    // 并行执行所有保存请求
    const results = await Promise.all(saveRequests);

    // 检查是否有任何请求失败
    const failedRequests = results.filter(
      (response) => !response.data?.success
    );

    if (failedRequests.length > 0) {
      console.error("部分通知设置保存失败:", failedRequests);
      return {
        success: false,
        message: "部分通知设置保存失败",
      };
    }

    return {
      success: true,
      message: "通知设置保存成功",
    };
  } catch (error) {
    console.error("保存通知设置失败:", error);
    return {
      success: false,
      message: "保存通知设置失败",
    };
  }
};

// 创建通知渠道
export const createNotificationChannel = async (
  channel: Omit<NotificationChannel, "id" | "createdBy" | "createdAt" | "updatedAt">
): Promise<{
  success: boolean;
  message?: string;
  channelId?: number;
}> => {
  try {
    const response = await api.post<{
      success: boolean;
      message?: string;
      data?: { id: number };
    }>("/api/notifications/channels", channel);

    return {
      success: response.data.success,
      message: response.data.message,
      channelId: response.data.data?.id,
    };
  } catch (error) {
    console.error("创建通知渠道失败:", error);
    return {
      success: false,
      message: "创建通知渠道失败",
    };
  }
};

// 更新通知渠道
export const updateNotificationChannel = async (
  id: number,
  channel: Partial<
    Omit<NotificationChannel, "id" | "createdBy" | "createdAt" | "updatedAt">
  >
): Promise<{
  success: boolean;
  message?: string;
}> => {
  try {
    const payload: Record<string, unknown> = {};
    if (channel.name !== undefined) payload.name = channel.name;
    if (channel.type !== undefined) payload.type = channel.type;
    if (channel.config !== undefined) payload.config = channel.config;
    if (channel.enabled !== undefined) payload.enabled = channel.enabled;

    const response = await api.put<{
      success: boolean;
      message?: string;
    }>(`/api/notifications/channels/${id}`, payload);

    return response.data;
  } catch (error) {
    console.error("更新通知渠道失败:", error);
    return {
      success: false,
      message: "更新通知渠道失败",
    };
  }
};

// 删除通知渠道
export const deleteNotificationChannel = async (
  id: number
): Promise<{
  success: boolean;
  message?: string;
}> => {
  try {
    const response = await api.delete<{
      success: boolean;
      message?: string;
    }>(`/api/notifications/channels/${id}`);

    return response.data;
  } catch (error) {
    console.error("删除通知渠道失败:", error);
    return {
      success: false,
      message: "删除通知渠道失败",
    };
  }
};

// 创建通知模板
export const createNotificationTemplate = async (
  template: Omit<NotificationTemplate, "id" | "createdBy" | "createdAt" | "updatedAt">
): Promise<{
  success: boolean;
  message?: string;
  templateId?: number;
}> => {
  try {
    const payload = {
      name: template.name,
      type: template.type,
      subject: template.subject,
      content: template.content,
      is_default: template.isDefault,
    };

    const response = await api.post<{
      success: boolean;
      message?: string;
      data?: { id: number };
    }>("/api/notifications/templates", payload);

    return {
      success: response.data.success,
      message: response.data.message,
      templateId: response.data.data?.id,
    };
  } catch (error) {
    console.error("创建通知模板失败:", error);
    return {
      success: false,
      message: "创建通知模板失败",
    };
  }
};

// 更新通知模板
export const updateNotificationTemplate = async (
  id: number,
  template: Partial<
    Omit<NotificationTemplate, "id" | "createdBy" | "createdAt" | "updatedAt">
  >
): Promise<{
  success: boolean;
  message?: string;
}> => {
  try {
    const payload: Record<string, unknown> = {};
    if (template.name !== undefined) payload.name = template.name;
    if (template.type !== undefined) payload.type = template.type;
    if (template.subject !== undefined) payload.subject = template.subject;
    if (template.content !== undefined) payload.content = template.content;
    if (template.isDefault !== undefined) {
      payload.is_default = template.isDefault;
    }

    const response = await api.put<{ success: boolean; message?: string }>(
      `/api/notifications/templates/${id}`,
      payload
    );
    return response.data;
  } catch (error) {
    console.error("更新通知模板失败:", error);
    return {
      success: false,
      message: "更新通知模板失败",
    };
  }
};

// 删除通知模板
export const deleteNotificationTemplate = async (
  id: number
): Promise<{
  success: boolean;
  message?: string;
}> => {
  try {
    const response = await api.delete(`/api/notifications/templates/${id}`);
    return response.data;
  } catch (error) {
    console.error("删除通知模板失败:", error);
    return {
      success: false,
      message: "删除通知模板失败",
    };
  }
};

// 获取通知历史记录
export const getNotificationHistory = async (params: {
  type?: string;
  targetId?: number;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  success: boolean;
  message?: string;
  data?: unknown[];
}> => {
  try {
    // 构建查询参数
    const queryParams = new URLSearchParams();
    if (params.type) queryParams.append("type", params.type);
    if (params.targetId !== undefined)
      queryParams.append("targetId", params.targetId.toString());
    if (params.status) queryParams.append("status", params.status);
    if (params.limit !== undefined)
      queryParams.append("limit", params.limit.toString());
    if (params.offset !== undefined)
      queryParams.append("offset", params.offset.toString());

    const url = `/api/notifications/history?${queryParams.toString()}`;
    const response = await api.get(url);

    return response.data;
  } catch (error) {
    console.error("获取通知历史记录失败:", error);
    return {
      success: false,
      message: "获取通知历史记录失败",
    };
  }
};
