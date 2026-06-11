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

// 手动检查监控
export const checkMonitor = async (
  id: number
): Promise<MonitorStatusHistoryResponse> => {
  const response = await api.post<MonitorStatusHistoryResponse>(
    `/api/monitors/${id}/check`
  );
  return response.data;
};
