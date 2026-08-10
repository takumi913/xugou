export type DashboardRecord = Record<string, unknown>;

export interface DashboardSummary {
  monitors_total: number;
  monitors_up: number;
  monitors_down: number;
  monitors_pending: number;
  monitors_avg_response_time_ms: number | null;
  agents_total: number;
  agents_online: number;
  agents_offline: number;
  total_traffic_bytes: number | null;
  network_rx_speed_bps: number | null;
  network_tx_speed_bps: number | null;
}

export interface DashboardProjection {
  monitors: DashboardRecord[];
  agents: DashboardRecord[];
  summary: DashboardSummary;
  monitors_has_more: boolean;
  agents_has_more: boolean;
}
