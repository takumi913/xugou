export interface AgentView {
  id: number;
  name: string;
  status: string;
  hostname: string | null;
  ip_addresses: string[];
  os: string | null;
  version: string | null;
  keepalive: string | null;
  boot_time: number | null;
  collect_interval_seconds: number;
  report_interval_seconds: number;
  last_seen_at: string | null;
  next_offline_at: string | null;
  group_name: string | null;
  tags: string[];
  price: number | null;
  currency: string | null;
  billing_cycle: string | null;
  expire_date: string | null;
  auto_renewal: boolean;
  is_hidden: boolean;
  traffic_limit_gb: number | null;
  traffic_reset_day: number;
  traffic_calc_type: string;
  auto_update: boolean;
  region: string | null;
  geo_latitude: number | null;
  geo_longitude: number | null;
  geo_city: string | null;
  geo_region_name: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface AgentMutation {
  name?: string;
  hostname?: string | null;
  ip_addresses?: string[];
  os?: string | null;
  version?: string | null;
  status?: string | null;
  collect_interval_seconds?: number;
  report_interval_seconds?: number;
  group_name?: string | null;
  tags?: string[];
  auto_update?: boolean;
  is_hidden?: boolean;
  price?: number | null;
  currency?: string | null;
  billing_cycle?: string | null;
  expire_date?: string | null;
  auto_renewal?: boolean;
  traffic_limit_gb?: number | null;
  traffic_reset_day?: number;
  traffic_calc_type?: string;
}

export interface AgentReportSample {
  collected_at: string;
  cpu?: {
    usage?: number;
    cores?: number;
    model_name?: string;
  };
  memory?: {
    total?: number;
    used?: number;
    free?: number;
    usage_rate?: number;
  };
  load?: { load1?: number; load5?: number; load15?: number };
  disks?: Array<Record<string, string | number | boolean | null>>;
  network?: Array<Record<string, string | number | boolean | null>>;
  swap?: { total?: number; used?: number; usage_rate?: number } | null;
  process_count?: number;
  tcp_connections?: number;
  udp_connections?: number;
  ping?: Record<string, Record<string, string | number | boolean | null>>;
  ipv4_reachable?: boolean | null;
  ipv6_reachable?: boolean | null;
  // 服务端派生字段；HTTP v4 输入 Schema 不接受客户端覆盖。
  network_rx_speed?: number | null;
  network_tx_speed?: number | null;
}

/**
 * 一个列式压缩的指标块。`data` 是 base64，解码规格见 ../metricblock。
 * 服务端按 (agent_id, resolution, bucket_start) 幂等 upsert。
 */
export interface AgentReportBlock {
  /** 1 = 1 秒块（桶跨 1 分钟）；60 = 1 分钟聚合块（桶跨 1 小时） */
  resolution: 1 | 60;
  bucket_start: number;
  /**
   * 实际存在的槽数，用于 upsert 的单调守卫。
   * 与块头里恒为 60 的 slot_count 不是一回事。
   */
  point_count: number;
  codec: 1;
  data: string;
}

export interface AgentReportCommand {
  protocol_version: 5;
  agent_version?: string;
  report_id: string;
  hostname?: string | null;
  ip_addresses?: string[];
  os?: string | null;
  version?: string | null;
  boot_time?: number | null;
  keepalive_seconds?: number;
  report_interval_seconds?: number;
  blocks: AgentReportBlock[];
  /** 本批次最后一条原始样本，用于更新 agent_current_metrics 与静态元数据。 */
  latest?: AgentReportSample;
}

export interface AuthenticatedAgent {
  id: number;
  name: string;
  status: string;
  collect_interval_seconds: number;
  report_interval_seconds: number;
  auto_update: boolean;
}
