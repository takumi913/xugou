import { z } from "zod";
import { decodeOrderedCursor } from "../../../shared/pagination/OrderedCursor";

const boundedMetric = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const percentMetric = z.number().finite().min(0).max(100);
const diskMetricSchema = z
  .object({
    device: z.string().max(512).optional(),
    mount_point: z.string().max(512).optional(),
    total: boundedMetric.optional(),
    used: boundedMetric.optional(),
    free: boundedMetric.optional(),
    usage_rate: percentMetric.optional(),
    fs_type: z.string().max(128).optional(),
  })
  .strict();

const networkMetricSchema = z
  .object({
    interface: z.string().max(512).optional(),
    bytes_sent: boundedMetric.optional(),
    bytes_recv: boundedMetric.optional(),
    packets_sent: boundedMetric.optional(),
    packets_recv: boundedMetric.optional(),
  })
  .strict();

const pingMetricSchema = z
  .object({
    target: z.string().max(512).optional(),
    latency_ms: z.number().finite().min(-1).max(Number.MAX_SAFE_INTEGER).optional(),
    loss: z.boolean().optional(),
  })
  .strict();

const boundedPingMap = z.record(pingMetricSchema).superRefine((value, context) => {
  if (Object.keys(value).length > 128) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Ping 指标最多允许 128 个目标",
    });
  }
});

export const agentV2ListQuerySchema = z
  .object({
    cursor: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .refine((value) => decodeOrderedCursor(value) !== null)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    include_latest_metrics: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .default("false"),
  })
  .strict();

export const agentV2IdSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const agentCredentialListQuerySchema = z
  .object({
    cursor: agentV2IdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

const agentV2UpdateFields = {
    name: z.string().trim().min(1).max(128).optional(),
    hostname: z.string().trim().max(255).nullable().optional(),
    ip_addresses: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
    os: z.string().trim().max(128).nullable().optional(),
    version: z.string().trim().max(128).nullable().optional(),
    status: z.enum(["active", "inactive"]).nullable().optional(),
    collect_interval_seconds: z.coerce.number().int().min(1).max(3600).optional(),
    report_interval_seconds: z.coerce.number().int().min(10).max(3600).optional(),
    group_name: z.string().trim().max(64).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
    auto_update: z.boolean().optional(),
    is_hidden: z.boolean().optional(),
    price: z.coerce.number().min(0).max(1_000_000).nullable().optional(),
    currency: z.string().trim().max(16).nullable().optional(),
    billing_cycle: z.enum(["monthly", "quarterly", "yearly", "once"]).nullable().optional(),
    expire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    auto_renewal: z.boolean().optional(),
    traffic_limit_gb: z.coerce.number().positive().max(1_000_000_000).nullable().optional(),
    traffic_reset_day: z.coerce.number().int().min(1).max(28).optional(),
    traffic_calc_type: z.enum(["sum", "rx", "tx"]).optional(),
};

export const agentV2UpdateSchema = z
  .object(agentV2UpdateFields)
  .strict()
  .refine((value) => Object.keys(value).length > 0, "至少需要提供一个更新字段");

export const agentV2OrderSchema = z
  .object({
    ids: z
      .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .min(1)
      .max(1000),
  })
  .strict();

const agentV2ImportItemSchema = z
  .object({
    ...agentV2UpdateFields,
    name: z.string().trim().min(1).max(128),
    sort_order: z.number().int().min(0).optional(),
  })
  .strict();

const agentLegacyImportItemSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    token: z.string().trim().min(1).max(512).optional(),
    hostname: z.string().trim().max(255).nullable().optional(),
    ip_addresses: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
    os: z.string().trim().max(128).nullable().optional(),
    version: z.string().trim().max(128).nullable().optional(),
    collect_interval: z.number().int().min(1).max(3600).optional(),
    report_interval: z.number().int().min(10).max(3600).optional(),
    price: z.number().min(0).max(1_000_000).nullable().optional(),
    currency: z.string().trim().max(16).nullable().optional(),
    billing_cycle: z.enum(["monthly", "quarterly", "yearly", "once"]).nullable().optional(),
    expire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    auto_renewal: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
    is_hidden: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
    traffic_limit_gb: z.number().positive().max(1_000_000_000).nullable().optional(),
    traffic_reset_day: z.number().int().min(1).max(28).optional(),
    traffic_calc_type: z.enum(["sum", "rx", "tx"]).optional(),
    auto_update: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
    group_name: z.string().trim().max(64).nullable().optional(),
    tags: z.string().trim().max(512).nullable().optional(),
    sort_order: z.number().int().min(0).optional(),
  })
  .strict();

export const agentV2ImportSchema = z
  .array(z.union([agentV2ImportItemSchema, agentLegacyImportItemSchema]))
  .min(1)
  .max(500);

export const agentV2MetricsQuerySchema = z
  .object({ hours: z.enum(["1", "6", "12", "24", "168"]).default("24") })
  .strict();

export const agentV2RegistrationSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    hostname: z.string().trim().max(255).nullable().optional(),
    ip_addresses: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
    os: z.string().trim().max(128).nullable().optional(),
    version: z.string().trim().max(128).nullable().optional(),
  })
  .strict();

const agentReportSampleSchema = z
  .object({
    collected_at: z.string().datetime({ offset: true }),
    cpu: z
      .object({
        usage: percentMetric.optional(),
        cores: z.number().int().positive().max(4096).optional(),
        model_name: z.string().max(512).optional(),
      })
      .strict()
      .optional(),
    memory: z
      .object({
        total: boundedMetric.optional(),
        used: boundedMetric.optional(),
        free: boundedMetric.optional(),
        usage_rate: percentMetric.optional(),
      })
      .strict()
      .optional(),
    load: z
      .object({
        load1: boundedMetric.optional(),
        load5: boundedMetric.optional(),
        load15: boundedMetric.optional(),
      })
      .strict()
      .optional(),
    disks: z.array(diskMetricSchema).max(128).optional(),
    network: z.array(networkMetricSchema).max(128).optional(),
    swap: z
      .object({
        total: boundedMetric.optional(),
        used: boundedMetric.optional(),
        usage_rate: percentMetric.optional(),
      })
      .strict()
      .nullable()
      .optional(),
    process_count: z.number().int().nonnegative().max(10_000_000).optional(),
    tcp_connections: z.number().int().nonnegative().max(10_000_000).optional(),
    udp_connections: z.number().int().nonnegative().max(10_000_000).optional(),
    ping: boundedPingMap.optional(),
    ipv4_reachable: z.boolean().nullable().optional(),
    ipv6_reachable: z.boolean().nullable().optional(),
  })
  .strict();

// base64 字符集校验：解码前先挡掉明显非法的输入，避免把垃圾喂给解码器。
const base64Block = z
  .string()
  .min(1)
  // 32 字节块头 + 维度头 + 描述符 + gzip 载荷；256 KB base64 约合 192 KB 原始，
  // 远超正常块（约 2.6 KB），只作为兜底上限。
  .max(262_144)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "block.data 必须是标准 base64");

const agentReportBlockSchema = z
  .object({
    resolution: z.union([z.literal(1), z.literal(60)]),
    bucket_start: z.number().int().min(0).max(4_294_967_295),
    // 实际存在的槽数；1 秒块与 1 分钟块的槽上限都是 60
    point_count: z.number().int().min(1).max(60),
    codec: z.literal(1),
    data: base64Block,
  })
  .strict();

export const agentV5ReportSchema = z
  .object({
    protocol_version: z.literal(5),
    agent_version: z.string().trim().min(1).max(128).optional(),
    report_id: z.string().uuid(),
    hostname: z.string().trim().max(255).nullable().optional(),
    ip_addresses: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
    os: z.string().trim().max(128).nullable().optional(),
    version: z.string().trim().max(128).nullable().optional(),
    boot_time: z.number().int().nonnegative().nullable().optional(),
    keepalive_seconds: z.number().int().min(1).max(86400).optional(),
    report_interval_seconds: z.number().int().min(10).max(3600).optional(),
    // 一批最多 120 个块：断网恢复时一次补一小时的 1 秒块（60 个）
    // 外加跨小时的两个聚合块仍有充裕余量。
    blocks: z.array(agentReportBlockSchema).min(1).max(120),
    latest: agentReportSampleSchema.optional(),
  })
  .strict();
