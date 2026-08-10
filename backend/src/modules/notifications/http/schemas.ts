import { z } from "zod";
import { decodeOrderedCursor } from "../../../shared/pagination/OrderedCursor";

const positiveIdSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const nonNegativeIdSchema = z.number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const notificationIdSchema = positiveIdSchema;

export const NOTIFICATION_CHANNEL_TYPES = [
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

export const notificationResourceListSchema = z
  .object({
    target_type: z.enum(["monitor", "agent"]),
    cursor: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .refine((value) => decodeOrderedCursor(value) !== null)
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();

export const channelCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    type: z.enum(NOTIFICATION_CHANNEL_TYPES),
    config: z.record(z.unknown()),
    enabled: z.boolean().default(true),
  })
  .strict();

export const channelUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    type: z.enum(NOTIFICATION_CHANNEL_TYPES).optional(),
    config: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0)
  .refine((value) => value.type === undefined || value.config !== undefined, {
    path: ["config"],
    message: "config is required when changing channel type",
  });

const templateFields = {
  name: z.string().trim().min(1).max(128),
  type: z.enum(["monitor", "agent"]),
  subject: z.string().trim().min(1).max(512),
  content: z.string().min(1).max(20_000),
  is_default: z.boolean(),
};

export const templateCreateSchema = z.object(templateFields).strict();
export const templateUpdateSchema = z
  .object({
    name: templateFields.name.optional(),
    type: templateFields.type.optional(),
    subject: templateFields.subject.optional(),
    content: templateFields.content.optional(),
    is_default: templateFields.is_default.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export const notificationSettingV2Schema = z
  .object({
    target_type: z.enum(["global-monitor", "global-agent", "monitor", "agent"]),
    target_id: nonNegativeIdSchema.default(0),
    enabled: z.boolean(),
    on_down: z.boolean().default(false),
    on_recovery: z.boolean().default(false),
    on_offline: z.boolean().default(false),
    on_cpu_threshold: z.boolean().default(false),
    cpu_threshold: z.number().min(0).max(100).default(90),
    on_memory_threshold: z.boolean().default(false),
    memory_threshold: z.number().min(0).max(100).default(85),
    on_disk_threshold: z.boolean().default(false),
    disk_threshold: z.number().min(0).max(100).default(90),
    cooldown_minutes: z.number().int().min(0).max(1440).default(30),
    channels: z.array(positiveIdSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const global = value.target_type.startsWith("global-");
    if (global && value.target_id !== 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["target_id"], message: "global target_id must be 0" });
    }
    if (!global && value.target_id <= 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["target_id"], message: "resource target_id is required" });
    }
  });

export const notificationSettingsBulkSchema = z
  .object({
    settings: z.array(notificationSettingV2Schema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.settings.forEach((setting, index) => {
      const key = `${setting.target_type}:${setting.target_id}`;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["settings", index],
          message: "duplicate notification target",
        });
      }
      seen.add(key);
      if (new Set(setting.channels).size !== setting.channels.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["settings", index, "channels"],
          message: "duplicate notification channel",
        });
      }
    });
  });

export const notificationIdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const historyQuerySchema = z
  .object({
    cursor: positiveIdSchema.optional(),
    type: z.enum(["monitor", "agent"]).optional(),
    target_id: positiveIdSchema.optional(),
    status: z.enum(["success", "failed"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
