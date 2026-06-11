import { z } from "zod";

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

export const agentUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    hostname: z.string().trim().max(255).nullable().optional(),
    ip_addresses: z.array(z.string().trim().min(1).max(128)).optional(),
    os: z.string().trim().max(128).nullable().optional(),
    version: z.string().trim().max(128).nullable().optional(),
    status: z.string().trim().max(32).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "至少需要提供一个更新字段");

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

export function badRequest(message = "无效的请求数据") {
  return { success: false, message };
}
