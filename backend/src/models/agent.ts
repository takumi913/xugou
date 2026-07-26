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
  history_partition_id?: number | null;
  // 服务端下发给探针的采集/上报间隔（秒）
  collect_interval?: number | null;
  report_interval?: number | null;
  // 上报来源地区（ISO 3166-1 两位码）
  region?: string | null;
  // 上报来源地理位置（Cloudflare cf.latitude/longitude/city/region，城市级；
  // 仅管理端使用，公开状态页白名单绝不输出）
  geo_latitude?: number | null;
  geo_longitude?: number | null;
  geo_city?: string | null;
  geo_region_name?: string | null;
  // 主机启动时间（Unix 秒）
  boot_time?: number | null;
  // 账单与到期信息
  price?: number | null;
  currency?: string | null;
  billing_cycle?: string | null;
  expire_date?: string | null;
  auto_renewal?: number | null;
  // 公开状态页隐藏开关
  is_hidden?: number | null;
  // 流量管理：月流量上限（GB，空=不限）/ 重置日（1-28，UTC）/ 计费方式（sum|rx|tx）
  traffic_limit_gb?: number | null;
  traffic_reset_day?: number | null;
  traffic_calc_type?: string | null;
  // 服务端触发探针自升级开关（协议 v3 update 指令）
  auto_update?: number | null;
  // 分组名（空=默认组）与标签（逗号分隔）
  group_name?: string | null;
  tags?: string | null;
  // 手动排序权重
  sort_order?: number | null;
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
  swap_total?: number | null;
  swap_used?: number | null;
  process_count?: number | null;
  tcp_connections?: number | null;
  udp_connections?: number | null;
  // 四线路 TCP 拨测结果 JSON（{ct/cu/cm/bd: {target, latency_ms, loss}}）
  ping_json?: string | null;
  ipv4_reachable?: number | null;
  ipv6_reachable?: number | null;
  // 服务端计算的实时网速（bytes/s，无法计算时为 null）
  network_rx_speed?: number | null;
  network_tx_speed?: number | null;
  // 当月累计流量（字节，仅最新指标携带；历史行不含）
  month_rx?: number | null;
  month_tx?: number | null;
}
