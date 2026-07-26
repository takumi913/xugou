import api from "./client";
import { Monitor, Agent } from "../types";
import type { MetricHistory } from "../types/agents";

// 仪表盘接口返回的 agent：列表行 + 最新指标（含月流量与实时网速，可能为空）
export type DashboardAgent = Omit<Agent, "metrics"> & {
  metrics?: Partial<MetricHistory> | null;
};

// 获取仪表盘数据
export const getDashboardData = async (): Promise<{
  monitors: Monitor[];
  agents: DashboardAgent[];
}> => getDashboardDataWithSignal();

export const getDashboardDataWithSignal = async (
  signal?: AbortSignal
): Promise<{
  monitors: Monitor[];
  agents: DashboardAgent[];
}> => {
  const response = await api.get("/api/dashboard", { signal });
  return response.data;
};
