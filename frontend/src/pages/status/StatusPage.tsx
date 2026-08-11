import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Grid } from "@/components/ui/layout";
import { getPublicAgentMetrics, getStatusPageData } from "../../api/status";
import PageLoading from "../../components/PageLoading";
import AgentCard from "../../components/AgentCard";
import AgentViewsSection from "../../components/AgentViewsSection";
import MonitorCard from "../../components/MonitorCard";
import AgentStatusBar from "../../components/AgentStatusBar";
import { useTranslation } from "react-i18next";
import {
  PublicMonitor,
  MetricHistory,
  PublicMetricHistory,
  AgentWithLatestMetrics,
} from "../../types";
import type { StatusPageData } from "../../types/status";
import { useTheme } from "../../providers/ThemeProvider";
import LiveIndicator from "../../components/LiveIndicator";
import {
  createLiveSocket,
  type LiveAgentStatus,
} from "../../utils/liveSocket";

interface StatusLiveState {
  metric: Partial<MetricHistory>;
  status?: LiveAgentStatus;
  lastSeenAt?: string | null;
  ts: number;
}

const StatusPage = () => {
  const { t } = useTranslation();
  const { setThemeOverride } = useTheme();
  const queryClient = useQueryClient();
  const [selectedAgent, setSelectedAgent] =
    useState<AgentWithLatestMetrics | null>(null);
  const [selectedAgentMetrics, setSelectedAgentMetrics] = useState<
    PublicMetricHistory[] | null
  >(null);
  const [cardLoading, setCardLoading] = useState(false);
  const [liveState, setLiveState] = useState<Record<number, StatusLiveState>>({});
  const [liveConnected, setLiveConnected] = useState(false);
  const [liveLagSeconds, setLiveLagSeconds] = useState(0);
  const statusQuery = useQuery({
    queryKey: ["status", "public"],
    queryFn: ({ signal }) => getStatusPageData(signal),
    // Publication 是断线兜底；公开白名单指标由下方 WebSocket 实时叠加。
    refetchInterval: 60_000,
  });
  const baseAgents = useMemo(
    () =>
      statusQuery.data?.agents.map((agent: StatusPageData["agents"][number]) => ({
        ...agent,
        // 公开 API 只给城市级落点；共享地图组件沿用管理端 geo 字段名。
        geo_latitude: agent.map_latitude,
        geo_longitude: agent.map_longitude,
        geo_city: agent.city,
        geo_region_name: agent.region_name,
        metrics: agent.metrics
          ? {
              ...agent.metrics,
              id:
                agent.metrics.id === undefined
                  ? undefined
                  : Number(agent.metrics.id),
            }
          : null,
      })) ?? [],
    [statusQuery.data?.agents]
  );
  const agentSubscriptionKey = baseAgents.map((agent) => agent.id).join(",");

  useEffect(() => {
    setLiveConnected(false);
    if (!agentSubscriptionKey) return;
    const socket = createLiveSocket({
      subscribe: agentSubscriptionKey.split(",").map(Number),
      path: "/api/v2/status/public/ws",
      onUpdate: ({ agentId, ts, data, status, lastSeenAt, lagSeconds }) => {
        setLiveState((current) => {
          const previous = current[agentId];
          if (previous && previous.ts > ts) return current;
          return {
            ...current,
            [agentId]: {
              metric: { ...previous?.metric, ...data },
              status: status ?? previous?.status,
              lastSeenAt:
                lastSeenAt !== undefined ? lastSeenAt : previous?.lastSeenAt,
              ts,
            },
          };
        });
        setLiveLagSeconds(lagSeconds);
      },
      onStatusChange: ({ connected }) => setLiveConnected(connected),
    });
    return () => socket.close();
  }, [agentSubscriptionKey]);

  const liveMetrics = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(liveState).map(([agentId, state]) => [
          Number(agentId),
          state.metric,
        ])
      ) as Record<number, Partial<MetricHistory>>,
    [liveState]
  );
  const publicAgents = useMemo(
    () =>
      baseAgents.map((agent) => {
        const live = liveState[agent.id];
        return live
          ? { ...agent, status: live.status ?? agent.status }
          : agent;
      }),
    [baseAgents, liveState]
  );
  const data: { monitors: PublicMonitor[]; agents: AgentWithLatestMetrics[] } = {
    monitors: statusQuery.data?.monitors ?? [],
    agents: publicAgents,
  };
  const pageTitle = statusQuery.data?.title || t("statusPage.title");
  const pageDescription =
    statusQuery.data?.description || t("statusPage.allOperational");

  useEffect(() => {
    if (statusQuery.data) setThemeOverride(statusQuery.data.theme || "mono");
  }, [setThemeOverride, statusQuery.data]);

  // 离开状态页时恢复访客自己的主题
  useEffect(() => {
    return () => setThemeOverride(null);
  }, [setThemeOverride]);

  // 点击 agent 卡片时，获取完整指标
  const handleAgentClick = async (agent: AgentWithLatestMetrics) => {
    // 如果点击的是当前展开的 agent，则收起
    if (selectedAgent?.id === agent.id) {
      setSelectedAgent(null);
      setSelectedAgentMetrics(null);
      return;
    }

    setSelectedAgent(agent);
    setCardLoading(true);
    setSelectedAgentMetrics(null);
    try {
      const metricsRes = await queryClient.fetchQuery({
        queryKey: ["status", "public", "agent-metrics", agent.id],
        queryFn: ({ signal }) => getPublicAgentMetrics(agent.id, signal),
        staleTime: 60_000,
      });
      setSelectedAgentMetrics(metricsRes.success ? metricsRes.agent || [] : []);
    } catch {
      setSelectedAgentMetrics([]);
    } finally {
      setCardLoading(false);
    }
  };

  // 供多视图组件回调：按 id 找到 agent 后走原有展开/收起逻辑
  const handleAgentSelect = (agentId: number) => {
    const agent = data.agents.find((item) => item.id === agentId);
    if (agent) handleAgentClick(agent);
  };

  // 错误显示
  if (statusQuery.error) {
    return (
      <Box>
        <div className="page-container">
          <div className="empty-state">
            {statusQuery.error instanceof Error
              ? statusQuery.error.message
              : t("statusPage.fetchError")}
          </div>
        </div>
      </Box>
    );
  }

  if (statusQuery.isPending) {
    return (
      <Box>
        <div className="page-container">
          <PageLoading />
        </div>
      </Box>
    );
  }

  return (
    <Box>
      <div className="page-container sm:px-6 lg:px-[8%] px-4">
        {/* 状态页标题区域：终端窗口条（三色圆点 + $ 标题） */}
        <div className="terminal-card mt-6 mb-8">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-4 py-3">
            <span className="terminal-dot red" />
            <span className="terminal-dot yellow" />
            <span className="terminal-dot green" />
            <h1 className="prompt-title ml-2 truncate">{pageTitle}</h1>
          </div>
          <p className="whitespace-pre-wrap px-4 py-3 text-[var(--text-secondary)]">
            {pageDescription}
          </p>
        </div>

        {/* 客户端监控状态：与仪表盘同源的四视图切换。公开地图消费经过
            降精度的城市级落点，原始 IP 与原始坐标都不进入公开 DTO。 */}
        {data.agents.length > 0 && (
          <>
            <AgentViewsSection
              agents={data.agents as never}
              liveMetrics={liveMetrics}
              title={
                <>
                  {t("statusPage.agentStatus")}{" "}
                  <span className="group-count">[{data.agents.length}]</span>
                </>
              }
              titleExtra={
                <LiveIndicator
                  connected={liveConnected}
                  lagSeconds={liveLagSeconds}
                />
              }
              storageKey="status_agent_view"
              onSelectAgent={handleAgentSelect}
              renderBarItem={(agent, displayMetric) => (
                <div
                  className="cursor-pointer transition hover:scale-[1.01]"
                  onClick={() => handleAgentSelect(agent.id)}
                >
                  <AgentStatusBar
                    latestMetric={displayMetric as MetricHistory | undefined}
                    agent={agent as AgentWithLatestMetrics}
                  />
                </div>
              )}
            />
            {/* 点击任意视图中的客户端后，在分区下方展开详情 */}
            {selectedAgent && (
              <div className="-mt-2 mb-6">
                {cardLoading ? (
                  <PageLoading />
                ) : (
                  <AgentCard
                    agent={
                      {
                        ...selectedAgent,
                        metrics: selectedAgentMetrics || [],
                      } as never
                    }
                    liveMetric={liveMetrics[selectedAgent.id]}
                    // 公开页不展示 IP（后端投影已剥离，此处双保险）
                    showIpAddress={false}
                  />
                )}
              </div>
            )}
          </>
        )}

        {/* API服务状态 */}
        {data.monitors.length > 0 && (
          <section className="mb-6">
            <h2 className="group-title">
              {t("statusPage.apiServices")}{" "}
              <span className="group-count">[{data.monitors.length}]</span>
            </h2>
            <Grid columns={{ initial: "1" }} gap="4">
              {data.monitors.map((monitor) => (
                <MonitorCard monitor={monitor} key={monitor.id} />
              ))}
            </Grid>
          </section>
        )}

        {/* 空状态 */}
        {data.agents.length === 0 && data.monitors.length === 0 && (
          <div className="empty-state">{t("common.noData")}</div>
        )}
      </div>
    </Box>
  );
};

export default StatusPage;
