import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  getDashboardDataWithSignal,
  type DashboardAgent,
  type DashboardMonitor,
} from "../api/dashboard";
import { useTranslation } from "react-i18next";
import AgentViewsSection from "../components/AgentViewsSection";
import LiveIndicator from "../components/LiveIndicator";
import PageLoading from "../components/PageLoading";
import { formatBytes, formatSpeed } from "../utils/format";
import { mergeLatestMetric, monthlyTraffic } from "../utils/metrics";
import { useLiveAgentMetrics } from "../hooks/useLiveAgentMetrics";
import {
  monitorStatusColors,
  statusAccentColor,
} from "../utils/statusColors";

const EMPTY_DASHBOARD_AGENTS: DashboardAgent[] = [];

const Dashboard = () => {
  const { t } = useTranslation();
  const dashboardQuery = useQuery({
    queryKey: ["dashboard"],
    queryFn: ({ signal }) => getDashboardDataWithSignal(signal),
    // D1 是查询事实与断线兜底；实时样本由下方分片 WebSocket 叠加。
    refetchInterval: 60_000,
  });
  const monitors: DashboardMonitor[] = dashboardQuery.data?.monitors ?? [];
  const baseAgents: DashboardAgent[] =
    dashboardQuery.data?.agents ?? EMPTY_DASHBOARD_AGENTS;
  const baseSummary = dashboardQuery.data?.summary;
  const monitorsHasMore = dashboardQuery.data?.monitors_has_more ?? false;
  const agentsHasMore = dashboardQuery.data?.agents_has_more ?? false;
  const agentIds = useMemo(() => baseAgents.map((agent) => agent.id), [baseAgents]);
  const {
    liveMetrics,
    liveStatus,
    connected: liveConnected,
    lagSeconds: liveLagSeconds,
  } = useLiveAgentMetrics(agentIds);

  const agents = useMemo(
    () =>
      baseAgents.map((agent) => {
        const live = liveStatus[agent.id];
        return live
          ? {
              ...agent,
              status: live.status ?? agent.status,
              last_seen_at:
                live.lastSeenAt !== undefined
                  ? live.lastSeenAt
                  : agent.last_seen_at,
            }
          : agent;
      }),
    [baseAgents, liveStatus]
  );

  const summary = useMemo(() => {
    if (!baseSummary) return undefined;
    let onlineDelta = 0;
    for (let index = 0; index < baseAgents.length; index += 1) {
      const wasOnline = baseAgents[index].status === "active";
      const isOnline = agents[index]?.status === "active";
      if (wasOnline !== isOnline) onlineDelta += isOnline ? 1 : -1;
    }
    const next = {
      ...baseSummary,
      agents_online: Math.max(0, baseSummary.agents_online + onlineDelta),
      agents_offline: Math.max(0, baseSummary.agents_offline - onlineDelta),
    };

    // 投影未截断时，用各 Agent 最新样本重算总流量与网速；截断时保留 D1 全局值。
    if (!agentsHasMore) {
      let totalTraffic = 0;
      let rxSpeed = 0;
      let txSpeed = 0;
      let hasTraffic = false;
      let hasRxSpeed = false;
      let hasTxSpeed = false;
      agents.forEach((agent) => {
        if (agent.status !== "active") return;
        const live = liveMetrics[agent.id];
        const metric = live
          ? mergeLatestMetric(agent.metrics ?? undefined, live)
          : agent.metrics;
        const traffic = monthlyTraffic(metric, agent.traffic_calc_type);
        if (traffic !== null) {
          totalTraffic += traffic;
          hasTraffic = true;
        }
        if (typeof metric?.network_rx_speed === "number") {
          rxSpeed += metric.network_rx_speed;
          hasRxSpeed = true;
        }
        if (typeof metric?.network_tx_speed === "number") {
          txSpeed += metric.network_tx_speed;
          hasTxSpeed = true;
        }
      });
      next.total_traffic_bytes = hasTraffic ? totalTraffic : null;
      next.network_rx_speed_bps = hasRxSpeed ? rxSpeed : null;
      next.network_tx_speed_bps = hasTxSpeed ? txSpeed : null;
    }
    return next;
  }, [agents, agentsHasMore, baseAgents, baseSummary, liveMetrics]);

  // 加载中显示
  if (dashboardQuery.isPending) {
    return (
      <div className="page-container">
        <PageLoading />
      </div>
    );
  }

  // 监控状态文本
  const monitorStatusText: { [key: string]: string } = {
    up: t("monitors.status.up"),
    down: t("monitors.status.down"),
    pending: t("monitor.status.pending"),
  };

  return (
    <div className="page-container">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="prompt-title">{t("dashboard.title")}</h1>
      </div>

      {/* 全局统计条 */}
      <div className="global-stats">
        <div className="stat-item">
          <div className="stat-label">{t("dashboard.totalMonitors")}</div>
          <div className="stat-main-value">{summary?.monitors_total ?? 0}</div>
          <div className="stat-sub-info">
            <span className="stat-online-color">
              {t("monitors.status.up")}:{summary?.monitors_up ?? 0}
            </span>{" "}
            |{" "}
            <span className="stat-offline-color">
              {t("monitors.status.down")}:{summary?.monitors_down ?? 0}
            </span>
          </div>
        </div>
        <div className="stat-item">
          <div className="stat-label">{t("dashboard.totalAgents")}</div>
          <div className="stat-main-value">{summary?.agents_total ?? 0}</div>
          <div className="stat-sub-info">
            <span className="stat-online-color">
              {t("agent.status.online")}:{summary?.agents_online ?? 0}
            </span>{" "}
            |{" "}
            <span className="stat-offline-color">
              {t("agent.status.offline")}:{summary?.agents_offline ?? 0}
            </span>
          </div>
        </div>
        <div className="stat-item">
          <div className="stat-label">
            {t("monitor.history.avgResponseTime")}
          </div>
          <div className="stat-main-value">
            {summary?.monitors_avg_response_time_ms !== null &&
            summary?.monitors_avg_response_time_ms !== undefined
              ? `${summary.monitors_avg_response_time_ms} ms`
              : "-"}
          </div>
        </div>
        <div className="stat-item">
          <div className="stat-label">{t("dashboard.totalTraffic")}</div>
          <div className="stat-main-value">
            {summary?.total_traffic_bytes !== null &&
            summary?.total_traffic_bytes !== undefined
              ? formatBytes(summary.total_traffic_bytes, 2)
              : "-"}
          </div>
        </div>
        <div className="stat-item">
          <div className="stat-label">{t("dashboard.networkSpeed")}</div>
          <div className="stat-main-value">
            <span className="net-down">
              ↓ {formatSpeed(summary?.network_rx_speed_bps ?? null)}
            </span>{" "}
            <span className="net-up">
              ↑ {formatSpeed(summary?.network_tx_speed_bps ?? null)}
            </span>
          </div>
        </div>
      </div>

      {/* 监控分组 */}
      <section className="mb-6">
        <h2 className="group-title">
          {t("navbar.apiMonitors")}{" "}
          <span className="group-count">
            [{monitors.length}/{summary?.monitors_total ?? monitors.length}]
          </span>
        </h2>
        {monitorsHasMore ? (
          <p className="mb-3 text-xs text-muted-foreground">
            {t("dashboard.previewTruncated", {
              shown: monitors.length,
              total: summary?.monitors_total ?? monitors.length,
            })}{" "}
            <Link className="underline" to="/monitors">
              {t("dashboard.viewAll")}
            </Link>
          </p>
        ) : null}
        {monitors.length === 0 ? (
          <div className="empty-state">{t("common.noData")}</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {monitors.map((monitor) => {
              const color = statusAccentColor(
                monitorStatusColors,
                monitor.status || "pending"
              );
              return (
                <Link
                  key={monitor.id}
                  to={`/monitors/${monitor.id}`}
                  className="terminal-card block p-3 text-[13px]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span style={{ color, flexShrink: 0 }}>●</span>
                      <span
                        className="truncate font-semibold"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {monitor.name}
                      </span>
                    </span>
                    <span
                      className="status-label"
                      style={{ color, borderColor: color }}
                    >
                      {monitorStatusText[monitor.status] ?? monitor.status}
                    </span>
                  </div>
                  <div
                    className="mt-1 flex items-center justify-between gap-2 text-xs"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    <span className="truncate">{monitor.url}</span>
                    <span className="shrink-0">
                      {monitor.response_time
                        ? `${monitor.response_time}ms`
                        : "-"}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Agent 分组：视图切换/地区筛选/分组渲染统一在共享组件内 */}
      <AgentViewsSection
        agents={agents}
        liveMetrics={liveMetrics}
        title={
          <>
            {t("navbar.agentMonitors")}{" "}
            <span className="group-count">
              [{agents.length}/{summary?.agents_total ?? agents.length}]
            </span>
          </>
        }
        titleExtra={
          baseAgents.length > 0 ? (
            <LiveIndicator
              connected={liveConnected}
              lagSeconds={liveLagSeconds}
            />
          ) : undefined
        }
        storageKey="dashboard_agent_view"
      />
      {agentsHasMore ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("dashboard.previewTruncated", {
            shown: agents.length,
            total: summary?.agents_total ?? agents.length,
          })}{" "}
          <Link className="underline" to="/agents">
            {t("dashboard.viewAll")}
          </Link>
        </p>
      ) : null}
    </div>
  );
};

export default Dashboard;
