import { z } from "zod";
import { decodeOrderedCursor } from "../../../shared/pagination/OrderedCursor";

const headersSchema = z
  .record(z.string().max(8192))
  .superRefine((headers, context) => {
    const entries = Object.entries(headers);
    if (entries.length > 50) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "最多允许 50 个请求头" });
    }
    if (entries.some(([key]) => key.length === 0 || key.length > 128)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "请求头名称长度无效" });
    }
  });

export const monitorV2MutationSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    url: z.string().trim().url().max(2048).refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }, "仅支持 HTTP(S) URL"),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    interval_seconds: z.coerce.number().int().min(1).max(86400),
    timeout_ms: z.coerce.number().int().min(100).max(300000),
    expected_status: z.coerce.number().int().min(100).max(599),
    headers: headersSchema.default({}),
    body: z.string().max(1024 * 1024).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const monitorV2UpdateSchema = monitorV2MutationSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "至少需要提供一个更新字段");

export const monitorV2ListQuerySchema = z
  .object({
    cursor: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .refine((value) => decodeOrderedCursor(value) !== null)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const monitorV2IdSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const monitorV2RelatedDataQuerySchema = z
  .object({
    monitor_id: monitorV2IdSchema,
  })
  .strict();

export const monitorV2DailyStatsQuerySchema = z
  .object({
    monitor_id: monitorV2IdSchema,
    days: z.coerce.number().int().min(1).max(366).default(90),
  })
  .strict();

export const monitorV2OrderSchema = z
  .object({
    ids: z
      .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .min(1)
      .max(1000),
  })
  .strict();

const monitorV2ImportItemSchema = z.union([
  monitorV2MutationSchema.extend({
    sort_order: z.number().int().min(0).optional(),
  }),
  z
    .object({
      name: z.string().trim().min(1).max(128),
      url: z.string().trim().url().max(2048),
      method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
      interval: z.number().int().min(1).max(86400),
      timeout: z.number().int().min(1).max(300),
      expected_status: z.number().int().min(100).max(599),
      headers: headersSchema.default({}),
      body: z.string().max(1024 * 1024).nullable().optional(),
      active: z.boolean().optional(),
      sort_order: z.number().int().min(0).optional(),
    })
    .strict()
    .transform((value) => ({
      name: value.name,
      url: value.url,
      method: value.method,
      interval_seconds: value.interval,
      timeout_ms: value.timeout * 1000,
      expected_status: value.expected_status,
      headers: value.headers,
      body: value.body,
      active: value.active,
      sort_order: value.sort_order,
    })),
]);

export const monitorV2ImportSchema = z
  .array(monitorV2ImportItemSchema)
  .min(1)
  .max(1000);
