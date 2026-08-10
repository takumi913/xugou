export interface NotificationChannelCommand {
  name: string;
  type: string;
  config: string;
  enabled: boolean;
}

export interface NotificationChannelMutation {
  name?: string;
  type?: string;
  config?: string;
  enabled?: boolean;
}

export interface NotificationTemplateCommand {
  name: string;
  type: "monitor" | "agent";
  subject: string;
  content: string;
  is_default: boolean;
}

export interface NotificationSettingCommand {
  target_type: "global-monitor" | "global-agent" | "monitor" | "agent";
  target_id: number;
  enabled: boolean;
  on_down: boolean;
  on_recovery: boolean;
  on_offline: boolean;
  on_cpu_threshold: boolean;
  cpu_threshold: number;
  on_memory_threshold: boolean;
  memory_threshold: number;
  on_disk_threshold: boolean;
  disk_threshold: number;
  cooldown_minutes: number;
  channels: string;
}

export type NotificationResourceTarget = "monitor" | "agent";

export interface NotificationResourceSettingView {
  target_type: NotificationResourceTarget;
  id: number;
  name: string;
  description: string | null;
  sort_order: number;
  setting: Record<string, unknown> | null;
}
