import { z } from "zod";
import {
  MAX_COLLECT_INTERVAL,
  MAX_REPORT_INTERVAL,
  MAX_REPORT_SAMPLES,
  MIN_COLLECT_INTERVAL,
  MIN_REPORT_INTERVAL,
} from "../utils/agentConfig";
import {
  MAX_TRAFFIC_RESET_DAY,
  MIN_TRAFFIC_RESET_DAY,
  TRAFFIC_CALC_TYPES,
} from "../utils/traffic";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_NUMBER,
  MAX_PAGE_SIZE,
} from "../utils/pagination";

export const idParamSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const notificationHistoryQuerySchema = z
  .object({
    type: z.string().trim().max(64).optional(),
    target_id: idParamSchema.optional(),
    status: z.string().trim().max(64).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE),
    page: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_NUMBER)
      .default(1),
  })
  .strict();

export const securityAuditQuerySchema = z
  .object({
    eventType: z.string().trim().min(1).max(128).optional(),
    outcome: z.enum(["success", "failure", "denied"]).optional(),
    page: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_NUMBER)
      .default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export const monitorSchema = z.object({
  name: z.string().trim().min(1).max(128),
  url: z.string().trim().url().max(2048),
  method: z.string().trim().min(1).max(16),
  interval: z.coerce.number().int().positive().max(86400),
  timeout: z.coerce.number().int().positive().max(120000),
  expected_status: z.coerce.number().int().min(100).max(599),
  headers: z.union([
    z.string().max(1_000_000),
    z.record(z.string().max(8192)).superRefine((headers, context) => {
      const entries = Object.entries(headers);
      if (entries.length > 50) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "最多允许 50 个请求头",
        });
      }
      if (entries.some(([key]) => key.length === 0 || key.length > 128)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "请求头名称长度无效",
        });
      }
    }),
  ]).default("{}"),
  body: z.string().max(1024 * 1024).nullable().optional(),
  active: z.boolean().optional(),
});

export const monitorUpdateSchema = monitorSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "至少需要提供一个更新字段"
);

export const agentRegisterSchema = z.object({
  token: z.string().trim().min(1).max(512),
  name: z.string().trim().min(1).max(128).optional(),
  hostname: z.string().trim().max(255).nullable().optional(),
  ip_addresses: z.array(z.string().trim().min(1).max(128)).nullable().optional(),
  os: z.string().trim().max(128).nullable().optional(),
  version: z.string().trim().max(128).nullable().optional(),
});

// 布尔开关：接受 boolean/0/1，统一转为 0/1 整型
const booleanFlagSchema = z
  .union([z.boolean(), z.literal(0), z.literal(1)])
  .transform((value) => (value === true || value === 1 ? 1 : 0));

// PUT /api/agents/:id 与导入共用的可更新字段集合
const agentUpdateFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    hostname: z.string().trim().max(255).nullable().optional(),
    ip_addresses: z.array(z.string().trim().min(1).max(128)).optional(),
    os: z.string().trim().max(128).nullable().optional(),
    version: z.string().trim().max(128).nullable().optional(),
    status: z.string().trim().max(32).nullable().optional(),
    // 探针间隔配置（秒），上下限来自 utils/agentConfig；report >= collect 在服务层合并后校验
    collect_interval: z.coerce
      .number()
      .int()
      .min(MIN_COLLECT_INTERVAL)
      .max(MAX_COLLECT_INTERVAL)
      .optional(),
    report_interval: z.coerce
      .number()
      .int()
      .min(MIN_REPORT_INTERVAL)
      .max(MAX_REPORT_INTERVAL)
      .optional(),
    // 账单与到期信息
    price: z.coerce.number().min(0).max(1000000).nullable().optional(),
    currency: z.string().trim().max(16).nullable().optional(),
    billing_cycle: z
      .enum(["monthly", "quarterly", "yearly", "once"])
      .nullable()
      .optional(),
    expire_date: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "到期日期需为 YYYY-MM-DD")
      .nullable()
      .optional(),
    auto_renewal: booleanFlagSchema.optional(),
    // 公开状态页隐藏开关
    is_hidden: booleanFlagSchema.optional(),
    // 流量管理：月流量上限（GB，null=不限）/ 重置日（1-28）/ 计费方式
    traffic_limit_gb: z.coerce
      .number()
      .positive()
      .max(1000000000)
      .nullable()
      .optional(),
    traffic_reset_day: z.coerce
      .number()
      .int()
      .min(MIN_TRAFFIC_RESET_DAY)
      .max(MAX_TRAFFIC_RESET_DAY)
      .optional(),
    traffic_calc_type: z.enum(TRAFFIC_CALC_TYPES).optional(),
    // 服务端触发探针自升级开关（协议 v3）
    auto_update: booleanFlagSchema.optional(),
    // 分组名（空/null=默认组）与标签（逗号分隔）
    group_name: z.string().trim().max(64).nullable().optional(),
    tags: z.string().trim().max(512).nullable().optional(),
  });

export const agentUpdateSchema = agentUpdateFieldsSchema.refine(
  (value) => Object.keys(value).length > 0,
  "至少需要提供一个更新字段"
);

// ---- C3：手动排序 / 导入导出 ----

// PUT /api/agents/order 与 /api/monitors/order 请求体
export const orderUpdateSchema = z.object({
  ids: z.array(idParamSchema).min(1).max(1000),
});

// 导入的单个 agent：name 必填，token 可选（缺失/冲突时服务端重新生成）
export const agentImportItemSchema = agentUpdateFieldsSchema.extend({
  name: z.string().trim().min(1).max(128),
  token: z.string().trim().min(1).max(512).optional(),
  sort_order: z.coerce.number().int().min(0).optional(),
});

export const agentImportSchema = z
  .array(agentImportItemSchema)
  .min(1)
  .max(500);

// 导入的单个 monitor：复用创建校验并允许携带 sort_order
export const monitorImportSchema = z
  .array(
    monitorSchema.extend({
      sort_order: z.coerce.number().int().min(0).optional(),
    })
  )
  .min(1)
  .max(500);

const diskMetricSchema = z.object({
  device: z.string().max(128).optional(),
  mount_point: z.string().max(512).optional(),
  total: z.number().optional(),
  used: z.number().optional(),
  free: z.number().optional(),
  usage_rate: z.number().optional(),
  fs_type: z.string().max(128).optional(),
}).strict();

const networkMetricSchema = z.object({
  interface: z.string().max(128).optional(),
  bytes_sent: z.number().optional(),
  bytes_recv: z.number().optional(),
  packets_sent: z.number().optional(),
  packets_recv: z.number().optional(),
}).strict();

// B3 采集增强字段（旧 agent 不上报时全部可缺省）
const swapMetricSchema = z
  .object({
    total: z.number().optional(),
    used: z.number().optional(),
    usage_rate: z.number().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (Object.keys(value).length > 16) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Swap 指标字段过多",
      });
    }
  });

// 四线路 TCP 拨测结果（键为 ct/cu/cm/bd）
const pingResultSchema = z
  .object({
    target: z.string().max(512).optional(),
    latency_ms: z.number().finite().min(-1).max(Number.MAX_SAFE_INTEGER).optional(),
    loss: z.boolean().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (Object.keys(value).length > 16) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Ping 结果字段过多",
      });
    }
  });

const agentExtraMetricFields = {
  swap: swapMetricSchema.nullable().optional(),
  process_count: z.number().int().nonnegative().optional(),
  tcp_connections: z.number().int().nonnegative().optional(),
  udp_connections: z.number().int().nonnegative().optional(),
  ping: z
    .record(pingResultSchema)
    .superRefine((value, context) => {
      if (Object.keys(value).length > 128) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Ping 目标过多",
        });
      }
    })
    .optional(),
  ipv4_reachable: z.boolean().nullable().optional(),
  ipv6_reachable: z.boolean().nullable().optional(),
};

// 新协议批量上报中的单个采集样本（只含动态指标，token/元数据由顶层承载）
export const agentStatusSampleSchema = z
  .object({
    ts: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(), // Unix 毫秒
    timestamp: z.union([z.string(), z.date()]).optional(),
    cpu: z
      .object({
        usage: z.number().optional(),
        cores: z.number().optional(),
        model_name: z.string().optional(),
      })
      .optional(),
    memory: z
      .object({
        total: z.number().optional(),
        used: z.number().optional(),
        free: z.number().optional(),
        usage_rate: z.number().optional(),
      })
      .optional(),
    load: z
      .object({
        load1: z.number().optional(),
        load5: z.number().optional(),
        load15: z.number().optional(),
      })
      .optional(),
    disks: z.array(diskMetricSchema).max(128).optional(),
    network: z.array(networkMetricSchema).max(128).optional(),
    ...agentExtraMetricFields,
  })
  .passthrough();

export const agentStatusItemSchema = z.object({
  token: z.string().trim().min(1).max(512),
  schema_version: z.union([z.string(), z.number()]).optional(),
  timestamp: z.union([z.string(), z.date()]).optional(),
  hostname: z.string().nullable().optional(),
  ip_addresses: z.array(z.string()).nullable().optional(),
  os: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  keepalive: z.union([z.string(), z.number()]).optional(),
  collect_interval_seconds: z.number().int().positive().optional(),
  report_interval_seconds: z.number().int().positive().optional(),
  window_start: z.string().optional(),
  window_end: z.string().optional(),
  sample_count: z.number().int().nonnegative().optional(),
  rollup: z
    .record(z.unknown())
    .superRefine((value, context) => {
      if (Object.keys(value).length > 128) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Rollup 字段过多",
        });
      }
    })
    .optional(),
  threshold_events: z
    .array(
      z.record(z.unknown()).superRefine((value, context) => {
        if (Object.keys(value).length > 32) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "阈值事件字段过多",
          });
        }
      })
    )
    .max(128)
    .optional(),
  cpu: z
    .object({
      usage: z.number().optional(),
      cores: z.number().optional(),
      model_name: z.string().optional(),
    })
    .optional(),
  memory: z
    .object({
      total: z.number().optional(),
      used: z.number().optional(),
      free: z.number().optional(),
      usage_rate: z.number().optional(),
    })
    .optional(),
  load: z
    .object({
      load1: z.number().optional(),
      load5: z.number().optional(),
      load15: z.number().optional(),
    })
    .optional(),
  disks: z.array(diskMetricSchema).max(128).optional(),
  network: z.array(networkMetricSchema).max(128).optional(),
  // 主机启动时间（Unix 秒，稳定元数据）
  boot_time: z.number().int().nonnegative().optional(),
  ...agentExtraMetricFields,
  // 新协议：整个上报窗口内的全部采集样本（顶层仍为最新样本，旧服务端忽略此字段）
  samples: z.array(agentStatusSampleSchema).max(MAX_REPORT_SAMPLES).optional(),
}).passthrough();

export const agentStatusSchema = z.union([
  agentStatusItemSchema,
  z.array(agentStatusItemSchema).min(1).max(100),
]);

export const statusPageConfigSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  logoUrl: z.string().trim().max(2048).optional().default(""),
  customCss: z.string().max(20000).optional().default(""),
  // 主题 id：与前端主题文件夹名一致（kebab-case）；服务端只做格式校验，
  // 未知 id 由前端回退默认主题
  theme: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
    .optional()
    .default("mono"),
  monitors: z.array(idParamSchema).max(100).default([]),
  agents: z.array(idParamSchema).max(100).default([]),
}).superRefine((value, context) => {
  if (new Set(value.monitors).size !== value.monitors.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["monitors"],
      message: "Monitor IDs must be unique",
    });
  }
  if (new Set(value.agents).size !== value.agents.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["agents"],
      message: "Agent IDs must be unique",
    });
  }
});

export const notificationSettingsSchema = z.object({
  target_type: z.enum(["global-monitor", "global-agent", "monitor", "agent"]),
  target_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  enabled: z.boolean(),
  on_down: z.boolean().optional(),
  on_recovery: z.boolean().optional(),
  on_offline: z.boolean().optional(),
  on_cpu_threshold: z.boolean().optional(),
  cpu_threshold: z.number().optional(),
  on_memory_threshold: z.boolean().optional(),
  memory_threshold: z.number().optional(),
  on_disk_threshold: z.boolean().optional(),
  disk_threshold: z.number().optional(),
  cooldown_minutes: z.number().int().min(0).max(1440).optional(),
  channels: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(100).or(z.string().max(8192)),
});

export function badRequest(message = "无效的请求数据") {
  return { success: false, message };
}
