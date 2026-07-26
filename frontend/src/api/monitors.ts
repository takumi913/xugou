import api from "./client";
import {
  MonitorResponse,
  MonitorsResponse,
  CreateMonitorRequest,
  UpdateMonitorRequest,
  MonitorStatusHistoryResponse,
  DailyStatsResponse,
} from "../types/monitors";

// 获取所有监控
export const getAllMonitors = async (
  signal?: AbortSignal
): Promise<MonitorsResponse> => {
  const response = await api.get<MonitorsResponse>("/api/monitors", {
    signal,
  });
  return response.data;
};

// 获取所有每日统计
export const getAllDailyStats = async (
  signal?: AbortSignal
): Promise<DailyStatsResponse> => {
  const response = await api.get<DailyStatsResponse>("/api/monitors/daily", {
    signal,
  });
  return response.data;
};

// 获取单个监控每日统计
export const getMonitorDailyStats = async (
  id: number,
  signal?: AbortSignal
): Promise<DailyStatsResponse> => {
  const response = await api.get<DailyStatsResponse>(
    `/api/monitors/${id}/daily`,
    { signal }
  );
  return response.data;
};

// 获取单个监控
export const getMonitor = async (
  id: number,
  signal?: AbortSignal
): Promise<MonitorResponse> => {
  const response = await api.get<MonitorResponse>(`/api/monitors/${id}`, {
    signal,
  });
  return response.data;
};

// 创建监控
export const createMonitor = async (
  data: CreateMonitorRequest
): Promise<MonitorResponse> => {
  const response = await api.post<MonitorResponse>("/api/monitors", data);
  return response.data;
};

// 更新监控
export const updateMonitor = async (
  id: number,
  data: UpdateMonitorRequest
): Promise<MonitorResponse> => {
  const response = await api.put<MonitorResponse>(`/api/monitors/${id}`, data);
  return response.data;
};

// 删除监控
export const deleteMonitor = async (id: number): Promise<MonitorResponse> => {
  const response = await api.delete<MonitorResponse>(`/api/monitors/${id}`);
  return response.data;
};

// 获取单个监控历史 24小时内
export const getMonitorStatusHistoryById = async (
  id: number,
  signal?: AbortSignal
): Promise<MonitorStatusHistoryResponse> => {
  const response = await api.get<MonitorStatusHistoryResponse>(
    `/api/monitors/${id}/history`,
    { signal }
  );
  return response.data;
};

// 获取所有监控历史 24小时内
export const getAllMonitorHistory =
  async (signal?: AbortSignal): Promise<MonitorStatusHistoryResponse> => {
    const response = await api.get<MonitorStatusHistoryResponse>(
      `/api/monitors/history`,
      { signal }
    );
    return response.data;
  };

// 手动排序：按数组顺序保存 sort_order
export const updateMonitorsOrder = async (
  ids: number[]
): Promise<{ success: boolean; message?: string }> => {
  try {
    const response = await api.put("/api/monitors/order", { ids });
    return response.data;
  } catch (error) {
    console.error("保存监控排序失败:", error);
    return { success: false, message: "保存监控排序失败" };
  }
};

// 导出监控配置（JSON 数组）
export const exportMonitors = async (): Promise<unknown[]> => {
  const response = await api.get("/api/monitors/export");
  return response.data;
};

// 导入监控配置，返回 {created, skipped}
export const importMonitors = async (
  items: unknown[]
): Promise<{
  success: boolean;
  created?: number;
  skipped?: number;
  message?: string;
}> => {
  try {
    const response = await api.post("/api/monitors/import", items);
    return response.data;
  } catch (error) {
    console.error("导入监控失败:", error);
    return { success: false, message: "导入监控失败" };
  }
};

// 手动检查监控
export const checkMonitor = async (
  id: number
): Promise<MonitorStatusHistoryResponse> => {
  const response = await api.post<MonitorStatusHistoryResponse>(
    `/api/monitors/${id}/check`
  );
  return response.data;
};
