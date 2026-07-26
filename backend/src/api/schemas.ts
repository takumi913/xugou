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

export const idParamSchema = z.coerce.number().int().positive();

export const authCredentialsSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

export const registerSchema = authCredentialsSchema.extend({
  email: z.string().trim().email().max(254).nullable().optional(),
});

export const monitorSchema = z.object({
  name: z.string().trim().min(1).max(128),
  url: z.string().trim().url().max(2048),
  method: z.string().trim().min(1).max(16),
  interval: z.coerce.number().int().positive().max(86400),
  timeout: z.coerce.number().int().positive().max(120000),
  expected_status: z.coerce.number().int().min(100).max(599),
  headers: z.union([z.string(), z.record(z.unknown())]).default("{}"),
  body: z.string().nullable().optional(),
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
  ids: z.array(z.coerce.number().int().positive()).min(1).max(1000),
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
  device: z.string().optional(),
  mount_point: z.string().optional(),
  total: z.number().optional(),
  used: z.number().optional(),
  free: z.number().optional(),
  usage_rate: z.number().optional(),
  fs_type: z.string().optional(),
});

const networkMetricSchema = z.object({
  interface: z.string().optional(),
  bytes_sent: z.number().optional(),
  bytes_recv: z.number().optional(),
  packets_sent: z.number().optional(),
  packets_recv: z.number().optional(),
});

// B3 采集增强字段（旧 agent 不上报时全部可缺省）
const swapMetricSchema = z
  .object({
    total: z.number().optional(),
    used: z.number().optional(),
    usage_rate: z.number().optional(),
  })
  .passthrough();

// 四线路 TCP 拨测结果（键为 ct/cu/cm/bd）
const pingResultSchema = z
  .object({
    target: z.string().optional(),
    latency_ms: z.number().optional(),
    loss: z.boolean().optional(),
  })
  .passthrough();

const agentExtraMetricFields = {
  swap: swapMetricSchema.nullable().optional(),
  process_count: z.number().int().nonnegative().optional(),
  tcp_connections: z.number().int().nonnegative().optional(),
  udp_connections: z.number().int().nonnegative().optional(),
  ping: z.record(pingResultSchema).optional(),
  ipv4_reachable: z.boolean().nullable().optional(),
  ipv6_reachable: z.boolean().nullable().optional(),
};

// 新协议批量上报中的单个采集样本（只含动态指标，token/元数据由顶层承载）
export const agentStatusSampleSchema = z
  .object({
    ts: z.number().int().positive().optional(), // Unix 毫秒
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
    disks: z.array(diskMetricSchema).optional(),
    network: z.array(networkMetricSchema).optional(),
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
  rollup: z.record(z.unknown()).optional(),
  threshold_events: z.array(z.record(z.unknown())).optional(),
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
  disks: z.array(diskMetricSchema).optional(),
  network: z.array(networkMetricSchema).optional(),
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
  monitors: z.array(z.coerce.number().int().positive()).default([]),
  agents: z.array(z.coerce.number().int().positive()).default([]),
});

export const userCreateSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(6).max(256),
  email: z.string().trim().email().max(254).nullable().optional(),
  role: z.enum(["manager", "user"]).default("user"),
});

export const userUpdateSchema = z
  .object({
    username: z.string().trim().min(1).max(64).optional(),
    email: z.string().trim().email().max(254).nullable().optional(),
    role: z.enum(["manager", "user"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "至少需要提供一个更新字段");

export const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(6).max(256),
});

export const allowRegistrationSchema = z.object({
  allow: z.boolean(),
});

export const notificationSettingsSchema = z.object({
  target_type: z.string(),
  target_id: z.number().nullable().optional(),
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
  channels: z.array(z.number()).or(z.string()),
});

// ---- B4b：通知渠道 config 校验 ----

// 可选字符串：空串/纯空白视为未填写
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

// Gotify 优先级：可选，空串视为未填写，接受数字或数字字符串
const optionalPrioritySchema = z.preprocess(
  (value) =>
    value === "" || value === null || value === undefined ? undefined : value,
  z.coerce.number().int().min(0).max(10).optional()
);

// 各渠道类型的 config 结构（多余字段默认剥离，与前端扁平表单兼容）
export const notificationChannelConfigSchemas: Record<string, z.ZodTypeAny> = {
  telegram: z.object({
    botToken: z.string().trim().min(1, "Bot Token 不能为空"),
    chatId: z.string().trim().min(1, "Chat ID 不能为空"),
  }),
  resend: z.object({
    apiKey: z.string().trim().min(1, "API 密钥不能为空"),
    from: z.string().trim().min(1, "发件人不能为空"),
    to: z.string().trim().min(1, "收件人不能为空"),
  }),
  feishu: z.object({
    webhookUrl: httpUrlSchema,
  }),
  wecom: z.object({
    webhookUrl: httpUrlSchema,
  }),
  dingtalk: z.object({
    webhook_url: httpUrlSchema,
    secret: optionalConfigString,
  }),
  bark: z.object({
    server_url: optionalHttpUrlSchema,
    device_key: z.string().trim().min(1, "Device Key 不能为空"),
    sound: optionalConfigString,
    group: optionalConfigString,
  }),
  serverchan: z.object({
    send_key: z.string().trim().min(1, "SendKey 不能为空"),
  }),
  wxpusher: z
    .object({
      app_token: z.string().trim().min(1, "App Token 不能为空"),
      uids: optionalConfigString,
      topic_ids: optionalConfigString,
    })
    .refine(
      (value) => Boolean(value.uids || value.topic_ids),
      "uids 与 topic_ids 至少需要填写一个"
    ),
  gotify: z.object({
    server_url: httpUrlSchema,
    app_token: z.string().trim().min(1, "App Token 不能为空"),
    priority: optionalPrioritySchema,
  }),
  // OneBot v11 HTTP（QQ）：api_url 为 OneBot HTTP 服务地址，
  // target_id 为 QQ 号或群号（按 message_type 区分）
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
  if (!schema) {
    // 未注册专用校验的类型保持原有行为（原样透传）
    return { success: true, config };
  }

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

export function badRequest(message = "无效的请求数据") {
  return { success: false, message };
}
