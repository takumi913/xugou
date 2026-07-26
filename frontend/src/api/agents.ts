import api from "./client";
import {
  Agent,
  AgentResponse,
  AgentsResponse,
  AgentWithLatestMetrics,
  MetricHistory,
} from "../types/agents";

export const generateToken = async (): Promise<{
  success: boolean;
  token?: string;
  message?: string;
}> => {
  try {
    const response = await api.post("/api/agents/token/generate");
    return response.data;
  } catch (error) {
    console.error("生成客户端注册令牌失败:", error);
    return {
      success: false,
      message: "生成客户端注册令牌失败",
    };
  }
};

export const getAllAgents = async (): Promise<AgentsResponse> => {
  const response = await api.get("/api/agents");
  return {
    success: true,
    agents: response.data.agents,
  };
};

export const getAllAgentsWithLatestMetrics = async (): Promise<{
  success: boolean;
  agents?: AgentWithLatestMetrics[];
  message?: string;
}> => getAllAgentsWithLatestMetricsWithSignal();

export const getAllAgentsWithLatestMetricsWithSignal = async (
  signal?: AbortSignal
): Promise<{
  success: boolean;
  agents?: AgentWithLatestMetrics[];
  message?: string;
}> => {
  const response = await api.get("/api/agents", {
    params: { includeLatestMetrics: true },
    signal,
  });
  return {
    success: response.data.success,
    agents: response.data.agents,
    message: response.data.message,
  };
};

export const getAgent = async (
  id: number,
  signal?: AbortSignal
): Promise<AgentResponse> => {
  const response = await api.get(`/api/agents/${id}`, { signal });
  return {
    success: true,
    agent: response.data.agent,
  };
};

export const deleteAgent = async (
  id: number
): Promise<{ success: boolean; message: string }> => {
  try {
    const response = await api.delete(`/api/agents/${id}`);
    return response.data;
  } catch (error) {
    console.error(`删除客户端 ${id} 失败:`, error);
    return {
      success: false,
      message: "删除客户端失败",
    };
  }
};

export const updateAgent = async (
  id: number,
  data: Partial<Agent>
): Promise<AgentResponse> => {
  try {
    const response = await api.put(`/api/agents/${id}`, data);
    return response.data;
  } catch (error) {
    console.error(`更新客户端 ${id} 失败:`, error);
    return {
      success: false,
    };
  }
};

// 手动排序：按数组顺序保存 sort_order
export const updateAgentsOrder = async (
  ids: number[]
): Promise<{ success: boolean; message?: string }> => {
  try {
    const response = await api.put("/api/agents/order", { ids });
    return response.data;
  } catch (error) {
    console.error("保存客户端排序失败:", error);
    return { success: false, message: "保存客户端排序失败" };
  }
};

// 导出客户端配置（JSON 数组，含 token）
export const exportAgents = async (): Promise<unknown[]> => {
  const response = await api.get("/api/agents/export");
  return response.data;
};

// 导入客户端配置，返回 {created, skipped}
export const importAgents = async (
  items: unknown[]
): Promise<{
  success: boolean;
  created?: number;
  skipped?: number;
  message?: string;
}> => {
  try {
    const response = await api.post("/api/agents/import", items);
    return response.data;
  } catch (error) {
    console.error("导入客户端失败:", error);
    return { success: false, message: "导入客户端失败" };
  }
};

export const getAgentMetrics = async (
  id: number,
  signal?: AbortSignal
): Promise<{
  success: boolean;
  agent?: MetricHistory[];
  message?: string;
}> => {
  try {
    const response = await api.get(`/api/agents/${id}/metrics`, { signal });
    return response.data;
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    console.error(`获取客户端 ${id} 的指标失败:`, error);
    return {
      success: false,
      message: "获取客户端指标失败",
    };
  }
};

export const getLatestAgentMetrics = async (
  id: number,
  signal?: AbortSignal
): Promise<{
  success: boolean;
  agent?: MetricHistory;
  message?: string;
}> => {
  const response = await api.get(`/api/agents/${id}/metrics/latest`, {
    signal,
  });
  return response.data;
};
