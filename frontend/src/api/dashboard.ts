import type { components } from "./generated/v2-schema";
import { unwrapOpenApi, v2Client } from "./generated/v2-client";

export type DashboardData = components["schemas"]["DashboardData"];
export type DashboardMonitor = components["schemas"]["DashboardMonitor"];
export type DashboardAgent = components["schemas"]["DashboardAgent"];

// 获取仪表盘数据
export const getDashboardData = async (): Promise<DashboardData> =>
  getDashboardDataWithSignal();

export const getDashboardDataWithSignal = async (
  signal?: AbortSignal
): Promise<DashboardData> => {
  const response = unwrapOpenApi(
    await v2Client.GET("/api/v2/dashboard", { signal })
  );
  return response;
};
