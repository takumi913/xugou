import {
  StatusPageConfig,
  StatusPageConfigResponse,
  StatusPageData,
} from "../types/status";
import { PublicMetricHistory } from "../types/agents";
import { unwrapOpenApi, v2Client } from "./generated/v2-client";

// 获取状态页配置
export const getStatusPageConfig = async (
  signal?: AbortSignal
): Promise<StatusPageConfigResponse> => {
    const response = await v2Client.GET("/api/v2/status/config", { signal });
    return unwrapOpenApi(response).data;
  };

// 保存状态页配置
export const saveStatusPageConfig = async (
  config: StatusPageConfig
): Promise<StatusPageConfigResponse> => {
  const response = await v2Client.PUT("/api/v2/status/config", {
    body: config,
  });
  return unwrapOpenApi(response).data;
};

// 获取状态页数据
export const getStatusPageData = async (
  signal?: AbortSignal
): Promise<StatusPageData> => {
  const response = await v2Client.GET("/api/v2/status/public", { signal });
  return unwrapOpenApi(response);
};

export const getPublicAgentMetrics = async (
  agentId: number,
  signal?: AbortSignal
): Promise<{
  success: boolean;
  agent?: PublicMetricHistory[];
  message?: string;
}> => {
  const response = await v2Client.GET(
    "/api/v2/status/public/agents/{agentId}/metrics",
    {
      params: { path: { agentId } },
      signal,
    }
  );
  const payload = unwrapOpenApi(response);
  return {
    ...payload,
    agent: payload.agent?.map((metric) => ({
      ...metric,
      id: metric.id === undefined ? undefined : Number(metric.id),
    })),
  };
};
