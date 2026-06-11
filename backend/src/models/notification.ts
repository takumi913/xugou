// 通知渠道类型定义
export interface NotificationChannel {
  id: number;
  name: string;
  type: string; // email, telegram
  config: string; // JSON字符串
  enabled: boolean;
  created_by: number;
  created_at: string;
  updated_at: string;
}

// 通知模板类型定义
export interface NotificationTemplate {
  id: number;
  name: string;
  type: string; // default, custom
  subject: string;
  content: string;
  is_default: boolean;
  created_by: number;
  created_at: string;
  updated_at: string;
}

// 统一通知设置类型定义
export interface NotificationSettings {
  id: number;
  user_id: number;
  target_type: string; // global-monitor, global-agent, monitor, agent
  target_id: number | 0; // 当target_type为monitor或agent时有效，存储monitor_id或agent_id

  enabled: boolean;
  on_down: boolean; // 适用于monitor类型
  on_recovery: boolean; // 适用于monitor和agent类型

  on_offline: boolean; // 适用于agent类型
  on_cpu_threshold: boolean; // 适用于agent类型
  cpu_threshold: number; // 适用于agent类型
  on_memory_threshold: boolean; // 适用于agent类型
  memory_threshold: number; // 适用于agent类型
  on_disk_threshold: boolean; // 适用于agent类型
  disk_threshold: number; // 适用于agent类型
  cooldown_minutes: number; // 同类通知冷却时间，0 表示不抑制

  channels: string; // JSON字符串数组，存储channel IDs

  created_at: string;
  updated_at: string;
}

// 通知历史记录类型定义
export interface NotificationHistory {
  id: number;
  type: string; // monitor, agent, system
  target_id: number | null; // monitor_id或agent_id，系统通知为null
  channel_id: number;
  template_id: number;
  status: string; // success, failed, pending
  content: string;
  error: string | null;
  sent_at: string;
}

// 前端接口所需的通知配置类型
export interface NotificationConfig {
  channels: NotificationChannel[];
  templates: NotificationTemplate[];
  settings: {
    monitors: {
      enabled: boolean;
      onDown: boolean;
      onRecovery: boolean;
      cooldownMinutes: number;
      channels: string[];
    };
    agents: {
      enabled: boolean;
      onOffline: boolean;
      onRecovery: boolean;
      onCpuThreshold: boolean;
      cpuThreshold: number;
      onMemoryThreshold: boolean;
      memoryThreshold: number;
      onDiskThreshold: boolean;
      diskThreshold: number;
      cooldownMinutes: number;
      channels: string[];
    };
    specificMonitors: {
      [monitorId: string]: {
        enabled: boolean;
        onDown: boolean;
        onRecovery: boolean;
        cooldownMinutes: number;
        channels: string[];
      };
    };
    specificAgents: {
      [agentId: string]: {
        enabled: boolean;
        onOffline: boolean;
        onRecovery: boolean;
        onCpuThreshold: boolean;
        cpuThreshold: number;
        onMemoryThreshold: boolean;
        memoryThreshold: number;
        onDiskThreshold: boolean;
        diskThreshold: number;
        cooldownMinutes: number;
        channels: string[];
      };
    };
  };
}
