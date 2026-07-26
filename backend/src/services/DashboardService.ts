import { Monitor } from "../models";
import type { Agent } from "../models/agent";
import * as repositories from "../repositories";

export async function getDashboardData(userId: number) {
  const monitors = await repositories.getAllMonitors(userId);
  const agents = (await repositories.getAllAgents(userId)) as Agent[];

  if (monitors && monitors.length > 0) {
    monitors.forEach((monitor: Monitor) => {
      if (typeof monitor.headers === "string") {
        try {
          monitor.headers = JSON.parse(monitor.headers);
        } catch (e) {
          monitor.headers = {};
        }
      }
    });
  }

  // C1：附带每个 agent 的最新指标（含 month_rx/month_tx 与实时网速），
  // 供仪表盘「总流量 / 实时网速」统计格聚合；同时剥离 token 不下发
  const agentIds = (agents || []).map((agent) => agent.id);
  const latestMetrics = await repositories.getLatestAgentMetricsByIds(agentIds);
  const latestByAgentId = new Map(
    latestMetrics.map((metric) => [metric.agent_id, metric])
  );

  return {
    monitors: monitors,
    agents: (agents || []).map(({ token, ...agent }) => ({
      ...agent,
      metrics: latestByAgentId.get(agent.id) ?? null,
    })),
  };
}
