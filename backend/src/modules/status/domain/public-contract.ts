const PRIVATE_PUBLIC_MONITOR_FIELDS = [
  "url",
  "method",
  "headers",
  "body",
  "interval",
  "timeout",
  "expected_status",
  "active",
] as const;

const PRIVATE_PUBLIC_AGENT_FIELDS = [
  "token",
  "ip_addresses",
  "geo_latitude",
  "geo_longitude",
  "geo_city",
  "geo_region_name",
  "price",
  "currency",
  "billing_cycle",
  "expire_date",
  "auto_renewal",
] as const;

const PRIVATE_PUBLIC_KEYS = new Set<string>([
  ...PRIVATE_PUBLIC_MONITOR_FIELDS,
  ...PRIVATE_PUBLIC_AGENT_FIELDS,
  "password",
  "password_hash",
  "authorization",
  "cookie",
  "secret",
  "token_digest",
  "wrapped_dek",
  "ciphertext",
  "api_key",
  "access_token",
]);

const MAX_PUBLIC_METRIC_ITEMS = 128;
const MAX_PUBLIC_METRIC_STRING = 512;

export interface PublicDiskMetric {
  device: string;
  mount_point: string;
  total: number;
  used: number;
  free: number;
  usage_rate: number;
  fs_type: string;
}

export interface PublicNetworkMetric {
  interface: string;
  bytes_sent: number;
  bytes_recv: number;
  packets_sent: number;
  packets_recv: number;
}

export interface PublicAgentMetric {
  id: number | string;
  agent_id: number;
  timestamp: string | null;
  cpu_usage?: number | null;
  cpu_cores?: number | null;
  cpu_model?: string | null;
  memory_total?: number | null;
  memory_used?: number | null;
  memory_free?: number | null;
  memory_usage_rate?: number | null;
  load_1?: number | null;
  load_5?: number | null;
  load_15?: number | null;
  disk_metrics: PublicDiskMetric[];
  network_metrics: PublicNetworkMetric[];
  swap_total?: number | null;
  swap_used?: number | null;
  process_count?: number | null;
  tcp_connections?: number | null;
  udp_connections?: number | null;
  ipv4_reachable?: number | null;
  ipv6_reachable?: number | null;
  network_rx_speed?: number | null;
  network_tx_speed?: number | null;
  month_rx?: number | null;
  month_tx?: number | null;
}

export type PublicAgentSource = {
  id: number;
  name: string;
  status: string | null;
  hostname: string | null;
  os: string | null;
  version: string | null;
  region?: string | null;
  created_at: string;
  updated_at: string;
  traffic_limit_gb?: number | null;
  traffic_reset_day?: number | null;
  traffic_calc_type?: string | null;
};

export type PublicMonitorSource = {
  id: number;
  name: string;
  status: string | null;
  response_time: number | null;
  last_checked: string | null;
  created_at: string;
  updated_at: string;
};

export function toPublicAgent(agent: PublicAgentSource) {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    hostname: agent.hostname,
    os: agent.os,
    version: agent.version,
    region: agent.region ?? null,
    created_at: agent.created_at,
    updated_at: agent.updated_at,
    traffic_limit_gb: agent.traffic_limit_gb ?? null,
    traffic_reset_day: agent.traffic_reset_day ?? null,
    traffic_calc_type: agent.traffic_calc_type ?? null,
  };
}

export function toPublicMonitor(monitor: PublicMonitorSource) {
  return {
    id: monitor.id,
    name: monitor.name,
    status: monitor.status ?? "pending",
    response_time: monitor.response_time ?? 0,
    last_checked: monitor.last_checked ?? null,
    created_at: monitor.created_at,
    updated_at: monitor.updated_at,
  };
}

function decodedJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 1_000_000 ||
    (!trimmed.startsWith("{") && !trimmed.startsWith("["))
  ) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function hasPrivatePublicKeyDeep(value: unknown, depth = 0): boolean {
  if (depth > 16) return true;
  if (typeof value === "string") {
    const decoded = decodedJsonString(value);
    return decoded !== undefined && hasPrivatePublicKeyDeep(decoded, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasPrivatePublicKeyDeep(item, depth + 1));
  }
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) =>
      PRIVATE_PUBLIC_KEYS.has(key.toLowerCase()) ||
      hasPrivatePublicKeyDeep(child, depth + 1)
  );
}

function finiteNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, maximum)
    : 0;
}

function boundedString(value: unknown) {
  return typeof value === "string" ? value.slice(0, MAX_PUBLIC_METRIC_STRING) : "";
}

function metricArray(value: unknown): unknown[] | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return Array.isArray(value) ? value.slice(0, MAX_PUBLIC_METRIC_ITEMS) : null;
}

export function projectPublicDiskMetrics(value: unknown): PublicDiskMetric[] | null {
  const source = metricArray(value);
  if (source === null) return null;
  if (hasPrivatePublicKeyDeep(source)) {
    throw new Error("PUBLIC_METRIC_SENSITIVE_KEY");
  }
  return source.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    return [{
      device: boundedString(row.device),
      mount_point: boundedString(row.mount_point),
      total: finiteNumber(row.total),
      used: finiteNumber(row.used),
      free: finiteNumber(row.free),
      usage_rate: finiteNumber(row.usage_rate, 100),
      fs_type: boundedString(row.fs_type),
    }];
  });
}

export function projectPublicNetworkMetrics(
  value: unknown
): PublicNetworkMetric[] | null {
  const source = metricArray(value);
  if (source === null) return null;
  if (hasPrivatePublicKeyDeep(source)) {
    throw new Error("PUBLIC_METRIC_SENSITIVE_KEY");
  }
  return source.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    return [{
      interface: boundedString(row.interface),
      bytes_sent: finiteNumber(row.bytes_sent),
      bytes_recv: finiteNumber(row.bytes_recv),
      packets_sent: finiteNumber(row.packets_sent),
      packets_recv: finiteNumber(row.packets_recv),
    }];
  });
}

/**
 * Publication payloads cross the anonymous boundary. Validate the complete object,
 * including nested metrics, before making an immutable publication active.
 */
export function parsePublicStatusSnapshot(snapshotJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(snapshotJson);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { monitors?: unknown }).monitors) ||
      !Array.isArray((parsed as { agents?: unknown }).agents) ||
      hasPrivatePublicKeyDeep(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
