import * as models from "../../../models";

interface ProviderResponse {
  ok?: boolean;
  description?: string;
  message?: string;
  StatusCode?: number;
  StatusMessage?: string;
  code?: number;
  msg?: string;
  errcode?: number;
  errmsg?: string;
}

const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

async function readBoundedJson(response: Response): Promise<unknown | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel("provider response exceeds limit");
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function normalizeProviderResponse(value: unknown): ProviderResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: ProviderResponse = {};
  for (const key of [
    "description",
    "message",
    "StatusMessage",
    "msg",
    "errmsg",
  ] as const) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  for (const key of ["StatusCode", "code", "errcode"] as const) {
    if (typeof source[key] === "number" && Number.isFinite(source[key])) {
      result[key] = source[key];
    }
  }
  if (typeof source.ok === "boolean") result.ok = source.ok;
  return result;
}

async function parseProviderResponse(response: Response) {
  return normalizeProviderResponse(await readBoundedJson(response));
}
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

// 钉钉机器人配置接口
interface DingTalkConfig {
  webhook_url: string;
  secret?: string;
}

// Bark 配置接口
interface BarkConfig {
  server_url?: string;
  device_key: string;
  sound?: string;
  group?: string;
}

// Server 酱配置接口
interface ServerChanConfig {
  send_key: string;
}

// WxPusher 配置接口
interface WxPusherConfig {
  app_token: string;
  uids?: string;
  topic_ids?: string;
}

// Gotify 配置接口
interface GotifyConfig {
  server_url: string;
  app_token: string;
  priority?: number | string;
}

/**
 * 解析通知渠道配置
 */
function parseChannelConfig<T>(channel: models.NotificationChannel): T {
  try {
    let config: unknown;
    if (typeof channel.config === "string") {
      // 如果是字符串，尝试解析为JSON对象
      try {
        config = JSON.parse(channel.config);
      } catch {
        return {} as T;
      }
    } else if (
      typeof channel.config === "object" &&
      channel.config !== null &&
      !Array.isArray(channel.config)
    ) {
      // 如果已经是对象，直接使用
      config = channel.config;
    } else {
      return {} as T;
    }

    return config as T;
  } catch {
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
      return { success: false, error: "Resend API密钥不能为空" };
    }

    if (!config.from) {
      return { success: false, error: "Resend发件人不能为空" };
    }

    if (!config.to) {
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
    const responseData = await parseProviderResponse(response);

    if (response.ok) {
      return { success: true };
    } else {
      return {
        success: false,
        error:
          responseData.message || `发送失败，HTTP状态码: ${response.status}`,
      };
    }
  } catch (error) {
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

    const responseData = await parseProviderResponse(response);

    if (responseData.ok === true) {
      return { success: true };
    } else {
      return {
        success: false,
        error: responseData.description || "发送失败",
      };
    }
  } catch (error) {
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
  senderRegistry[type] = sender;
}

/**
 * 根据渠道类型发送通知 (重构后)
 * 这个函数现在只负责查找和调用，不再关心具体实现。
 * "The point of interfaces is that you don't have to care."
 */
export async function sendNotificationByChannel(
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
    return { success: false, error: `不支持的通知渠道类型: ${channel.type}` };
  }
}

async function sendFeishuNotification(
  channel: models.NotificationChannel,
  subject: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const config = parseChannelConfig<FeishuConfig>(channel);
    const webhookUrl = config.webhookUrl;

    if (!webhookUrl) {
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

    const responseData = await parseProviderResponse(response);

    if (responseData.StatusCode === 0 || responseData.code === 0) {
      return { success: true };
    } else {
      return {
        success: false,
        error: responseData.StatusMessage || responseData.msg || "发送失败",
      };
    }
  } catch (error) {
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

    const responseData = await parseProviderResponse(response);

    if (responseData.errcode === 0) {
      return { success: true };
    } else {
      return {
        success: false,
        error: `错误码: ${responseData.errcode}, 错误信息: ${responseData.errmsg}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

registerSender("wecom", sendWeComNotification);

/**
 * 钉钉加签：HMAC-SHA256(secret, `${timestamp}\n${secret}`) -> Base64 -> URL 编码
 */
async function signDingTalkWebhookUrl(
  webhookUrl: string,
  secret: string
): Promise<string> {
  const timestamp = Date.now();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}\n${secret}`)
  );
  const sign = btoa(String.fromCharCode(...new Uint8Array(signature)));
  const separator = webhookUrl.includes("?") ? "&" : "?";
  return `${webhookUrl}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

/**
 * 发送钉钉机器人通知
 */
async function sendDingTalkNotification(
  channel: models.NotificationChannel,
  subject: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const config = parseChannelConfig<DingTalkConfig>(channel);

    if (!config.webhook_url) {
      return { success: false, error: "钉钉 Webhook URL 不能为空" };
    }

    // secret 非空则加签，否则直接使用原始 webhook
    const requestUrl = config.secret
      ? await signDingTalkWebhookUrl(config.webhook_url, config.secret)
      : config.webhook_url;

    const message = {
      msgtype: "markdown",
      markdown: {
        title: subject,
        text: `**${subject}**\n\n${content}`,
      },
    };

    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });

    const responseData = await parseProviderResponse(response);

    if (responseData.errcode === 0) {
      return { success: true };
    } else {
      return {
        success: false,
        error: `错误码: ${responseData.errcode}, 错误信息: ${responseData.errmsg}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

registerSender("dingtalk", sendDingTalkNotification);

const BARK_DEFAULT_SERVER_URL = "https://api.day.app";

/**
 * 发送 Bark 通知（支持官方 api.day.app 或自建服务端）
 */
async function sendBarkNotification(
  channel: models.NotificationChannel,
  subject: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const config = parseChannelConfig<BarkConfig>(channel);

    if (!config.device_key) {
      return { success: false, error: "Bark Device Key 不能为空" };
    }

    const serverUrl = (config.server_url || BARK_DEFAULT_SERVER_URL).replace(
      /\/+$/,
      ""
    );

    const requestBody: Record<string, string> = {
      title: subject,
      body: content,
      device_key: config.device_key,
    };
    if (config.sound) requestBody.sound = config.sound;
    if (config.group) requestBody.group = config.group;

    const response = await fetch(`${serverUrl}/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(requestBody),
    });

    const responseData = await parseProviderResponse(response);

    if (response.ok && (responseData.code === 200 || responseData.code === undefined)) {
      return { success: true };
    } else {
      return {
        success: false,
        error:
          responseData.message || `发送失败，HTTP状态码: ${response.status}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

registerSender("bark", sendBarkNotification);

/**
 * 发送 Server 酱通知
 */
async function sendServerChanNotification(
  channel: models.NotificationChannel,
  subject: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const config = parseChannelConfig<ServerChanConfig>(channel);

    if (!config.send_key) {
      return { success: false, error: "Server酱 SendKey 不能为空" };
    }

    const response = await fetch(
      `https://sctapi.ftqq.com/${encodeURIComponent(config.send_key)}.send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: subject,
          desp: content,
        }),
      }
    );

    const responseData = await parseProviderResponse(response);

    if (responseData.code === 0) {
      return { success: true };
    } else {
      return {
        success: false,
        error:
          responseData.message || `发送失败，HTTP状态码: ${response.status}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

registerSender("serverchan", sendServerChanNotification);

/**
 * 发送 WxPusher 通知
 */
async function sendWxPusherNotification(
  channel: models.NotificationChannel,
  subject: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const config = parseChannelConfig<WxPusherConfig>(channel);

    if (!config.app_token) {
      return { success: false, error: "WxPusher App Token 不能为空" };
    }

    const uids = (config.uids || "")
      .split(",")
      .map((uid) => uid.trim())
      .filter((uid) => uid.length > 0);
    const topicIds = (config.topic_ids || "")
      .split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (uids.length === 0 && topicIds.length === 0) {
      return {
        success: false,
        error: "WxPusher uids 与 topic_ids 至少需要填写一个",
      };
    }

    const response = await fetch(
      "https://wxpusher.zjiecode.com/api/send/message",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          appToken: config.app_token,
          content: `${subject}\n\n${content}`,
          summary: subject.slice(0, 99),
          contentType: 1,
          uids,
          topicIds,
        }),
      }
    );

    const responseData = await parseProviderResponse(response);

    // WxPusher 成功码为 1000
    if (responseData.code === 1000) {
      return { success: true };
    } else {
      return {
        success: false,
        error:
          responseData.msg || `发送失败，HTTP状态码: ${response.status}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

registerSender("wxpusher", sendWxPusherNotification);

/**
 * 发送 Gotify 通知
 */
async function sendGotifyNotification(
  channel: models.NotificationChannel,
  subject: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const config = parseChannelConfig<GotifyConfig>(channel);

    if (!config.server_url) {
      return { success: false, error: "Gotify 服务器地址不能为空" };
    }

    if (!config.app_token) {
      return { success: false, error: "Gotify App Token 不能为空" };
    }

    const serverUrl = config.server_url.replace(/\/+$/, "");
    const parsedPriority = Number(config.priority);
    const priority =
      config.priority !== undefined &&
      config.priority !== "" &&
      Number.isFinite(parsedPriority)
        ? parsedPriority
        : 5;

    const response = await fetch(
      `${serverUrl}/message?token=${encodeURIComponent(config.app_token)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: subject,
          message: content,
          priority,
        }),
      }
    );

    if (response.ok) {
      return { success: true };
    }

    let errorMessage = `发送失败，HTTP状态码: ${response.status}`;
    try {
      const responseData = (await readBoundedJson(response)) as {
        error?: string;
        errorDescription?: string;
      } | null;
      errorMessage =
        responseData?.errorDescription || responseData?.error || errorMessage;
    } catch {
      // 忽略响应体解析失败，保留 HTTP 状态码错误信息
    }
    return { success: false, error: errorMessage };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

registerSender("gotify", sendGotifyNotification);

// OneBot v11 HTTP（QQ）配置接口
interface OneBotConfig {
  api_url: string;
  access_token?: string;
  message_type?: "private" | "group";
  target_id: string;
}

/**
 * 发送 OneBot（QQ）通知：POST {api_url}/send_private_msg 或 /send_group_msg，
 * 请求体 {user_id|group_id, message}；有 access_token 时带 Bearer 头；
 * 响应 retcode === 0 判成功。
 */
async function sendOneBotNotification(
  channel: models.NotificationChannel,
  subject: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const config = parseChannelConfig<OneBotConfig>(channel);

    if (!config.api_url) {
      return { success: false, error: "OneBot API 地址不能为空" };
    }

    const targetId = Number(config.target_id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return { success: false, error: "OneBot 目标 QQ 号/群号无效" };
    }

    const isGroup = config.message_type === "group";
    const apiUrl = config.api_url.replace(/\/+$/, "");
    const endpoint = isGroup
      ? `${apiUrl}/send_group_msg`
      : `${apiUrl}/send_private_msg`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.access_token) {
      headers.Authorization = `Bearer ${config.access_token}`;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...(isGroup ? { group_id: targetId } : { user_id: targetId }),
        message: `${subject}\n${content}`,
      }),
    });

    let responseData: { retcode?: number; wording?: string; msg?: string } = {};
    try {
      const parsed = await readBoundedJson(response);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const source = parsed as Record<string, unknown>;
        responseData = {
          retcode: typeof source.retcode === "number" ? source.retcode : undefined,
          wording: typeof source.wording === "string" ? source.wording : undefined,
          msg: typeof source.msg === "string" ? source.msg : undefined,
        };
      }
    } catch {
      // 忽略响应体解析失败，走下方错误分支
    }

    if (responseData.retcode === 0) {
      return { success: true };
    }
    return {
      success: false,
      error:
        responseData.wording ||
        responseData.msg ||
        `发送失败，HTTP状态码: ${response.status}`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

registerSender("onebot", sendOneBotNotification);
