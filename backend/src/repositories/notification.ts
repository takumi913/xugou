import {
  NotificationChannel,
  NotificationTemplate,
  NotificationSettings,
  NotificationHistory,
  NotificationConfig,
} from "../models";
import { db } from "../config";
import {
  notificationChannels,
  notificationTemplates,
  notificationSettings,
  notificationHistory,
} from "../db/schema";
import { eq, desc, asc, and, count, isNull, inArray, gte } from "drizzle-orm";

// 获取指定用户的所有通知渠道
export const getNotificationChannels = async (userId: number): Promise<
  NotificationChannel[]
> => {
  const result = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.created_by, userId)) // 根据用户ID过滤
    .orderBy(asc(notificationChannels.id));
  return result || [];
};

// 根据ID和用户ID获取通知渠道
export const getNotificationChannelById = async (
  id: number,
  userId: number
): Promise<NotificationChannel | null> => {
  const result = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.id, id), eq(notificationChannels.created_by, userId))); // 增加用户ID校验
  return result[0];
};

// 创建通知渠道 (保留不变, created_by 已包含用户信息)
export const createNotificationChannel = async (
  channel: Omit<NotificationChannel, "id" | "created_at" | "updated_at">
): Promise<number> => {
  const result = await db
    .insert(notificationChannels)
    .values({
      name: channel.name,
      type: channel.type,
      config: channel.config,
      enabled: channel.enabled ? 1 : 0,
      created_by: channel.created_by,
    })
    .returning();

  return result[0].id;
};

// 更新通知渠道
export const updateNotificationChannel = async (
  id: number,
  userId: number,
  channel: Partial<
    Omit<NotificationChannel, "id" | "created_at" | "updated_at">
  >
): Promise<boolean> => {
  const result = await db
    .update(notificationChannels)
    .set({
      name: channel.name,
      type: channel.type,
      config: channel.config,
      enabled: channel.enabled ? 1 : 0,
      updated_at: new Date().toISOString(),
    })
    .where(and(eq(notificationChannels.id, id), eq(notificationChannels.created_by, userId))); // 增加用户ID校验

  return result.success;
};

// 删除通知渠道
export const deleteNotificationChannel = async (
  id: number,
  userId: number
): Promise<boolean> => {
  try {
    // 先删除通知历史记录表中的关联记录
    await db
      .delete(notificationHistory)
      .where(eq(notificationHistory.channel_id, id));

    // 再检查并更新属于该用户的通知设置中的channels列表
    const allSettings = await db.select().from(notificationSettings).where(eq(notificationSettings.user_id, userId));

    // 遍历所有设置，从channels列表中移除要删除的渠道ID
    if (allSettings && allSettings.length > 0) {
      for (const setting of allSettings) {
        try {
          const channelsList = JSON.parse(setting.channels || "[]");
          const newChannelsList = channelsList.filter(
            (channelId: number) => channelId !== id
          );

          // 如果列表变化了，更新数据库
          if (JSON.stringify(channelsList) !== JSON.stringify(newChannelsList)) {
            await db
              .update(notificationSettings)
              .set({
                channels: JSON.stringify(newChannelsList),
              })
              .where(eq(notificationSettings.id, setting.id));
          }
        } catch (error) {
          console.error("解析通知设置渠道列表出错:", error);
        }
      }
    }

    // 最后删除通知渠道本身
    await db
      .delete(notificationChannels)
      .where(and(eq(notificationChannels.id, id), eq(notificationChannels.created_by, userId))); // 增加用户ID校验

    return true; // 假设没有错误就是成功
  } catch (error) {
    console.error("删除通知渠道失败:", error);
    return false;
  }
};

// 获取指定用户的所有通知模板
export const getNotificationTemplates = async (userId: number): Promise<
  NotificationTemplate[]
> => {
  const result = await db
    .select()
    .from(notificationTemplates)
    .where(eq(notificationTemplates.created_by, userId)) // 根据用户ID过滤
    .orderBy(
      desc(notificationTemplates.is_default),
      asc(notificationTemplates.id)
    );
  return result || [];
};

// 根据ID和用户ID获取通知模板
export const getNotificationTemplateById = async (
  id: number,
  userId: number
): Promise<NotificationTemplate | null> => {
  const result = await db
    .select()
    .from(notificationTemplates)
    .where(and(eq(notificationTemplates.id, id), eq(notificationTemplates.created_by, userId)));
  return result[0];
};

// 创建通知模板 (保留不变, created_by 已包含用户信息)
export const createNotificationTemplate = async (
  template: Omit<NotificationTemplate, "id" | "created_at" | "updated_at">
): Promise<number> => {
  const result = await db
    .insert(notificationTemplates)
    .values({
      name: template.name,
      type: template.type,
      subject: template.subject,
      content: template.content,
      is_default: template.is_default ? 1 : 0,
      created_by: template.created_by,
    })
    .returning();

  return result[0].id;
};

// 更新通知模板
export const updateNotificationTemplate = async (
  id: number,
  userId: number,
  template: Partial<
    Omit<NotificationTemplate, "id" | "created_at" | "updated_at">
  >
): Promise<boolean> => {
  const updateData: Partial<typeof notificationTemplates.$inferInsert> = {};

  if (template.name !== undefined) {
    updateData.name = template.name;
  }

  if (template.type !== undefined) {
    updateData.type = template.type;
  }

  if (template.subject !== undefined) {
    updateData.subject = template.subject;
  }

  if (template.content !== undefined) {
    updateData.content = template.content;
  }

  if (template.is_default !== undefined) {
    updateData.is_default = template.is_default ? 1 : 0;
  }

  if (Object.keys(updateData).length === 0) {
    return true; // 没有需要更新的字段时视为成功
  }

  const result = await db
    .update(notificationTemplates)
    .set(updateData)
    .where(and(eq(notificationTemplates.id, id), eq(notificationTemplates.created_by, userId)));

  return result.success; // fix: 返回 success 布尔值
};

// 删除通知模板
export const deleteNotificationTemplate = async (
  id: number,
  userId: number
): Promise<boolean> => {
  const result = await db
    .delete(notificationTemplates)
    .where(and(eq(notificationTemplates.id, id), eq(notificationTemplates.created_by, userId)));

  return result.success; // fix: 返回 success 布尔值
};


// 获取指定用户的全局通知设置
export const getGlobalSettings = async (userId: number): Promise<{
  monitorSettings: NotificationSettings | null;
  agentSettings: NotificationSettings | null;
}> => {
  const monitorSettings = await db
    .select()
    .from(notificationSettings)
    .where(and(eq(notificationSettings.target_type, "global-monitor"), eq(notificationSettings.user_id, userId)));

  const agentSettings = await db
    .select()
    .from(notificationSettings)
    .where(and(eq(notificationSettings.target_type, "global-agent"), eq(notificationSettings.user_id, userId)));

  return {
    monitorSettings: monitorSettings[0],
    agentSettings: agentSettings[0],
  };
};

// 获取指定用户的特定对象的通知设置
export const getSpecificSettings = async (
  userId: number,
  targetType: "monitor" | "agent",
  targetId?: number
): Promise<NotificationSettings[]> => {
  if (targetId !== undefined) {
    return await db
      .select()
      .from(notificationSettings)
      .where(
        and(
          eq(notificationSettings.target_type, targetType),
          eq(notificationSettings.target_id, targetId),
          eq(notificationSettings.user_id, userId)
        )
      );
  }
  return await db
    .select()
    .from(notificationSettings)
    .where(and(eq(notificationSettings.target_type, targetType), eq(notificationSettings.user_id, userId)));
};


// 创建或更新通知设置
export const createOrUpdateSettings = async (
  settings: Omit<NotificationSettings, "id" | "created_at" | "updated_at">
): Promise<number> => {
  // 确保target_id为0时使用isNull，否则使用eq
  const condition =
    settings.target_id === 0
      ? isNull(notificationSettings.target_id)
      : eq(notificationSettings.target_id, settings.target_id);
  // 先检查是否已存在相同的设置
  const existingSettings = await db
    .select()
    .from(notificationSettings)
    .where(
      and(eq(notificationSettings.target_type, settings.target_type), eq(notificationSettings.user_id, settings.user_id), condition)
    );

  if (existingSettings.length > 0) {
    const existingSetting = existingSettings[0];
    // 如果已存在则更新
    await db
      .update(notificationSettings)
      .set({
        enabled: settings.enabled ? 1 : 0,
        on_down: settings.on_down ? 1 : 0,
        on_recovery: settings.on_recovery ? 1 : 0,
        on_offline: settings.on_offline ? 1 : 0,
        on_cpu_threshold: settings.on_cpu_threshold ? 1 : 0,
        cpu_threshold: settings.cpu_threshold,
        on_memory_threshold: settings.on_memory_threshold ? 1 : 0,
        memory_threshold: settings.memory_threshold,
        on_disk_threshold: settings.on_disk_threshold ? 1 : 0,
        disk_threshold: settings.disk_threshold,
        cooldown_minutes: settings.cooldown_minutes,
        channels: settings.channels,
        updated_at: new Date().toISOString(),
      })
      .where(eq(notificationSettings.id, existingSetting.id));
    return existingSetting.id;
  } else {
    // 如果不存在则创建
    const result = await db
      .insert(notificationSettings)
      .values({
        user_id: settings.user_id,
        target_type: settings.target_type,
        target_id: settings.target_id,
        enabled: settings.enabled ? 1 : 0,
        on_down: settings.on_down ? 1 : 0,
        on_recovery: settings.on_recovery ? 1 : 0,
        on_offline: settings.on_offline ? 1 : 0,
        on_cpu_threshold: settings.on_cpu_threshold ? 1 : 0,
        cpu_threshold: settings.cpu_threshold,
        on_memory_threshold: settings.on_memory_threshold ? 1 : 0,
        memory_threshold: settings.memory_threshold,
        on_disk_threshold: settings.on_disk_threshold ? 1 : 0,
        disk_threshold: settings.disk_threshold,
        cooldown_minutes: settings.cooldown_minutes,
        channels: settings.channels,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .returning();

    return result[0].id;
  }
};


// 记录通知历史 (保留不变)
export const createNotificationHistory = async (
  history: Omit<NotificationHistory, "id" | "sent_at">
): Promise<number> => {
  const result = await db
    .insert(notificationHistory)
    .values({
      type: history.type,
      target_id: history.target_id,
      channel_id: history.channel_id,
      template_id: history.template_id,
      status: history.status,
      content: history.content,
      error: history.error,
      sent_at: new Date().toISOString(),
    })
    .returning();

  return result[0].id;
};

export const getRecentSuccessfulNotificationHistory = async (filter: {
  type: "monitor" | "agent" | "system";
  targetId: number | null;
  channelId: number;
  since: string;
  limit?: number;
}): Promise<NotificationHistory[]> => {
  const targetCondition =
    filter.targetId === null
      ? isNull(notificationHistory.target_id)
      : eq(notificationHistory.target_id, filter.targetId);

  return await db
    .select()
    .from(notificationHistory)
    .where(
      and(
        eq(notificationHistory.type, filter.type),
        targetCondition,
        eq(notificationHistory.channel_id, filter.channelId),
        eq(notificationHistory.status, "success"),
        gte(notificationHistory.sent_at, filter.since)
      )
    )
    .orderBy(desc(notificationHistory.sent_at))
    .limit(filter.limit ?? 20);
};

// 获取通知历史记录 (这个可以考虑是否也需要用户隔离)
export const getNotificationHistory = async (filter: {
  type?: string | undefined;
  targetId?: number | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}): Promise<{ total: number; records: NotificationHistory[] }> => {
  // 构建查询
  let whereConditions = [];
  let whereParams = [];

  if (filter.type) {
    whereConditions.push("type = ?");
    whereParams.push(filter.type);
  }

  if (filter.targetId !== undefined) {
    whereConditions.push("target_id = ?");
    whereParams.push(filter.targetId);
  }

  if (filter.status) {
    whereConditions.push("status = ?");
    whereParams.push(filter.status);
  }

  const whereClause =
    whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  // 查询总数
  const countResult = await db
    .select({ count: count() })
    .from(notificationHistory)
    .where(whereClause);
  const total = countResult?.count || 0;

  // 查询记录

  const recordsResult = await db
    .select()
    .from(notificationHistory)
    .where(whereClause)
    .orderBy(desc(notificationHistory.sent_at))
    .limit(filter.limit || 10)
    .offset(filter.offset || 0);

  return {
    total,
    records: recordsResult || [],
  };
};

// 获取指定用户的完整通知配置
export const getNotificationConfig = async (userId: number): Promise<NotificationConfig> => {
  // 获取所有渠道
  const channels = await getNotificationChannels(userId);

  // 获取所有模板
  const templates = await getNotificationTemplates(userId);

  // 获取全局设置
  const globalSettings = await getGlobalSettings(userId);

  // 获取特定监控项设置
  const monitorSettings = await getSpecificSettings(userId, "monitor");

  // 获取特定客户端设置
  const agentSettings = await getSpecificSettings(userId, "agent");

  // 构建通知配置
  const config: NotificationConfig = {
    channels: channels,
    templates: templates,
    settings: {
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
    },
  };

  // 如果找到全局设置，应用到配置对象
  if (globalSettings.monitorSettings) {
    config.settings.monitors = {
      enabled: globalSettings.monitorSettings.enabled,
      onDown: globalSettings.monitorSettings.on_down,
      onRecovery: globalSettings.monitorSettings.on_recovery,
      cooldownMinutes: globalSettings.monitorSettings.cooldown_minutes,
      channels: JSON.parse(globalSettings.monitorSettings.channels || "[]"),
    };
  }

  if (globalSettings.agentSettings) {
    config.settings.agents = {
      enabled: globalSettings.agentSettings.enabled,
      onOffline: globalSettings.agentSettings.on_offline,
      onRecovery: globalSettings.agentSettings.on_recovery,
      onCpuThreshold: globalSettings.agentSettings.on_cpu_threshold,
      cpuThreshold: globalSettings.agentSettings.cpu_threshold,
      onMemoryThreshold: globalSettings.agentSettings.on_memory_threshold,
      memoryThreshold: globalSettings.agentSettings.memory_threshold,
      onDiskThreshold: globalSettings.agentSettings.on_disk_threshold,
      diskThreshold: globalSettings.agentSettings.disk_threshold,
      cooldownMinutes: globalSettings.agentSettings.cooldown_minutes,
      channels: JSON.parse(globalSettings.agentSettings.channels || "[]"),
    };
  }

  // 处理特定监控项设置
  for (const setting of monitorSettings) {
    const monitorId = setting.target_id!.toString();

    config.settings.specificMonitors[monitorId] = {
      enabled: setting.enabled,
      onDown: setting.on_down,
      onRecovery: setting.on_recovery,
      cooldownMinutes: setting.cooldown_minutes,
      channels: JSON.parse(setting.channels),
    };
  }

  // 处理特定客户端设置
  for (const setting of agentSettings) {
    const agentId = setting.target_id!.toString();

    config.settings.specificAgents[agentId] = {
      enabled: setting.enabled,
      onOffline: setting.on_offline,
      onRecovery: setting.on_recovery,
      onCpuThreshold: setting.on_cpu_threshold,
      cpuThreshold: setting.cpu_threshold,
      onMemoryThreshold: setting.on_memory_threshold,
      memoryThreshold: setting.memory_threshold,
      onDiskThreshold: setting.on_disk_threshold,
      diskThreshold: setting.disk_threshold,
      cooldownMinutes: setting.cooldown_minutes,
      channels: JSON.parse(setting.channels),
    };
  }

  return config;
};

/**
 * 删除通知设置
 * @param type 通知类型，"monitor" 或 "agent"
 * @param id 目标ID，监控或客户端的ID
 * @return {Promise<boolean>} 删除是否成功
 */
export const deleteNotificationSettings = async (
  type: "monitor" | "agent",
  id: number,
  userId: number,
): Promise<boolean> => {
  // 执行删除操作
  try {
    await db
      .delete(notificationSettings)
      .where(
        and(
          eq(notificationSettings.target_type, type),
          eq(notificationSettings.target_id, id),
          eq(notificationSettings.user_id, userId)
        )
      );
  } catch (error) {
    console.error("[删除通知设置] 删除通知设置失败:", error);
    throw new Error("删除通知设置失败");
  }

  return true;
};

// 新增：根据用户ID删除通知设置
export const deleteNotificationSettingsByUserId = async (
  userId: number
): Promise<void> => {
  await db.delete(notificationSettings).where(eq(notificationSettings.user_id, userId));
};

// 新增：根据用户ID删除通知模板
export const deleteNotificationTemplatesByUserId = async (
  userId: number
): Promise<void> => {
  await db.delete(notificationTemplates).where(eq(notificationTemplates.created_by, userId));
};

// 新增：根据用户ID删除通知渠道
export const deleteNotificationChannelsByUserId = async (
  userId: number
): Promise<void> => {
  const userChannels = await db.select({id: notificationChannels.id}).from(notificationChannels).where(eq(notificationChannels.created_by, userId));
  if (userChannels.length > 0) {
    // 修复：为 map 回调中的参数 c 显式指定类型
    const channelIds = userChannels.map((c: { id: number }) => c.id);
    // 删除关联的通知历史
    await db.delete(notificationHistory).where(inArray(notificationHistory.channel_id, channelIds));
    // 删除通知渠道
    await db.delete(notificationChannels).where(inArray(notificationChannels.id, channelIds));
  }
};
