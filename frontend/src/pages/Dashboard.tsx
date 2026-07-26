import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Monitor } from "../types";
import type { MetricHistory } from "../types/agents";
import {
  getDashboardDataWithSignal,
  type DashboardAgent,
} from "../api/dashboard";
import { useTranslation } from "react-i18next";
import { usePolling } from "../hooks/usePolling";
import { createLiveSocket } from "../utils/liveSocket";
import AgentViewsSection from "../components/AgentViewsSection";
import LiveIndicator from "../components/LiveIndicator";
import PageLoading from "../components/PageLoading";
import { formatBytes, formatSpeed } from "../utils/format";
import { mergeLatestMetric, monthlyTraffic } from "../utils/metrics";
import {
  monitorStatusColors,
  statusAccentColor,
} from "../utils/statusColors";

const Dashboard = () => {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [agents, setAgents] = useState<DashboardAgent[]>([]);
  // 仅首次加载显示整页加载态，后续轮询静默刷新
  const [loading, setLoading] = useState(true);
  const initialLoadDone = useRef(false);
  const [liveMetrics, setLiveMetrics] = useState<
    Record<number, Partial<MetricHistory>>
  >({});
  const [liveConnected, setLiveConnected] = useState(false);
  // 最近一次 WS 样本的回放滞后（秒），>2s 时 LiveIndicator 显示 (+Ns)
  const [liveLagSeconds, setLiveLagSeconds] = useState(0);
  const { t } = useTranslation();

  // WebSocket 实时链路：订阅全部 agent，收到更新时按时间戳仲裁合并对应指标
  useEffect(() => {
    const socket = createLiveSocket({
      subscribe: "all",
      onUpdate: ({ agentId, ts, data, lagSeconds }) => {
        const sample: Partial<MetricHistory> = {
          ...data,
          timestamp: data.timestamp ?? new Date(ts).toISOString(),
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
  }, []);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    if (!initialLoadDone.current) {
      setLoading(true);
    }
    try {
      const dashboardResponse = await getDashboardDataWithSignal(signal);
      if (signal?.aborted) return;

      if (dashboardResponse) {
        setMonitors(dashboardResponse.monitors || []);
        setAgents(dashboardResponse.agents || []);
      }
    } finally {
      if (!signal?.aborted) {
        initialLoadDone.current = true;
        setLoading(false);
      }
    }
  }, []);

  // WS 连接正常时拉长轮询间隔，仅作兜底；断开时恢复常规轮询
  usePolling(fetchData, {
    intervalMs: liveConnected ? 600000 : 180000,
  });

  // 加载中显示
  if (loading) {
    return (
      <div className="page-container">
        <PageLoading />
      </div>
    );
  }

  // 全局统计数据
  const monitorsUp = monitors.filter((m) => m.status === "up").length;
  const monitorsDown = monitors.filter((m) => m.status === "down").length;
  const agentsOnline = agents.filter((a) => a.status === "active").length;
  const agentsOffline = agents.length - agentsOnline;
  const upResponseTimes = monitors.filter(
    (m) => m.status === "up" && typeof m.response_time === "number"
  );
  const avgResponseTime =
    upResponseTimes.length > 0
      ? Math.round(
          upResponseTimes.reduce((sum, m) => sum + (m.response_time || 0), 0) /
            upResponseTimes.length
        )
      : null;

  // 总流量：Σ 在线 agent 当月流量（按各自计费方式；口径为 REST 最新指标，
  // WS 样本不做月流量实时累计）；实时网速：Σ 当前速率（WS 实时样本优先）
  let totalTrafficBytes: number | null = null;
  let totalRxSpeed: number | null = null;
  let totalTxSpeed: number | null = null;
  for (const agent of agents) {
    if (agent.status !== "active") continue;
    const live = liveMetrics[agent.id];
    const monthBytes = monthlyTraffic(agent.metrics, agent.traffic_calc_type);
    if (monthBytes !== null) {
      totalTrafficBytes = (totalTrafficBytes ?? 0) + monthBytes;
    }
    const rxSpeed =
      typeof live?.network_rx_speed === "number"
        ? live.network_rx_speed
        : agent.metrics?.network_rx_speed;
    const txSpeed =
      typeof live?.network_tx_speed === "number"
        ? live.network_tx_speed
        : agent.metrics?.network_tx_speed;
    if (typeof rxSpeed === "number") {
      totalRxSpeed = (totalRxSpeed ?? 0) + rxSpeed;
    }
    if (typeof txSpeed === "number") {
      totalTxSpeed = (totalTxSpeed ?? 0) + txSpeed;
    }
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
        <LiveIndicator connected={liveConnected} lagSeconds={liveLagSeconds} />
      </div>

      {/* 全局统计条 */}
      <div className="global-stats">
        <div className="stat-item">
          <div className="stat-label">{t("dashboard.totalMonitors")}</div>
          <div className="stat-main-value">{monitors.length}</div>
          <div className="stat-sub-info">
            <span className="stat-online-color">
              {t("monitors.status.up")}:{monitorsUp}
            </span>{" "}
            |{" "}
            <span className="stat-offline-color">
              {t("monitors.status.down")}:{monitorsDown}
            </span>
          </div>
        </div>
        <div className="stat-item">
          <div className="stat-label">{t("dashboard.totalAgents")}</div>
          <div className="stat-main-value">{agents.length}</div>
          <div className="stat-sub-info">
            <span className="stat-online-color">
              {t("agent.status.online")}:{agentsOnline}
            </span>{" "}
            |{" "}
            <span className="stat-offline-color">
              {t("agent.status.offline")}:{agentsOffline}
            </span>
          </div>
        </div>
        <div className="stat-item">
          <div className="stat-label">
            {t("monitor.history.avgResponseTime")}
          </div>
          <div className="stat-main-value">
            {avgResponseTime !== null ? `${avgResponseTime} ms` : "-"}
          </div>
        </div>
        <div className="stat-item">
          <div className="stat-label">{t("dashboard.totalTraffic")}</div>
          <div className="stat-main-value">
            {totalTrafficBytes !== null
              ? formatBytes(totalTrafficBytes, 2)
              : "-"}
          </div>
        </div>
        <div className="stat-item">
          <div className="stat-label">{t("dashboard.networkSpeed")}</div>
          <div className="stat-main-value">
            <span className="net-down">↓ {formatSpeed(totalRxSpeed)}</span>{" "}
            <span className="net-up">↑ {formatSpeed(totalTxSpeed)}</span>
          </div>
        </div>
      </div>

      {/* 监控分组 */}
      <section className="mb-6">
        <h2 className="group-title">
          {t("navbar.apiMonitors")}{" "}
          <span className="group-count">[{monitors.length}]</span>
        </h2>
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
            <span className="group-count">[{agents.length}]</span>
          </>
        }
        storageKey="dashboard_agent_view"
      />
    </div>
  );
};

export default Dashboard;
