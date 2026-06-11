/**
 * 状态页面相关类型定义
 */

import { AgentWithLatestMetrics } from "./agents";
import { MonitorWithDailyStatsAndStatusHistory } from "./monitors";

export interface ConfigMonitor {
  id: number;
  name: string;
  selected: boolean;
}

export interface ConfigAgent {
  id: number;
  name: string;
  selected: boolean;
}

export interface StatusPageConfigResponse {
  title?: string;
  description?: string;
  logoUrl?: string;
  customCss?: string;
  monitors?: ConfigMonitor[];
  agents?: ConfigAgent[];
}

export interface StatusPageConfig {
  title: string;
  description: string;
  logoUrl: string;
  customCss: string;
  monitors: number[];
  agents: number[];
}

export interface StatusPageData {
  title: string;
  description: string;
  logoUrl: string;
  customCss: string;
  monitors: MonitorWithDailyStatsAndStatusHistory[];
  agents: AgentWithLatestMetrics[];
}
