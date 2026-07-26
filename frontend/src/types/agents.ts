/**
 * 客户端相关类型定义
 */

export interface Agent {
  id: number;
  name: string;
  hostname?: string;
  ip_addresses?: string;
  status: "active" | "inactive" | "connecting" | "unknown";
  version?: string;
  os?: string;
  created_at: string;
  updated_at: string;
  last_seen_at?: string | null;
  last_state_changed_at?: string | null;
  next_offline_at?: string | null;
  collect_interval?: number | null;
  report_interval?: number | null;
  region?: string | null;
  // 上报来源地理位置（城市级，仅管理端接口返回；公开状态页无此字段）
  geo_latitude?: number | null;
  geo_longitude?: number | null;
  geo_city?: string | null;
  geo_region_name?: string | null;
  // 主机启动时间（Unix 秒）
  boot_time?: number | null;
  // 账单与到期信息
  price?: number | null;
  currency?: string | null;
  billing_cycle?: BillingCycle | null;
  expire_date?: string | null;
  auto_renewal?: number | null;
  // 公开状态页隐藏开关（1=隐藏）
  is_hidden?: number | null;
  // 流量管理：月流量上限（GB，空=不限）/ 重置日（1-28，UTC）/ 计费方式（sum|rx|tx）
  traffic_limit_gb?: number | null;
  traffic_reset_day?: number | null;
  traffic_calc_type?: TrafficCalcType | null;
  // 服务端触发探针自升级开关（0/1）
  auto_update?: number | null;
  // 分组名（空=默认组）与标签（逗号分隔）
  group_name?: string | null;
  tags?: string | null;
  // 手动排序权重
  sort_order?: number | null;
  metrics?: MetricHistory[];
}

// 流量计费方式
export type TrafficCalcType = "sum" | "rx" | "tx";

// 计费周期
export type BillingCycle = "monthly" | "quarterly" | "yearly" | "once";

// 单条线路 TCP 拨测结果（ping_json 内的值）
export interface PingResult {
  target?: string;
  latency_ms?: number;
  loss?: boolean;
}

export interface AgentWithLatestMetrics {
  id: number;
  name: string;
  hostname?: string;
  ip_addresses?: string;
  status: "active" | "inactive" | "connecting" | "unknown";
  version?: string;
  os?: string;
  created_at: string;
  updated_at: string;
  last_seen_at?: string | null;
  last_state_changed_at?: string | null;
  next_offline_at?: string | null;
  // 地区（ISO 3166 两位国家码；公开状态页白名单已含此字段）
  region?: string | null;
  // 流量管理配置（与 Agent 一致）
  traffic_limit_gb?: number | null;
  traffic_reset_day?: number | null;
  traffic_calc_type?: TrafficCalcType | null;
  // 分组名与标签（逗号分隔）
  group_name?: string | null;
  tags?: string | null;
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
  swap_total?: number | null;
  swap_used?: number | null;
  process_count?: number | null;
  tcp_connections?: number | null;
  udp_connections?: number | null;
  ping_json?: string | null; // 四线路拨测 JSON（{ct/cu/cm/bd: PingResult}）
  ipv4_reachable?: number | null; // 0/1
  ipv6_reachable?: number | null; // 0/1
  // 服务端计算的实时网速（bytes/s，无法计算时为 null）
  network_rx_speed?: number | null;
  network_tx_speed?: number | null;
  // 当月累计流量（字节，仅最新指标携带）
  month_rx?: number | null;
  month_tx?: number | null;
}

// 指标类型定义
export type MetricType = "cpu" | "memory" | "disk" | "network" | "load";
