// 通知渠道类型定义
export interface NotificationChannel {
  id: number;
  name: string;
  type: string; // telegram, resend, feishu, wecom
  config: Record<string, unknown>;
  enabled: boolean;
  createdBy?: number;
  createdAt?: string;
  updatedAt?: string;
}

// 通知模板类型定义
export interface NotificationTemplate {
  id: number;
  name: string;
  type: string; // monitor, agent
  subject: string;
  content: string;
  isDefault: boolean;
  createdBy?: number;
  createdAt?: string;
  updatedAt?: string;
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
      channels: number[];
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
      channels: number[];
    };
    specificMonitors: {
      [monitorId: string]: {
        enabled: boolean;
        onDown: boolean;
        onRecovery: boolean;
        cooldownMinutes: number;
        channels: number[];
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
        channels: number[];
      };
    };
  };
}
