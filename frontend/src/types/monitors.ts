/**
 * 监控相关类型定义
 */

export interface Monitor {
  id: number;
  name: string;
  url: string;
  method: string;
  headers?: Record<string, string> | string | null;
  body?: string;
  expected_status?: number;
  interval: number;
  timeout: number;
  status: "up" | "down" | "pending" | "unknown" | "error";
  last_checked?: string;
  next_check_at?: string;
  response_time?: number;
  user_id: number;
  created_by?: number;
  active?: number;
  created_at: string;
  updated_at: string;
}

export interface MonitorWithDailyStatsAndStatusHistory extends Monitor {
  dailyStats: DailyStats[];
  history: MonitorStatusHistory[];
}

export interface MonitorStatusHistory {
  id: number;
  monitor_id: number;
  status: "up" | "down";
  response_time?: number;
  timestamp?: string;
  status_code?: number;
  error?: string;
}

export interface MonitorStatusHistoryResponse {
  success: boolean;
  message: string;
  history?: MonitorStatusHistory[];
}

export interface MonitorResponse {
  success: boolean;
  message: string;
  monitor?: Monitor;
}

export interface MonitorsResponse {
  success: boolean;
  message: string;
  monitors?: Monitor[];
}

export interface DailyStatsResponse {
  success: boolean;
  message: string;
  dailyStats?: DailyStats[];
}

export interface CreateMonitorRequest {
  name: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  expected_status?: number;
  interval: number;
  timeout: number;
}

export interface UpdateMonitorRequest {
  name?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  expected_status?: number;
  interval?: number;
  timeout?: number;
}

// 新增每日统计数据类型
export interface DailyStats {
  date: string;
  total_checks: number;
  up_checks: number;
  down_checks: number;
  avg_response_time: number;
  min_response_time: number;
  max_response_time: number;
  availability: number;
  monitor_id: number;
  created_at: string;
}
