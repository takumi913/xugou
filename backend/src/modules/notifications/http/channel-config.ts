import { z } from "zod";

const optionalConfigString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().max(512).optional()
);

const httpUrlSchema = z.string().trim().url().max(2048);

const optionalHttpUrlSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  httpUrlSchema.optional()
);

const optionalPrioritySchema = z.preprocess(
  (value) =>
    value === "" || value === null || value === undefined ? undefined : value,
  z.coerce.number().int().min(0).max(10).optional()
);

/** Provider config contracts shared by the v2 route and the temporary v1 adapter. */
export const notificationChannelConfigSchemas: Record<string, z.ZodTypeAny> = {
  telegram: z.object({
    botToken: z.string().trim().min(1, "Bot Token 不能为空").max(512),
    chatId: z.string().trim().min(1, "Chat ID 不能为空").max(128),
  }),
  resend: z.object({
    apiKey: z.string().trim().min(1, "API 密钥不能为空").max(512),
    from: z.string().trim().min(1, "发件人不能为空").max(320),
    to: z.string().trim().min(1, "收件人不能为空").max(320),
  }),
  feishu: z.object({ webhookUrl: httpUrlSchema }),
  wecom: z.object({ webhookUrl: httpUrlSchema }),
  dingtalk: z.object({
    webhook_url: httpUrlSchema,
    secret: optionalConfigString,
  }),
  bark: z.object({
    server_url: optionalHttpUrlSchema,
    device_key: z.string().trim().min(1, "Device Key 不能为空").max(512),
    sound: optionalConfigString,
    group: optionalConfigString,
  }),
  serverchan: z.object({
    send_key: z.string().trim().min(1, "SendKey 不能为空").max(512),
  }),
  wxpusher: z
    .object({
      app_token: z.string().trim().min(1, "App Token 不能为空").max(512),
      uids: optionalConfigString,
      topic_ids: optionalConfigString,
    })
    .refine(
      (value) => Boolean(value.uids || value.topic_ids),
      "uids 与 topic_ids 至少需要填写一个"
    ),
  gotify: z.object({
    server_url: httpUrlSchema,
    app_token: z.string().trim().min(1, "App Token 不能为空").max(512),
    priority: optionalPrioritySchema,
  }),
  onebot: z.object({
    api_url: httpUrlSchema,
    access_token: optionalConfigString,
    message_type: z.enum(["private", "group"]),
    target_id: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/, "QQ 号/群号需为数字"),
  }),
};

export function validateNotificationChannelConfig(
  type: string,
  config: unknown
): { success: boolean; config?: unknown; message?: string } {
  const schema = notificationChannelConfigSchemas[type];
  if (!schema) return { success: true, config };

  const result = schema.safeParse(config ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.join(".") || "config";
    return {
      success: false,
      message: `渠道配置无效: ${path} ${issue?.message ?? "格式错误"}`,
    };
  }
  return { success: true, config: result.data };
}
