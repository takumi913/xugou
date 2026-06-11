import api from "./client";
import {
  StatusPageConfig,
  StatusPageConfigResponse,
  StatusPageData,
} from "../types/status";
import { MetricHistory } from "../types/agents";

// 获取状态页配置
export const getStatusPageConfig = async (
  signal?: AbortSignal
): Promise<StatusPageConfigResponse> => {
    const response = await api.get<StatusPageConfigResponse>(
      "/api/status/config",
      { signal }
    );
    return response.data;
  };

// 保存状态页配置
export const saveStatusPageConfig = async (
  config: StatusPageConfig
): Promise<StatusPageConfigResponse> => {
  const response = await api.post<StatusPageConfigResponse>(
    "/api/status/config",
    config
  );
  return response.data;
};

// 获取状态页数据
export const getStatusPageData = async (
  userId: number,
  signal?: AbortSignal
): Promise<StatusPageData> => {
  const response = await api.get<StatusPageData>(
    `/api/status/public/${userId}/data`,
    { signal }
  );
  return response.data;
};

export const getPublicAgentMetrics = async (
  userId: number,
  agentId: number,
  signal?: AbortSignal
): Promise<{
  success: boolean;
  agent?: MetricHistory[];
  message?: string;
}> => {
  const response = await api.get<{
    success: boolean;
    agent?: MetricHistory[];
    message?: string;
  }>(`/api/status/public/${userId}/agents/${agentId}/metrics`, { signal });
  return response.data;
};
