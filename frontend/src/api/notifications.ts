import type { components } from "./generated/v2-schema";
import { unwrapOpenApi, v2Client } from "./generated/v2-client";
import type {
  NotificationChannel,
  NotificationConfig,
  NotificationTemplate,
} from "../types/notification";

type BackendNotificationChannel =
  components["schemas"]["NotificationChannel"];
type BackendNotificationTemplate =
  components["schemas"]["NotificationTemplate"];
type NotificationChannelCommand =
  components["schemas"]["NotificationChannelCommand"];
type NotificationChannelMutation =
  components["schemas"]["NotificationChannelMutation"];

export type NotificationSettings = NotificationConfig["settings"];
export type NotificationResourceTarget = "monitor" | "agent";
export interface NotificationResourceSetting {
  target_type: NotificationResourceTarget;
  id: number;
  name: string;
  description: string | null;
  sort_order: number;
  setting:
    | NotificationSettings["monitors"]
    | NotificationSettings["agents"]
    | null;
}
export interface NotificationResourceSettingPage {
  data: NotificationResourceSetting[];
  next_cursor: string | null;
  has_more: boolean;
}

type RawNotificationSettings = {
  monitors?: unknown;
  agents?: unknown;
  specificMonitors?: unknown;
  specificAgents?: unknown;
};

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
    } catch {
      return {};
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
    } catch {
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
  createdAt: channel.created_at ?? undefined,
  updatedAt: channel.updated_at ?? undefined,
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
  createdAt: template.created_at ?? undefined,
  updatedAt: template.updated_at ?? undefined,
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

export const getNotificationConfig = async (): Promise<NotificationConfig> => {
  const response = unwrapOpenApi(await v2Client.GET("/api/v2/notifications"));
  const backendData = response.data;
  return {
    channels: backendData.channels.map(transformChannel),
    templates: backendData.templates.map(transformTemplate),
    channelsHasMore: backendData.channels_has_more,
    templatesHasMore: backendData.templates_has_more,
    settings: normalizeSettings(backendData.settings),
  };
};

export const getNotificationChannels = async (): Promise<
  NotificationChannel[]
> => {
  const response = unwrapOpenApi(
    await v2Client.GET("/api/v2/notifications/channels")
  );
  return response.data.map(transformChannel);
};

export const getNotificationTemplates = async (): Promise<
  NotificationTemplate[]
> => {
  const response = unwrapOpenApi(
    await v2Client.GET("/api/v2/notifications/templates")
  );
  return response.data.map(transformTemplate);
};

export const getNotificationResourceSettings = async (
  targetType: NotificationResourceTarget,
  input: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<NotificationResourceSettingPage> => {
  const response = unwrapOpenApi(
    await v2Client.GET("/api/v2/notifications/resource-settings", {
      params: {
        query: {
          target_type: targetType,
          cursor: input.cursor,
          limit: input.limit ?? 25,
        },
      },
      signal,
    })
  );
  return response as NotificationResourceSettingPage;
};

type SettingCommand = components["schemas"]["NotificationSettingCommand"];

function settingCommands(settings: NotificationSettings): SettingCommand[] {
  const commands: SettingCommand[] = [
    {
      target_type: "global-monitor",
      target_id: 0,
      enabled: settings.monitors.enabled,
      on_down: settings.monitors.onDown,
      on_recovery: settings.monitors.onRecovery,
      cooldown_minutes: settings.monitors.cooldownMinutes,
      channels: settings.monitors.channels,
    },
    {
      target_type: "global-agent",
      target_id: 0,
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
      channels: settings.agents.channels,
    },
  ];
  for (const [monitorId, value] of Object.entries(settings.specificMonitors)) {
    commands.push({
      target_type: "monitor",
      target_id: Number(monitorId),
      enabled: value.enabled,
      on_down: value.onDown,
      on_recovery: value.onRecovery,
      cooldown_minutes: value.cooldownMinutes,
      channels: value.channels,
    });
  }
  for (const [agentId, value] of Object.entries(settings.specificAgents)) {
    commands.push({
      target_type: "agent",
      target_id: Number(agentId),
      enabled: value.enabled,
      on_offline: value.onOffline,
      on_recovery: value.onRecovery,
      on_cpu_threshold: value.onCpuThreshold,
      cpu_threshold: value.cpuThreshold,
      on_memory_threshold: value.onMemoryThreshold,
      memory_threshold: value.memoryThreshold,
      on_disk_threshold: value.onDiskThreshold,
      disk_threshold: value.diskThreshold,
      cooldown_minutes: value.cooldownMinutes,
      channels: value.channels,
    });
  }
  return commands;
}

let pendingSettingsCommand: { fingerprint: string; key: string } | null = null;

export const saveNotificationSettings = async (
  settings: NotificationSettings
): Promise<void> => {
  const commands = settingCommands(settings);
  const fingerprint = JSON.stringify(commands);
  if (!pendingSettingsCommand || pendingSettingsCommand.fingerprint !== fingerprint) {
    pendingSettingsCommand = {
      fingerprint,
      key: `notification-settings:${crypto.randomUUID()}`,
    };
  }
  unwrapOpenApi(
    await v2Client.PUT("/api/v2/notifications/settings/bulk", {
      params: { header: { "Idempotency-Key": pendingSettingsCommand.key } },
      body: { settings: commands },
    })
  );
  pendingSettingsCommand = null;
};

export const createNotificationChannel = async (
  channel: NotificationChannelCommand
): Promise<void> => {
  unwrapOpenApi(
    await v2Client.POST("/api/v2/notifications/channels", { body: channel })
  );
};

export const updateNotificationChannel = async (
  id: number,
  channel: NotificationChannelMutation
): Promise<void> => {
  unwrapOpenApi(
    await v2Client.PATCH("/api/v2/notifications/channels/{id}", {
      params: { path: { id } },
      body: channel,
    })
  );
};

export const deleteNotificationChannel = async (
  id: number
): Promise<void> => {
  const result = await v2Client.DELETE("/api/v2/notifications/channels/{id}", {
    params: { path: { id } },
  });
  if (!result.response.ok) unwrapOpenApi(result);
};

export const testNotificationChannel = async (
  id: number
): Promise<void> => {
  unwrapOpenApi(
    await v2Client.POST("/api/v2/notifications/channels/{id}/test", {
      params: { path: { id } },
    })
  );
};

export const createNotificationTemplate = async (
  template: Omit<NotificationTemplate, "id" | "createdAt" | "updatedAt">
): Promise<void> => {
  const body: components["schemas"]["NotificationTemplateCommand"] = {
    name: template.name,
    type: template.type === "agent" ? "agent" : "monitor",
    subject: template.subject,
    content: template.content,
    is_default: template.isDefault,
  };
  unwrapOpenApi(
    await v2Client.POST("/api/v2/notifications/templates", { body })
  );
};

export const updateNotificationTemplate = async (
  id: number,
  template: Partial<Omit<NotificationTemplate, "id" | "createdAt" | "updatedAt">>
): Promise<void> => {
  const body: components["schemas"]["NotificationTemplateMutation"] = {};
  if (template.name !== undefined) body.name = template.name;
  if (template.type !== undefined)
    body.type = template.type === "agent" ? "agent" : "monitor";
  if (template.subject !== undefined) body.subject = template.subject;
  if (template.content !== undefined) body.content = template.content;
  if (template.isDefault !== undefined) body.is_default = template.isDefault;
  unwrapOpenApi(
    await v2Client.PATCH("/api/v2/notifications/templates/{id}", {
      params: { path: { id } },
      body,
    })
  );
};

export const deleteNotificationTemplate = async (
  id: number
): Promise<void> => {
  const result = await v2Client.DELETE("/api/v2/notifications/templates/{id}", {
      params: { path: { id } },
  });
  if (!result.response.ok) unwrapOpenApi(result);
};

export const getNotificationHistory = async (params: {
  type?: "monitor" | "agent";
  targetId?: number;
  status?: "success" | "failed";
  limit?: number;
  cursor?: number;
}): Promise<{
  data: components["schemas"]["NotificationHistory"][];
  nextCursor: number | null;
  hasMore: boolean;
}> => {
  const response = unwrapOpenApi(
    await v2Client.GET("/api/v2/notifications/history", {
      params: {
        query: {
          type: params.type,
          target_id: params.targetId,
          status: params.status,
          limit: params.limit,
          cursor: params.cursor,
        },
      },
    })
  );
  return {
    data: response.data,
    nextCursor: response.next_cursor,
    hasMore: response.has_more,
  };
};
