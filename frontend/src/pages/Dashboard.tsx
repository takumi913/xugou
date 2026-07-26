import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { LayoutGrid, CircleDashed, List, Globe } from "lucide-react";
import { Monitor } from "../types";
import type { MetricHistory } from "../types/agents";
import {
  getDashboardDataWithSignal,
  type DashboardAgent,
} from "../api/dashboard";
import { useTranslation } from "react-i18next";
import { usePolling } from "../hooks/usePolling";
import { createLiveSocket } from "../utils/liveSocket";
import AgentRingCard from "../components/AgentRingCard";
import LiveIndicator from "../components/LiveIndicator";
import PageLoading from "../components/PageLoading";
import StatBar, { ProgressBar } from "../components/StatBar";
import { formatBytes, formatSpeed } from "../utils/format";
import {
  memoryPercent,
  mergeLatestMetric,
  monthlyTraffic,
  parseDiskUsage,
} from "../utils/metrics";
import { regionFlagEmoji, regionLabel } from "../utils/region";
import {
  monitorStatusColors,
  agentStatusColors,
  statusAccentColor,
} from "../utils/statusColors";

// 地图视图体积较大（世界轮廓数据），懒加载单独分包
const WorldMapView = lazy(() => import("../components/WorldMapView"));

// Dashboard agent 区视图（bar 条形卡 / ring 环形卡 / table 表格 / map 地图），
// localStorage 记忆
type AgentView = "bar" | "ring" | "table" | "map";
const AGENT_VIEW_STORAGE_KEY = "dashboard_agent_view";

const readStoredAgentView = (): AgentView => {
  try {
    const stored = localStorage.getItem(AGENT_VIEW_STORAGE_KEY);
    return stored === "ring" || stored === "table" || stored === "map"
      ? stored
      : "bar";
  } catch {
    return "bar";
  }
};

// 表格视图用量格：细进度条 + 百分比（无数据显示 '-'）
const TableStat = ({ percent }: { percent?: number }) =>
  typeof percent === "number" && Number.isFinite(percent) ? (
    <div className="table-stat">
      <div className="table-stat-bar">
        <ProgressBar percent={percent} />
      </div>
      <span>{percent.toFixed(1)}%</span>
    </div>
  ) : (
    <span style={{ color: "var(--text-secondary)" }}>-</span>
  );

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
  // agent 区视图切换（localStorage 记忆）与地区筛选（会话内，不持久化）
  const [agentView, setAgentView] = useState<AgentView>(readStoredAgentView);
  const [regionFilter, setRegionFilter] = useState<string>("all");
  const { t } = useTranslation();
  const navigate = useNavigate();

  const switchAgentView = (view: AgentView) => {
    setAgentView(view);
    try {
      localStorage.setItem(AGENT_VIEW_STORAGE_KEY, view);
    } catch {
      // localStorage 不可用时仅内存切换
    }
  };

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

  // 地区筛选统计：合法两位国家码计数，其余归入 UNKNOWN；
  // 仅当存在 ≥1 个有 region 的 agent 时渲染筛选栏
  const regionCounts = new Map<string, number>();
  let unknownRegionCount = 0;
  for (const agent of agents) {
    const label = regionLabel(agent.region);
    if (label) {
      regionCounts.set(label, (regionCounts.get(label) ?? 0) + 1);
    } else {
      unknownRegionCount += 1;
    }
  }
  const showRegionFilter = regionCounts.size > 0;
  const sortedRegions = [...regionCounts.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );
  // 当前筛选值失效（agent 列表刷新后该地区消失）时按「全部」处理
  const effectiveRegionFilter =
    regionFilter === "all" ||
    (regionFilter === "unknown" && unknownRegionCount > 0) ||
    regionCounts.has(regionFilter)
      ? regionFilter
      : "all";
  const filteredAgents =
    !showRegionFilter || effectiveRegionFilter === "all"
      ? agents
      : effectiveRegionFilter === "unknown"
      ? agents.filter((agent) => !regionLabel(agent.region))
      : agents.filter(
          (agent) => regionLabel(agent.region) === effectiveRegionFilter
        );

  // 三视图共用的展示指标：REST 最新指标叠加 WS 实时样本（带时间戳仲裁）
  const displayMetricFor = (
    agent: DashboardAgent
  ): Partial<MetricHistory> | undefined => {
    const base = agent.metrics ?? undefined;
    const live = liveMetrics[agent.id];
    if (!live) return base;
    return mergeLatestMetric(base, live) ?? undefined;
  };

  // 按 group_name 分段：空组归入默认「客户端监控」段（排最前），
  // 有名分组按名称排序；全部为默认组时不渲染分段标题（保持原单段布局）
  const defaultGroupAgents = filteredAgents.filter(
    (agent) => !agent.group_name?.trim()
  );
  const namedGroups = new Map<string, DashboardAgent[]>();
  for (const agent of filteredAgents) {
    const groupName = agent.group_name?.trim();
    if (!groupName) continue;
    const list = namedGroups.get(groupName) ?? [];
    list.push(agent);
    namedGroups.set(groupName, list);
  }
  const agentGroups: Array<{ name: string | null; agents: DashboardAgent[] }> =
    [];
  if (defaultGroupAgents.length > 0) {
    agentGroups.push({ name: null, agents: defaultGroupAgents });
  }
  for (const [name, list] of [...namedGroups.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    agentGroups.push({ name, agents: list });
  }
  const showAgentGroupHeaders = namedGroups.size > 0;

  // 监控状态文本
  const monitorStatusText: { [key: string]: string } = {
    up: t("monitors.status.up"),
    down: t("monitors.status.down"),
    pending: t("monitor.status.pending"),
  };

  // 客户端状态文本
  const agentStatusText: { [key: string]: string } = {
    active: t("agent.status.online"),
    connecting: t("agent.status.connecting"),
    inactive: t("agent.status.offline"),
  };

  // 三视图渲染（每个分组段内复用；视图切换与地区筛选保持全局一份）
  const renderAgentsView = (list: DashboardAgent[]) =>
    agentView === "ring" ? (
      /* ring 视图：CPU/RAM/DISK 三环卡片 */
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((agent) => (
          <AgentRingCard
            key={agent.id}
            agent={agent}
            liveMetric={liveMetrics[agent.id]}
          />
        ))}
      </div>
    ) : agentView === "table" ? (
      /* table 视图：紧凑表格，行点击跳详情 */
      <div className="table-container">
        <table className="terminal-table">
          <thead>
            <tr>
              <th>{t("dashboard.table.name")}</th>
              <th>{t("dashboard.table.status")}</th>
              <th>{t("dashboard.table.cpu")}</th>
              <th>{t("dashboard.table.ram")}</th>
              <th>{t("dashboard.table.disk")}</th>
              <th>{t("dashboard.table.net")}</th>
              <th>{t("dashboard.table.traffic")}</th>
              <th>{t("dashboard.table.region")}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((agent) => {
              const color = statusAccentColor(
                agentStatusColors,
                agent.status || "unknown"
              );
              const metric = displayMetricFor(agent);
              const ram = memoryPercent(metric);
              const disk = parseDiskUsage(metric);
              const monthBytes = monthlyTraffic(
                metric,
                agent.traffic_calc_type
              );
              const flag = regionFlagEmoji(agent.region);
              const region = regionLabel(agent.region);
              return (
                <tr
                  key={agent.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/agents/${agent.id}`)}
                >
                  <td>
                    <span
                      className="font-semibold"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {agent.name}
                    </span>
                  </td>
                  <td>
                    <span
                      className="status-label"
                      style={{ color, borderColor: color }}
                    >
                      {agentStatusText[agent.status] ?? agent.status}
                    </span>
                  </td>
                  <td>
                    <TableStat percent={metric?.cpu_usage} />
                  </td>
                  <td>
                    <TableStat percent={ram} />
                  </td>
                  <td>
                    <TableStat percent={disk?.percent} />
                  </td>
                  <td className="whitespace-nowrap">
                    <span className="net-down">
                      ↓ {formatSpeed(metric?.network_rx_speed)}
                    </span>{" "}
                    <span className="net-up">
                      ↑ {formatSpeed(metric?.network_tx_speed)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap">
                    {monthBytes !== null ? formatBytes(monthBytes, 2) : "-"}
                  </td>
                  <td className="whitespace-nowrap">
                    {flag && region ? `${flag} ${region}` : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    ) : (
      /* bar 视图：现有条形卡（地区显示与实时指标条） */
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((agent) => {
          const color = statusAccentColor(
            agentStatusColors,
            agent.status || "unknown"
          );
          const live = liveMetrics[agent.id];
          const liveMemory = memoryPercent(live);
          const flag = regionFlagEmoji(agent.region);
          const region = regionLabel(agent.region);
          const tagItems = (agent.tags ?? "")
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
          return (
            <Link
              key={agent.id}
              to={`/agents/${agent.id}`}
              className="terminal-card block p-3 text-[13px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span style={{ color, flexShrink: 0 }}>●</span>
                  <span
                    className="truncate font-semibold"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {agent.name}
                  </span>
                  {flag && region && (
                    <span
                      className="shrink-0 text-xs"
                      style={{ color: "var(--text-secondary)" }}
                      title={region}
                    >
                      {flag} {region}
                    </span>
                  )}
                </span>
                <span
                  className="status-label"
                  style={{ color, borderColor: color }}
                >
                  {agentStatusText[agent.status] ?? agent.status}
                </span>
              </div>
              <div
                className="mt-1 flex items-center justify-between gap-2 text-xs"
                style={{ color: "var(--text-secondary)" }}
              >
                <span className="truncate">
                  {agent.hostname || agent.os || "-"}
                </span>
                {agent.version && (
                  <span className="shrink-0">{agent.version}</span>
                )}
              </div>
              {/* 标签徽章行（与环形卡一致的终端风格小徽章） */}
              {tagItems.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {tagItems.map((tag) => (
                    <span key={tag} className="tag-badge">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {/* 实时指标条：收到 WS 广播后展示并实时更新 */}
              {live &&
                (live.cpu_usage !== undefined ||
                  liveMemory !== undefined) && (
                  <div className="mt-2">
                    {live.cpu_usage !== undefined &&
                      live.cpu_usage !== null && (
                        <StatBar label="CPU" percent={live.cpu_usage} />
                      )}
                    {liveMemory !== undefined && (
                      <StatBar label="RAM" percent={liveMemory} />
                    )}
                  </div>
                )}
            </Link>
          );
        })}
      </div>
    );

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

      {/* Agent 分组：标题行右侧为 bar/ring/table 视图切换按钮组 */}
      <section className="mb-6">
        <div className="group-title-row">
          <h2 className="group-title">
            {t("navbar.agentMonitors")}{" "}
            <span className="group-count">[{agents.length}]</span>
          </h2>
          <div className="view-toggle">
            <button
              type="button"
              className={`view-toggle-btn${agentView === "bar" ? " active" : ""}`}
              onClick={() => switchAgentView("bar")}
              title={t("dashboard.view.bar")}
            >
              <LayoutGrid size={13} aria-hidden />
              <span className="view-toggle-text">{t("dashboard.view.bar")}</span>
            </button>
            <button
              type="button"
              className={`view-toggle-btn${agentView === "ring" ? " active" : ""}`}
              onClick={() => switchAgentView("ring")}
              title={t("dashboard.view.ring")}
            >
              <CircleDashed size={13} aria-hidden />
              <span className="view-toggle-text">{t("dashboard.view.ring")}</span>
            </button>
            <button
              type="button"
              className={`view-toggle-btn${agentView === "table" ? " active" : ""}`}
              onClick={() => switchAgentView("table")}
              title={t("dashboard.view.table")}
            >
              <List size={13} aria-hidden />
              <span className="view-toggle-text">
                {t("dashboard.view.table")}
              </span>
            </button>
            <button
              type="button"
              className={`view-toggle-btn${agentView === "map" ? " active" : ""}`}
              onClick={() => switchAgentView("map")}
              title={t("dashboard.view.map")}
            >
              <Globe size={13} aria-hidden />
              <span className="view-toggle-text">{t("dashboard.view.map")}</span>
            </button>
          </div>
        </div>

        {/* 地区筛选栏（参照 CF-SM filter-bar；会话内状态，不持久化） */}
        {showRegionFilter && (
          <div className="filter-bar">
            <button
              type="button"
              className={`filter-tag${
                effectiveRegionFilter === "all" ? " active" : ""
              }`}
              onClick={() => setRegionFilter("all")}
            >
              [{t("dashboard.region.all")}] {agents.length}
            </button>
            {sortedRegions.map(([code, count]) => (
              <button
                key={code}
                type="button"
                className={`filter-tag${
                  effectiveRegionFilter === code ? " active" : ""
                }`}
                onClick={() => setRegionFilter(code)}
              >
                [{regionFlagEmoji(code)} {code}] {count}
              </button>
            ))}
            {unknownRegionCount > 0 && (
              <button
                type="button"
                className={`filter-tag filter-tag-unknown${
                  effectiveRegionFilter === "unknown" ? " active" : ""
                }`}
                onClick={() => setRegionFilter("unknown")}
              >
                [{t("dashboard.region.unknown")}] {unknownRegionCount}
              </button>
            )}
          </div>
        )}

        {filteredAgents.length === 0 ? (
          <div className="empty-state">{t("common.noData")}</div>
        ) : agentView === "map" ? (
          /* 地图视图：单一整幅地图置于分组之外，消费地区筛选后的完整列表；
             点击多机聚合点联动上方地区筛选栏 */
          <Suspense fallback={<PageLoading />}>
            <WorldMapView
              agents={filteredAgents}
              liveMetrics={liveMetrics}
              onSelectRegion={(code) => setRegionFilter(code)}
            />
          </Suspense>
        ) : showAgentGroupHeaders ? (
          /* 分组段：默认「客户端监控」段排最前，三视图与地区筛选在每段内生效 */
          agentGroups.map((group) => (
            <div key={group.name ?? "__default__"} className="mb-4">
              <h3 className="group-title">
                {group.name ?? t("navbar.agentMonitors")}{" "}
                <span className="group-count">[{group.agents.length}]</span>
              </h3>
              {renderAgentsView(group.agents)}
            </div>
          ))
        ) : (
          renderAgentsView(filteredAgents)
        )}
      </section>
    </div>
  );
};

export default Dashboard;
