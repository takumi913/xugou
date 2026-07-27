import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Grid } from "@/components/ui/theme-shim";
import { getPublicAgentMetrics, getStatusPageData } from "../../api/status";
import PageLoading from "../../components/PageLoading";
import AgentCard from "../../components/AgentCard";
import AgentViewsSection from "../../components/AgentViewsSection";
import LiveIndicator from "../../components/LiveIndicator";
import MonitorCard from "../../components/MonitorCard";
import AgentStatusBar from "../../components/AgentStatusBar";
import { useTranslation } from "react-i18next";
import {
  MonitorWithDailyStatsAndStatusHistory,
  MetricHistory,
  AgentWithLatestMetrics,
} from "../../types";
import { useParams } from "react-router-dom";
import { usePolling } from "../../hooks/usePolling";
import { useTheme } from "../../providers/ThemeProvider";
import { createLiveSocket } from "../../utils/liveSocket";
import { mergeLatestMetric } from "../../utils/metrics";

const StatusPage = () => {
  const { t } = useTranslation();
  const { userId } = useParams<{ userId: string }>();
  const { setThemeOverride } = useTheme();
  const [data, setData] = useState<{
    monitors: MonitorWithDailyStatsAndStatusHistory[];
    agents: AgentWithLatestMetrics[];
  }>({
    monitors: [],
    agents: [],
  });
  // 仅首次加载显示整页加载态，后续轮询静默刷新
  const [loading, setLoading] = useState(true);
  const initialLoadDone = useRef(false);
  const [pageTitle, setPageTitle] = useState<string>(t("statusPage.title"));
  const [pageDescription, setPageDescription] = useState<string>(
    t("statusPage.allOperational")
  );
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] =
    useState<AgentWithLatestMetrics | null>(null);
  const [selectedAgentMetrics, setSelectedAgentMetrics] = useState<
    MetricHistory[] | null
  >(null);
  const [cardLoading, setCardLoading] = useState(false);
  // WS 实时样本（公开模式）：agentId -> 最新指标（带时间戳仲裁合并）
  const [liveMetrics, setLiveMetrics] = useState<
    Record<number, Partial<MetricHistory>>
  >({});
  const [liveConnected, setLiveConnected] = useState(false);
  const [liveLagSeconds, setLiveLagSeconds] = useState(0);

  // 获取数据
  const fetchData = useCallback(async (signal?: AbortSignal) => {
    if (!userId) return;
    if (!initialLoadDone.current) {
      setLoading(true);
    }
    try {
      const response = await getStatusPageData(parseInt(userId, 10), signal);
      if (signal?.aborted) return;

      if (response) {
        setPageTitle(response.title || t("statusPage.title"));
        setPageDescription(
          response.description || t("statusPage.allOperational")
        );
        setData({
          monitors: response.monitors || [],
          agents: response.agents || [],
        });
        // 公开状态页按站长所选主题渲染（未知 id 由 provider 回退默认主题；
        // 访客自己的明暗偏好仍然生效）
        setThemeOverride(response.theme || "mono");
      } else {
        setError(t("statusPage.fetchError"));
      }
    } catch (error) {
      if (!signal?.aborted) {
        setError(
          error instanceof Error ? error.message : t("statusPage.fetchError")
        );
      }
    } finally {
      if (!signal?.aborted) {
        initialLoadDone.current = true;
        setLoading(false);
      }
    }
  }, [t, userId, setThemeOverride]);

  // 离开状态页时恢复访客自己的主题
  useEffect(() => {
    return () => setThemeOverride(null);
  }, [setThemeOverride]);

  // WS 连接正常时拉长轮询间隔，仅作兜底；断开时恢复常规轮询（与 Dashboard 一致）
  usePolling(fetchData, {
    enabled: Boolean(userId),
    intervalMs: liveConnected ? 600000 : 180000,
  });

  // 公开 WebSocket 实时链路：以 ?public=<userId> 匿名订阅当前展示的 agent，
  // 服务端把可接收范围限定为该状态页勾选且未隐藏的客户端；
  // agent 集合变化（轮询刷新后增减）时重建连接
  const liveAgentIdsKey = data.agents
    .map((agent) => agent.id)
    .sort((a, b) => a - b)
    .join(",");
  useEffect(() => {
    if (!userId || !liveAgentIdsKey) return;
    const socket = createLiveSocket({
      subscribe: liveAgentIdsKey.split(",").map(Number),
      publicUserId: parseInt(userId, 10),
      onUpdate: ({ agentId, ts, data: sampleData, lagSeconds }) => {
        const sample: Partial<MetricHistory> = {
          ...sampleData,
          timestamp: sampleData.timestamp ?? new Date(ts).toISOString(),
        };
        setLiveMetrics((prev) => ({
          ...prev,
          [agentId]: mergeLatestMetric(prev[agentId], sample),
        }));
        setLiveLagSeconds(lagSeconds);
      },
      onStatusChange: ({ connected }) => setLiveConnected(connected),
    });
    return () => socket.close();
  }, [userId, liveAgentIdsKey]);

  // REST 最新指标叠加 WS 实时样本（带时间戳仲裁）
  const displayMetricFor = (
    agent: AgentWithLatestMetrics
  ): MetricHistory | undefined => {
    const live = liveMetrics[agent.id];
    if (!live) return agent.metrics;
    return mergeLatestMetric(agent.metrics, live) as MetricHistory | undefined;
  };

  // 点击 agent 卡片时，获取完整指标
  const handleAgentClick = async (agent: AgentWithLatestMetrics) => {
    if (!userId) return;

    // 如果点击的是当前展开的 agent，则收起
    if (selectedAgent?.id === agent.id) {
      setSelectedAgent(null);
      setSelectedAgentMetrics(null);
      return;
    }

    setSelectedAgent(agent);
    setCardLoading(true);
    setSelectedAgentMetrics(null);
    const metricsRes = await getPublicAgentMetrics(parseInt(userId, 10), agent.id);
    setSelectedAgentMetrics(metricsRes.success ? metricsRes.agent || [] : []);
    setCardLoading(false);
  };

  // 供多视图组件回调：按 id 找到 agent 后走原有展开/收起逻辑
  const handleAgentSelect = (agentId: number) => {
    const agent = data.agents.find((item) => item.id === agentId);
    if (agent) handleAgentClick(agent);
  };

  // 错误显示
  if (error) {
    return (
      <Box>
        <div className="page-container">
          <div className="empty-state">{error}</div>
        </div>
      </Box>
    );
  }

  if (loading) {
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

        {/* 客户端监控状态：与仪表盘同源的四视图切换（bar 视图沿用信息更全的
            AgentStatusBar；公开数据无精确坐标，地图自动降级国家质心点） */}
        {data.agents.length > 0 && (
          <>
            <AgentViewsSection
              agents={data.agents}
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
                    agent={{
                      ...selectedAgent,
                      metrics: selectedAgentMetrics || [],
                    }}
                    liveMetric={displayMetricFor(selectedAgent)}
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
