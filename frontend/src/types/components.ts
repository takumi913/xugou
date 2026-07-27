/**
 * 组件相关类型定义
 */
import { Monitor } from "./monitors";
import { Agent, MetricHistory } from "./agents";

// MonitorCard 组件类型
export interface MonitorCardProps {
  monitor: Monitor;
}

// StatusCodeSelect 组件类型
export interface StatusCodeSelectProps {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}

// AgentCard 组件类型
export interface AgentCardProps {
  agent: Agent;
  metrics?: MetricHistory[];
  // 实时/最新样本（WS 或最新指标接口），优先于历史里的最新一条（速率/月流量等）
  liveMetric?: Partial<MetricHistory> | null;
  showIpAddress?: boolean; // 是否显示IP地址
  showHostname?: boolean; // 是否显示主机名
  showLastUpdated?: boolean; // 是否显示最后更新时间

  onView?: (id: number) => void;
  onEdit?: (id: number) => void;
  onDelete?: (id: number) => void;
}

// Layout 组件类型
export interface LayoutProps {
  children: React.ReactNode;
}
