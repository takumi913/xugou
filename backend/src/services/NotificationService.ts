import * as models from "../models";
import * as repositories from "../repositories";

const NOTIFICATION_SEND_CONCURRENCY = 3;
const DEFAULT_NOTIFICATION_COOLDOWN_MINUTES = 30;
const NOTIFICATION_CONFIG_CACHE_TTL_MS = 60 * 1000;

type NotificationSendResult = {
  channelId: number;
  success: boolean;
  error?: string;
  skipped?: boolean;
};

type GlobalNotificationSettings = {
  monitorSettings: models.NotificationSettings | null;
  agentSettings: models.NotificationSettings | null;
};

type UserNotificationCache = {
  expiresAt: number;
  templates?: models.NotificationTemplate[];
  globalSettings?: GlobalNotificationSettings;
  specificSettings: Map<string, models.NotificationSettings[]>;
  channels: Map<number, models.NotificationChannel | null>;
};

const notificationConfigCache = new Map<number, UserNotificationCache>();

function getUserNotificationCache(userId: number) {
  const now = Date.now();
  const existing = notificationConfigCache.get(userId);
  if (existing && existing.expiresAt > now) {
    return existing;
  }

  const freshCache: UserNotificationCache = {
    expiresAt: now + NOTIFICATION_CONFIG_CACHE_TTL_MS,
    specificSettings: new Map(),
    channels: new Map(),
  };
  notificationConfigCache.set(userId, freshCache);
  return freshCache;
}

function invalidateNotificationConfigCache(userId: number) {
  notificationConfigCache.delete(userId);
}

async function getCachedNotificationTemplates(userId: number) {
  const cache = getUserNotificationCache(userId);
  if (!cache.templates) {
    cache.templates = await repositories.getNotificationTemplates(userId);
  }
  return cache.templates;
}

async function getCachedGlobalSettings(userId: number) {
  const cache = getUserNotificationCache(userId);
  if (!cache.globalSettings) {
    cache.globalSettings = await repositories.getGlobalSettings(userId);
  }
  return cache.globalSettings;
}

async function getCachedSpecificSettings(
  userId: number,
  type: "monitor" | "agent",
  id: number
) {
  const cache = getUserNotificationCache(userId);
  const key = `${type}:${id}`;
  if (!cache.specificSettings.has(key)) {
    cache.specificSettings.set(
      key,
      await repositories.getSpecificSettings(userId, type, id)
    );
  }
  return cache.specificSettings.get(key) ?? [];
}

async function getCachedNotificationChannelById(id: number, userId: number) {
  const cache = getUserNotificationCache(userId);
  if (!cache.channels.has(id)) {
    cache.channels.set(
      id,
      await repositories.getNotificationChannelById(id, userId)
    );
  }
  return cache.channels.get(id) ?? null;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
) {
  const results: R[] = [];

  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    const batchResults = await Promise.all(batch.map(worker));
    results.push(...batchResults);
  }

  return results;
}

function getNotificationEventKey(
  subject: string,
  variables: Record<string, string>
) {
  return variables.status || subject;
}

function getHistoryEventKey(historyContent: string) {
  try {
    const parsed = JSON.parse(historyContent) as {
      subject?: string;
      variables?: Record<string, string>;
    };
    return parsed.variables?.status || parsed.subject || "";
  } catch {
    return "";
  }
}

function normalizeCooldownMinutes(value: unknown) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) {
    return DEFAULT_NOTIFICATION_COOLDOWN_MINUTES;
  }

  return Math.max(0, Math.min(Math.round(minutes), 1440));
}

// 通知渠道相关服务
export async function getNotificationChannels(
  userId: number
): Promise<models.NotificationChannel[]> {
  return await repositories.getNotificationChannels(userId);
}

export async function getNotificationChannelById(
  id: number,
  userId: number
): Promise<models.NotificationChannel | null> {
  return await repositories.getNotificationChannelById(id, userId);
}

export async function createNotificationChannel(
  channel: Omit<models.NotificationChannel, "id" | "created_at" | "updated_at">
): Promise<{ success: boolean; id?: number; message?: string }> {
  try {
    // @ts-ignore
    const id = await repositories.createNotificationChannel(channel);
    invalidateNotificationConfigCache(channel.created_by);
    return { success: true, id };
  } catch (error) {
    console.error("创建通知渠道失败:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "创建通知渠道失败",
    };
  }
}

export async function updateNotificationChannel(
  id: number,
  userId: number,
  channel: Partial<
    Omit<models.NotificationChannel, "id" | "created_at" | "updated_at">
  >
): Promise<{ success: boolean; message?: string }> {
  try {
    const result = await repositories.updateNotificationChannel(
      id,
      userId,
      channel
    );
    if (result) {
      invalidateNotificationConfigCache(userId);
    }
    return {
      success: result,
      message: result ? "通知渠道更新成功" : "通知渠道不存在或未做任何更改",
    };
  } catch (error) {
    console.error("更新通知渠道失败:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "更新通知渠道失败",
    };
  }
}

export async function deleteNotificationChannel(
  id: number,
  userId: number
): Promise<{ success: boolean; message?: string }> {
  try {
    const result = await repositories.deleteNotificationChannel(id, userId);
    if (result) {
      invalidateNotificationConfigCache(userId);
    }
    return {
      success: result,
      message: result ? "通知渠道删除成功" : "通知渠道不存在",
    };
  } catch (error) {
    console.error("删除通知渠道失败:", error);
    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "删除通知渠道失败，可能存在关联数据",
    };
  }
}

// 通知模板相关服务
export async function getNotificationTemplates(
  userId: number
): Promise<models.NotificationTemplate[]> {
  return await repositories.getNotificationTemplates(userId);
}

export async function getNotificationTemplateById(
  id: number,
  userId: number
): Promise<models.NotificationTemplate | null> {
  return await repositories.getNotificationTemplateById(id, userId);
}

export async function createNotificationTemplate(
  template: Omit<
    models.NotificationTemplate,
    "id" | "created_at" | "updated_at"
  >
): Promise<{ success: boolean; id?: number; message?: string }> {
  try {
    const id = await repositories.createNotificationTemplate(template);
    invalidateNotificationConfigCache(template.created_by);
    return { success: true, id };
  } catch (error) {
    console.error("创建通知模板失败:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "创建通知模板失败",
    };
  }
}

export async function updateNotificationTemplate(
  id: number,
  userId: number,
  template: Partial<
    Omit<models.NotificationTemplate, "id" | "created_at" | "updated_at">
  >
): Promise<{ success: boolean; message?: string }> {
  try {
    const result = await repositories.updateNotificationTemplate(
      id,
      userId,
      template
    );
    if (result) {
      invalidateNotificationConfigCache(userId);
    }
    return {
      success: result,
      message: result ? "通知模板更新成功" : "通知模板不存在或未做任何更改",
    };
  } catch (error) {
    console.error("更新通知模板失败:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "更新通知模板失败",
    };
  }
}

export async function deleteNotificationTemplate(
  id: number,
  userId: number
): Promise<{ success: boolean; message?: string }> {
  try {
    const result = await repositories.deleteNotificationTemplate(id, userId);
    if (result) {
      invalidateNotificationConfigCache(userId);
    }
    return {
      success: result,
      message: result ? "通知模板删除成功" : "通知模板不存在",
    };
  } catch (error) {
    console.error("删除通知模板失败:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "删除通知模板失败",
    };
  }
}

// 通知设置相关服务,获取所有的通知设置
export async function getNotificationConfig(
  userId: number
): Promise<models.NotificationConfig> {
  return await repositories.getNotificationConfig(userId);
}

export async function createOrUpdateSettings(
  settings: Omit<
    models.NotificationSettings,
    "id" | "created_at" | "updated_at"
  >
): Promise<{ success: boolean; id?: number; message?: string }> {
  try {
    const id = await repositories.createOrUpdateSettings(settings);
    invalidateNotificationConfigCache(settings.user_id);
    return { success: true, id };
  } catch (error) {
    console.error("保存通知设置失败:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "保存通知设置失败",
    };
  }
}

// 通知历史相关服务
export async function getNotificationHistory(filter: {
  type?: string | undefined;
  targetId?: number | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}): Promise<{ total: number; records: models.NotificationHistory[] }> {
  return await repositories.getNotificationHistory(filter);
}

// 从utils/notification.ts移植过来的通知发送逻辑
// 变量替换函数 - 替换模板中的变量
function replaceVariables(
  text: string,
  variables: Record<string, string>
): string {
  let result = text;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\$\\{${key}\\}`, "g"), value);
  }
  return result;
}

// 通知渠道配置接口定义
interface TelegramConfig {
  botToken: string;
  chatId: string;
}

// 邮件配置接口
interface ResendConfig {
  apiKey: string;
  from: string;
  to: string;
}

// 飞书配置接口
interface FeishuConfig {
  webhookUrl: string;
}

// 企业微信配置接口
interface WeComConfig {
  webhookUrl: string;
}

/**
 * 解析通知渠道配置
 */
function parseChannelConfig<T>(channel: models.NotificationChannel): T {
  try {
    let config: any;
    if (typeof channel.config === "string") {
      // 如果是字符串，尝试解析为JSON对象
      try {
        config = JSON.parse(channel.config);
      } catch (jsonError) {
        console.error(
          `[解析配置] 解析渠道${channel.id}的JSON配置失败:`,
          jsonError
        );
        return {} as T;
      }
    } else if (typeof channel.config === "object") {
      // 如果已经是对象，直接使用
      config = channel.config;
    } else {
      console.error(`[解析配置] 无效的配置格式: ${typeof channel.config}`);
      return {} as T;
    }

    return config as T;
  } catch (e) {
    console.error("[解析配置] 解析渠道配置失败:", e);
    return {} as T;
  }
}

// =================================================================
// Section: 各渠道发送器实现 (Sender Implementations)
// =================================================================

async function sendResendNotification(
  channel: models.NotificationChannel,
  subject: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // 解析渠道配置
    const config = parseChannelConfig<ResendConfig>(channel);

    // 检查必要参数
    if (!config.apiKey) {
      console.error(`[Resend通知] 缺少必要参数: apiKey`);
      return { success: false, error: "Resend API密钥不能为空" };
    }

    if (!config.from) {
      console.error(`[Resend通知] 缺少必要参数: from`);
      return { success: false, error: "Resend发件人不能为空" };
    }

    if (!config.to) {
      console.error(`[Resend通知] 缺少必要参数: to`);
      return { success: false, error: "Resend收件人不能为空" };
    }

    // 提取配置
    const apiKey = config.apiKey;
    const from = config.from;
    const to = config.to.split(",").map((email) => email.trim());

    // 构建请求数据
    const requestData = {
      from: from,
      to: to,
      subject: subject,
      html: content.replace(/\n/g, "<br>"), // 将换行符转换为HTML换行
    };

    // 发送API请求
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestData),
    });

    // 解析响应
    const responseData = await response.json();

    if (response.ok) {
      return { success: true };
    } else {
      console.error(`[Resend通知] 发送失败，状态码: ${response.status}`);
      return {
        success: false,
        error:
          responseData.message || `发送失败，HTTP状态码: ${response.status}`,
      };
    }
  } catch (error) {
    console.error("[Resend通知] 发送Resend通知失败:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 发送Telegram通知
 */
async function sendTelegramNotification(
  channel: models.NotificationChannel,
  subject: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // 解析配置
    const config = parseChannelConfig<TelegramConfig>(channel);

    // 获取Bot令牌和聊天ID
    const botToken = config.botToken;
    const chatId = config.chatId;

    // 组合主题和内容
    let message = `${subject}\n\n${content}`;

    // 处理转义的换行符，确保它们会被正确显示为实际的换行
    message = message.replace(/\\n/g, "\n");

    // 使用POST请求，避免URL中使用chat_id出现的问题
    const apiEndpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;

    // 准备请求体
    const requestBody = {
      chat_id: chatId,
      text: message,
    };

    const response = await fetch(apiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const responseData = await response.json();

    if (responseData.ok === true) {
      return { success: true };
    } else {
      console.error("[Telegram通知] 发送失败");
      return {
        success: false,
        error: responseData.description || "发送失败",
      };
    }
  } catch (error) {
    console.error("发送Telegram通知失败:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// =================================================================
// Section: 新的通知发送器抽象层 (Refactored Sender Abstraction)
// =================================================================

/**
 * 定义了通知发送器的统一接口。
 * 每种通知渠道（如邮件、Telegram）都必须实现这个接口。
 * "Good code is all about making the data structures, so the code is obvious."
 * 这个接口就是我们新的数据结构。
 */
interface NotificationSender {
  (
    channel: models.NotificationChannel,
    subject: string,
    content: string
  ): Promise<{ success: boolean; error?: string }>;
}

/**
 * 发送器注册表。
 * 这是一个从渠道类型字符串到其发送器实现的映射。
 * "Talk is cheap. Show me the code."
 * 这段代码取代了原来愚蠢的 if-else 链。
 */
const senderRegistry: Record<string, NotificationSender> = {};

/**
 * 注册一个新的通知发送器。
 * @param type 渠道类型 (e.g., 'resend', 'telegram')
 * @param sender 实现了 NotificationSender 接口的函数
 */
function registerSender(type: string, sender: NotificationSender) {
  if (senderRegistry[type]) {
    console.warn(`[通知注册] 覆盖已存在的发送器: ${type}`);
  }
  senderRegistry[type] = sender;
}

/**
 * 根据渠道类型发送通知 (重构后)
 * 这个函数现在只负责查找和调用，不再关心具体实现。
 * "The point of interfaces is that you don't have to care."
 */
async function sendNotificationByChannel(
  channel: models.NotificationChannel,
  subject: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  if (!channel.enabled) {
    return { success: false, error: "通知渠道已禁用" };
  }

  const sender = senderRegistry[channel.type];
  if (sender) {
    return await sender(channel, subject, content);
  } else {
    console.error(`[渠道分发] 不支持的通知渠道类型: ${channel.type}`);
    return { success: false, error: `不支持的通知渠道类型: ${channel.type}` };
  }
}

async function isNotificationInCooldown(
  type: "monitor" | "agent" | "system",
  targetId: number | null,
  channelId: number,
  eventKey: string,
  cooldownMinutes: number
) {
  if (!eventKey) return false;
  if (cooldownMinutes <= 0) return false;

  const since = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();
  const recentHistory =
    await repositories.getRecentSuccessfulNotificationHistory({
      type,
      targetId,
      channelId,
      since,
    });

  return recentHistory.some(
    (history) => getHistoryEventKey(history.content) === eventKey
  );
}

/**
 * 发送飞书通知
 */
async function sendFeishuNotification(
  channel: models.NotificationChannel,
  subject: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const config = parseChannelConfig<FeishuConfig>(channel);
    const webhookUrl = config.webhookUrl;

    if (!webhookUrl) {
      console.error("[飞书通知] Webhook URL 不能为空");
      return { success: false, error: "飞书 Webhook URL 不能为空" };
    }

    const message = {
      msg_type: "interactive",
      card: {
        header: {
          title: {
            content: subject,
            tag: "plain_text",
          },
        },
        elements: [
          {
            tag: "div",
            text: {
              content: content,
              tag: "lark_md",
            },
          },
        ],
      },
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });

    const responseData = await response.json();

    if (responseData.StatusCode === 0 || responseData.code === 0) {
      return { success: true };
    } else {
      console.error("[飞书通知] 发送失败");
      return {
        success: false,
        error: responseData.StatusMessage || responseData.msg || "发送失败",
      };
    }
  } catch (error) {
    console.error("发送飞书通知异常:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// 注册已有的发送器
registerSender("resend", sendResendNotification);
registerSender("telegram", sendTelegramNotification);
registerSender("feishu", sendFeishuNotification);

/**
 * 发送企业微信通知
 */
async function sendWeComNotification(
  channel: models.NotificationChannel,
  subject: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const config = parseChannelConfig<WeComConfig>(channel);
    const webhookUrl = config.webhookUrl;

    if (!webhookUrl) {
      console.error("[企业微信通知] Webhook URL 不能为空");
      return { success: false, error: "企业微信 Webhook URL 不能为空" };
    }

    // 企业微信的 Markdown 格式要求主题是加粗标题
    const markdownContent = `**${subject}**\n\n${content}`;

    const message = {
      msgtype: "markdown",
      markdown: {
        content: markdownContent,
      },
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });

    const responseData = await response.json();

    if (responseData.errcode === 0) {
      return { success: true };
    } else {
      console.error("[企业微信通知] 发送失败");
      return {
        success: false,
        error: `错误码: ${responseData.errcode}, 错误信息: ${responseData.errmsg}`,
      };
    }
  } catch (error) {
    console.error("发送企业微信通知异常:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

registerSender("wecom", sendWeComNotification);

export async function sendNotification(
  type: "monitor" | "agent" | "system",
  targetId: number | null,
  variables: Record<string, string>,
  channelIds: number[],
  userId: number,
  cooldownMinutes = DEFAULT_NOTIFICATION_COOLDOWN_MINUTES
): Promise<{
  success: boolean;
  results: NotificationSendResult[];
}> {
  try {
    if (!channelIds || channelIds.length === 0) {
      return { success: false, results: [] };
    }

    // 获取默认的通知模板
    const templates = await getCachedNotificationTemplates(userId);

    let defaultTemplate = templates.find(
      (t) => t.is_default && t.type === type
    );

    if (!defaultTemplate) {
      const fallbackTemplate = templates.find((t) => t.type === type);

      if (!fallbackTemplate) {
        console.error(`[发送通知] 找不到类型为${type}的任何通知模板`);
        return { success: false, results: [] };
      }

      defaultTemplate = fallbackTemplate;
    }

    // 替换变量
    const subject = replaceVariables(defaultTemplate.subject, variables);
    const content = replaceVariables(defaultTemplate.content, variables);

    // 获取所有通知渠道
    const channels = await Promise.all(
      channelIds.map((id) => getCachedNotificationChannelById(id, userId))
    );

    // 过滤掉不存在的渠道
    const validChannels = channels.filter(
      (ch): ch is models.NotificationChannel => ch !== null
    );

    if (validChannels.length === 0) {
      return { success: false, results: [] };
    }

    const eventKey = getNotificationEventKey(subject, variables);
    const normalizedCooldownMinutes =
      normalizeCooldownMinutes(cooldownMinutes);
    const skippedResults: NotificationSendResult[] = [];
    const channelsToSend: models.NotificationChannel[] = [];

    for (const channel of validChannels) {
      const inCooldown = await isNotificationInCooldown(
        type,
        targetId,
        channel.id,
        eventKey,
        normalizedCooldownMinutes
      );

      if (inCooldown) {
        skippedResults.push({
          channelId: channel.id,
          success: true,
          skipped: true,
        });
      } else {
        channelsToSend.push(channel);
      }
    }

    if (channelsToSend.length === 0) {
      return { success: true, results: skippedResults };
    }

    // 发送通知并记录结果
    const sendResults = await runWithConcurrency(
      channelsToSend,
      NOTIFICATION_SEND_CONCURRENCY,
      async (channel) => {
        try {
          // 发送通知
          const sendResult = await sendNotificationByChannel(
            channel,
            subject,
            content
          );

          // 记录通知历史
          await repositories.createNotificationHistory({
            type,
            target_id: targetId,
            channel_id: channel.id,
            template_id: defaultTemplate.id,
            status: sendResult.success ? "success" : "failed",
            content: JSON.stringify({
              subject,
              content,
              variables,
            }),
            error: sendResult.error || null,
          });

          return {
            channelId: channel.id,
            success: sendResult.success,
            error: sendResult.error,
          };
        } catch (error) {
          console.error(`[发送通知] 通过渠道${channel.id}发送通知失败:`, error);

          // 记录错误
          await repositories.createNotificationHistory({
            type,
            target_id: targetId,
            channel_id: channel.id,
            template_id: defaultTemplate.id,
            status: "failed",
            content: JSON.stringify({
              subject,
              content,
              variables,
            }),
            error: error instanceof Error ? error.message : String(error),
          });

          return {
            channelId: channel.id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    );

    const results = [...skippedResults, ...sendResults];

    // 检查是否至少有一个通知发送成功
    const anySuccess = results.some((r) => r.success);

    return {
      success: anySuccess,
      results,
    };
  } catch (error) {
    console.error("[发送通知] 发送通知失败:", error);
    return {
      success: false,
      results: [
        {
          channelId: -1,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

/**
 * 判断是否应该发送通知
 */
export async function shouldSendNotification(
  userId: number,
  type: "monitor" | "agent",
  id: number,
  prevStatus: string,
  currentStatus: string
): Promise<{ shouldSend: boolean; channels: number[]; cooldownMinutes: number }> {
  // 初始化变量
  let shouldSend = false;
  let channels: number[] = [];

  if (!id) {
    console.error("无效的ID");
    return {
      shouldSend: false,
      channels: [],
      cooldownMinutes: DEFAULT_NOTIFICATION_COOLDOWN_MINUTES,
    };
  }

  // 获取此对象的特定设置
  const specificSettings = await getCachedSpecificSettings(userId, type, id);

  let targetSettings = specificSettings.filter(
    (setting: models.NotificationSettings) => setting.enabled
  );
  // 如果没有特定设置，使用全局设置
  if (targetSettings.length === 0) {
    const globalSettings = await getCachedGlobalSettings(userId);

    if (type === "monitor" && globalSettings.monitorSettings) {
      targetSettings = [globalSettings.monitorSettings];
    } else if (type === "agent" && globalSettings.agentSettings) {
      targetSettings = [globalSettings.agentSettings];
    }
  }

  // 如果没有设置，不发送通知
  if (!targetSettings) {
    return {
      shouldSend: false,
      channels: [],
      cooldownMinutes: DEFAULT_NOTIFICATION_COOLDOWN_MINUTES,
    };
  }

  // 检查是否有启用的设置
  const enabledSettings = targetSettings.filter(
    (setting: models.NotificationSettings) => setting.enabled
  );
  if (enabledSettings.length === 0) {
    return {
      shouldSend: false,
      channels: [],
      cooldownMinutes: DEFAULT_NOTIFICATION_COOLDOWN_MINUTES,
    };
  }

  const cooldownMinutes = Math.max(
    ...enabledSettings.map((setting) =>
      normalizeCooldownMinutes(setting.cooldown_minutes)
    )
  );

  // 解析所有启用设置的渠道列表
  try {
    // 从所有启用的设置中收集渠道
    for (const setting of enabledSettings) {
      const settingChannels = JSON.parse(setting.channels || "[]");
      channels = [...channels, ...settingChannels];
    }
    // 去重
    channels = [...new Set(channels)];
  } catch (e) {
    console.error("[通知触发检查] 解析通知渠道列表失败:", e);
  }

  if (channels.length === 0) {
    return { shouldSend: false, channels: [], cooldownMinutes };
  }

  // 根据类型和状态变化判断是否应该发送通知
  if (type === "monitor") {
    // 检查所有启用的设置
    for (const setting of enabledSettings) {
      // 从正常到故障的变化，且配置了on_down
      if (
        prevStatus !== "down" &&
        currentStatus === "down" &&
        setting.on_down
      ) {
        shouldSend = true;
        break;
      }
      // 从故障到正常的变化，且配置了on_recovery
      else if (
        prevStatus === "down" &&
        currentStatus === "up" &&
        setting.on_recovery
      ) {
        shouldSend = true;
        break;
      }
    }
  }
  if (type === "agent") {
    // 检查所有启用的设置
    for (const setting of enabledSettings) {
      // 从在线到离线的变化，且配置了on_offline
      if (
        prevStatus !== "offline" &&
        currentStatus === "offline" &&
        setting.on_offline
      ) {
        shouldSend = true;
        break;
      }
      // 从离线到在线的变化，且配置了on_recovery
      else if (
        prevStatus === "offline" &&
        currentStatus === "online" &&
        setting.on_recovery
      ) {
        shouldSend = true;
        break;
      }
    }
    // 其他代理相关的阈值通知逻辑...
  }

  return { shouldSend, channels, cooldownMinutes };
}

/**
 * 删除通知设置
 * @param type 通知类型
 * @param id 通知设置ID
 * @param userId 用户ID
 */
export async function deleteNotificationSettings(
  type: "monitor" | "agent",
  id: number,
  userId: number
): Promise<{ success: boolean; message?: string }> {
  try {
    // 执行删除操作
    await repositories.deleteNotificationSettings(type, id, userId);
    invalidateNotificationConfigCache(userId);
  } catch (error) {
    console.error("[删除通知设置] 删除通知设置失败:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "删除通知设置失败",
    };
  }
  return {
    success: true,
    message: `${type}通知设置删除成功`,
  };
}

/**
 * 为新用户创建默认的通知设置
 * @param userId 新用户的ID
 */
export async function createDefaultNotificationSettingsForUser(
  userId: number
): Promise<void> {
  try {
    invalidateNotificationConfigCache(userId);
    const now = new Date().toISOString();

    // 创建默认通知模板
    await repositories.createNotificationTemplate({
      name: "Monitor监控模板",
      type: "monitor",
      subject: "【${status}】${name} 监控状态变更",
      content:
        "🔔 网站监控状态变更通知\n\n📊 服务: ${name}\n🔄 状态: ${status} (之前: ${previous_status})\n🕒 时间: ${time}\n\n🔗 地址: ${url}\n⏱️ 响应时间: ${response_time}\n📝 实际状态码: ${status_code}\n🎯 期望状态码: ${expected_status}\n\n❗ 错误信息: ${error}",
      is_default: true, // 修复: 将 1 修改为 true
      created_by: userId,
    });

    await repositories.createNotificationTemplate({
      name: "Agent监控模板",
      type: "agent",
      subject: "【${status}】${name} 客户端状态变更",
      content:
        "🔔 客户端状态变更通知\n\n📊 主机: ${name}\n🔄 状态: ${status} (之前: ${previous_status})\n🕒 时间: ${time}\n\n🖥️ 主机信息:\n  主机名: ${hostname}\n  IP地址: ${ip_addresses}\n  操作系统: ${os}\n\n❗ 错误信息: ${error}",
      is_default: true, // 修复: 将 1 修改为 true
      created_by: userId,
    });

    // 创建默认通知渠道
    const defaultChannelId = await repositories.createNotificationChannel({
      name: "TG测试Bot(仅提供了Token，请自行填写ChatID或者使用你的Bot)",
      type: "telegram",
      config:
        '{"botToken": "8538953065:AAG51lJ31MNLWe3na5wai4SBRiZ8T-sOC3c", "chatId": "111111111"}',
      enabled: true,
      created_by: userId,
    });

    // 创建默认通知设置
    await repositories.createOrUpdateSettings({
      user_id: userId,
      target_type: "global-monitor",
      target_id: 0,
      enabled: false,
      on_down: true,
      on_recovery: true,
      on_offline: true, // 确保所有布尔字段都有值
      on_cpu_threshold: false,
      cpu_threshold: 90,
      on_memory_threshold: false,
      memory_threshold: 85,
      on_disk_threshold: false,
      disk_threshold: 90,
      cooldown_minutes: DEFAULT_NOTIFICATION_COOLDOWN_MINUTES,
      channels: JSON.stringify([defaultChannelId]),
    });

    await repositories.createOrUpdateSettings({
      user_id: userId,
      target_type: "global-agent",
      target_id: 0,
      enabled: false,
      on_down: true,
      on_recovery: true,
      on_offline: true,
      on_cpu_threshold: true,
      cpu_threshold: 80,
      on_memory_threshold: true,
      memory_threshold: 80,
      on_disk_threshold: true,
      disk_threshold: 90,
      cooldown_minutes: DEFAULT_NOTIFICATION_COOLDOWN_MINUTES,
      channels: JSON.stringify([defaultChannelId]),
    });

  } catch (error) {
    console.error(`为新用户 ${userId} 创建默认通知设置失败:`, error);
    // 此处不向上抛出异常，以免影响用户创建的主流程
  }
}
