export interface QueueFailureView {
  failure_id: string;
  queue_name: string;
  message_id: string;
  source_kind: string | null;
  source_id: string | null;
  delivery_attempts: number;
  last_error: string | null;
  status: string;
  replay_count: number;
  replayed_at: string | null;
  terminated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QueueLedgerHealth {
  generated_at: string;
  jobs: Record<string, number>;
  outbox: Record<string, number>;
  notifications: Record<string, number>;
  open_failures: number;
  oldest_job_available_at: string | null;
  oldest_outbox_available_at: string | null;
  job_lag_seconds: number;
  outbox_lag_seconds: number;
}
