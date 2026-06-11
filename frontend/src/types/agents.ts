/**
 * 客户端相关类型定义
 */

export interface Agent {
  id: number;
  name: string;
  hostname?: string;
  ip_addresses?: string;
  status:
    | "active"
    | "inactive"
    | "connecting"
    | "unknown"
    | "online"
    | "offline";
  version?: string;
  os?: string;
  created_at: string;
  updated_at: string;
  last_seen_at?: string | null;
  last_state_changed_at?: string | null;
  next_offline_at?: string | null;
  metrics?: MetricHistory[];
}

export interface AgentWithLatestMetrics {
  id: number;
  name: string;
  hostname?: string;
  ip_addresses?: string;
  status:
    | "active"
    | "inactive"
    | "connecting"
    | "unknown"
    | "online"
    | "offline";
  version?: string;
  os?: string;
  created_at: string;
  updated_at: string;
  last_seen_at?: string | null;
  last_state_changed_at?: string | null;
  next_offline_at?: string | null;
  metrics?: MetricHistory;
}

export interface AgentResponse {
  success: boolean;
  agent?: Agent;
}

export interface AgentsResponse {
  success: boolean;
  agents?: Agent[];
}

// 指标历史数据接口
export interface MetricHistory {
  id: number;
  agent_id: number;
  timestamp: string;
  cpu_usage?: number;
  cpu_cores?: number;
  cpu_model?: string;
  memory_total?: number;
  memory_used?: number;
  memory_free?: number;
  memory_usage_rate?: number;
  load_1?: number;
  load_5?: number;
  load_15?: number;
  disk_metrics?: string; // JSON字符串
  network_metrics?: string; // JSON字符串
}

// 指标类型定义
export type MetricType = "cpu" | "memory" | "disk" | "network" | "load";
