// 客户端类型定义
export interface Agent {
  id: number;
  name: string;
  token: string;
  created_by: number;
  status: string | null;
  created_at: string;
  updated_at: string;
  hostname: string | null;
  keepalive: string | null;
  ip_addresses: string | null; // 存储多个IP地址的JSON字符串
  os: string | null;
  version: string | null;
  last_seen_at: string | null;
  last_state_changed_at: string | null;
  next_offline_at: string | null;
}

// 客户端类型定义
export interface AgentWithMetrics {
  id: number;
  name: string;
  token: string;
  created_by: number;
  status: string;
  created_at: string;
  updated_at: string;
  hostname: string | null;
  keepalive: string | null;
  ip_addresses: string | null; // 存储多个IP地址的JSON字符串
  os: string | null;
  version: string | null;
  last_seen_at: string | null;
  last_state_changed_at: string | null;
  next_offline_at: string | null;
  metrics: Metrics[] | null;
}

export interface Metrics {
  id?: number;
  agent_id: number;
  timestamp: string;
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
  disk_metrics?: string | null;
  network_metrics?: string | null;
}
