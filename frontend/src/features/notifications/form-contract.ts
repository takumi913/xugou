import { z } from "zod";
import type { NotificationChannel } from "@/types/notification";

export const notificationChannelTypes = [
  "telegram",
  "resend",
  "feishu",
  "wecom",
  "dingtalk",
  "bark",
  "serverchan",
  "wxpusher",
  "gotify",
  "onebot",
] as const;
export type NotificationChannelType = (typeof notificationChannelTypes)[number];

export const emptyChannelConfig = {
  botToken: "",
  chatId: "",
  apiKey: "",
  from: "",
  to: "",
  webhookUrl: "",
  webhook_url: "",
  secret: "",
  server_url: "",
  device_key: "",
  sound: "",
  group: "",
  send_key: "",
  app_token: "",
  uids: "",
  topic_ids: "",
  priority: "",
  api_url: "",
  access_token: "",
  message_type: "private" as "private" | "group",
  target_id: "",
};
export type ChannelConfigForm = typeof emptyChannelConfig;

export type ChannelForm = {
  name: string;
  type: NotificationChannelType;
  config: ChannelConfigForm;
  enabled: boolean;
};

export type ChannelFormErrorKey =
  | "name"
  | "botToken"
  | "chatId"
  | "apiKey"
  | "from"
  | "to"
  | "webhookUrl"
  | "webhook_url"
  | "server_url"
  | "device_key"
  | "send_key"
  | "app_token"
  | "wxpusherTarget"
  | "api_url"
  | "target_id";
export type ChannelFormErrors = Record<ChannelFormErrorKey, string>;

export const emptyChannelFormErrors: ChannelFormErrors = {
  name: "",
  botToken: "",
  chatId: "",
  apiKey: "",
  from: "",
  to: "",
  webhookUrl: "",
  webhook_url: "",
  server_url: "",
  device_key: "",
  send_key: "",
  app_token: "",
  wxpusherTarget: "",
  api_url: "",
  target_id: "",
};

export const emptyChannelForm = (): ChannelForm => ({
  name: "",
  type: "telegram",
  config: { ...emptyChannelConfig },
  enabled: true,
});

const channelConfigFormSchema: z.ZodType<ChannelConfigForm> = z.object({
  botToken: z.string().max(8192),
  chatId: z.string().max(8192),
  apiKey: z.string().max(8192),
  from: z.string().max(8192),
  to: z.string().max(8192),
  webhookUrl: z.string().max(8192),
  webhook_url: z.string().max(8192),
  secret: z.string().max(8192),
  server_url: z.string().max(8192),
  device_key: z.string().max(8192),
  sound: z.string().max(8192),
  group: z.string().max(8192),
  send_key: z.string().max(8192),
  app_token: z.string().max(8192),
  uids: z.string().max(8192),
  topic_ids: z.string().max(8192),
  priority: z.string().max(8192),
  api_url: z.string().max(8192),
  access_token: z.string().max(8192),
  message_type: z.enum(["private", "group"]),
  target_id: z.string().max(8192),
});

const required = (
  context: z.RefinementCtx,
  path: ChannelFormErrorKey,
  value: string,
  message: string
) => {
  if (!value.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  }
};

export const notificationChannelFormSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    type: z.enum(notificationChannelTypes),
    config: channelConfigFormSchema,
    enabled: z.boolean(),
  })
  .superRefine((form, context) => {
    required(context, "name", form.name, "nameRequired");
    const config = form.config;
    if (form.type === "telegram") {
      required(context, "botToken", config.botToken, "botTokenRequired");
      required(context, "chatId", config.chatId, "chatIdRequired");
    } else if (form.type === "resend") {
      required(context, "apiKey", config.apiKey, "apiKeyRequired");
      required(context, "from", config.from, "fromRequired");
      required(context, "to", config.to, "toRequired");
    } else if (form.type === "feishu" || form.type === "wecom") {
      required(context, "webhookUrl", config.webhookUrl, "webhookUrlRequired");
    } else if (form.type === "dingtalk") {
      required(context, "webhook_url", config.webhook_url, "webhookUrlRequired");
    } else if (form.type === "bark") {
      required(context, "device_key", config.device_key, "deviceKeyRequired");
    } else if (form.type === "serverchan") {
      required(context, "send_key", config.send_key, "sendKeyRequired");
    } else if (form.type === "wxpusher") {
      required(context, "app_token", config.app_token, "appTokenRequired");
      if (!config.uids.trim() && !config.topic_ids.trim()) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["wxpusherTarget"],
          message: "uidsOrTopicIdsRequired",
        });
      }
    } else if (form.type === "gotify") {
      required(context, "server_url", config.server_url, "serverUrlRequired");
      required(context, "app_token", config.app_token, "appTokenRequired");
    } else if (form.type === "onebot") {
      required(context, "api_url", config.api_url, "apiUrlRequired");
      if (!/^\d+$/.test(config.target_id.trim())) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target_id"],
          message: "targetIdRequired",
        });
      }
    }
  });

const channelConfigKeys: Record<
  NotificationChannelType,
  Array<keyof ChannelConfigForm>
> = {
  telegram: ["botToken", "chatId"],
  resend: ["apiKey", "from", "to"],
  feishu: ["webhookUrl"],
  wecom: ["webhookUrl"],
  dingtalk: ["webhook_url", "secret"],
  bark: ["server_url", "device_key", "sound", "group"],
  serverchan: ["send_key"],
  wxpusher: ["app_token", "uids", "topic_ids"],
  gotify: ["server_url", "app_token", "priority"],
  onebot: ["api_url", "access_token", "message_type", "target_id"],
};

export function channelFormToCommand(form: ChannelForm) {
  const config = Object.fromEntries(
    channelConfigKeys[form.type].map((key) => [key, form.config[key]])
  );
  return {
    name: form.name.trim(),
    type: form.type,
    enabled: form.enabled,
    config,
  };
}

const stringValue = (value: unknown) =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : "";

export function notificationChannelToForm(
  channel: NotificationChannel
): ChannelForm {
  const type = notificationChannelTypes.includes(
    channel.type as NotificationChannelType
  )
    ? (channel.type as NotificationChannelType)
    : "telegram";
  const config = { ...emptyChannelConfig };
  for (const key of Object.keys(config) as Array<keyof ChannelConfigForm>) {
    if (key === "message_type") {
      config.message_type =
        channel.config.message_type === "group" ? "group" : "private";
    } else {
      config[key] = stringValue(channel.config[key]);
    }
  }
  return { name: channel.name, type, config, enabled: channel.enabled };
}

export type NotificationTemplateForm = {
  name: string;
  type: "monitor" | "agent";
  subject: string;
  content: string;
};
export const emptyNotificationTemplateForm = (): NotificationTemplateForm => ({
  name: "",
  type: "monitor",
  subject: "",
  content: "",
});
export const notificationTemplateFormSchema = z.object({
  name: z.string().trim().min(1).max(128),
  type: z.enum(["monitor", "agent"]),
  subject: z.string().trim().min(1).max(512),
  content: z.string().min(1).max(20_000),
});
