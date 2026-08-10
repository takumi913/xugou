export interface MonitorView {
  id: number;
  name: string;
  url: string;
  method: string;
  interval_seconds: number;
  timeout_ms: number;
  expected_status: number;
  headers: Record<string, string>;
  body: string | null;
  active: boolean;
  status: string | null;
  response_time_ms: number | null;
  last_checked_at: string | null;
  next_check_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface MonitorMutation {
  name: string;
  url: string;
  method: string;
  interval_seconds: number;
  timeout_ms: number;
  expected_status: number;
  headers: Record<string, string>;
  body?: string | null;
  active?: boolean;
}
