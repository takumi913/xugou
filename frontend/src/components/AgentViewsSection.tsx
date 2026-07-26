import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LayoutGrid, CircleDashed, List, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MetricHistory } from "../types/agents";
import type { DashboardAgent } from "../api/dashboard";
import AgentRingCard from "./AgentRingCard";
import PageLoading from "./PageLoading";
import StatBar, { ProgressBar } from "./StatBar";
import { formatBytes, formatSpeed } from "../utils/format";
import {
  memoryPercent,
  mergeLatestMetric,
  monthlyTraffic,
  parseDiskUsage,
} from "../utils/metrics";
import { regionFlagEmoji, regionLabel } from "../utils/region";
import { agentStatusColors, statusAccentColor } from "../utils/statusColors";

// 地图视图体积较大（世界轮廓数据），懒加载单独分包
const WorldMapView = lazy(() => import("./WorldMapView"));

// agent 区视图（bar 条形卡 / ring 环形卡 / table 表格 / map 地图）
export type AgentView = "bar" | "ring" | "table" | "map";

const readStoredAgentView = (storageKey: string): AgentView => {
  try {
    const stored = localStorage.getItem(storageKey);
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

export interface AgentViewsSectionProps {
  agents: DashboardAgent[];
  /** WS 实时样本：agentId -> 最新指标 */
  liveMetrics: Record<number, Partial<MetricHistory>>;
  /** 分区标题（h2 内容） */
  title: ReactNode;
  /** 标题行右侧、视图切换按钮组之前的附加内容（如 LiveIndicator） */
  titleExtra?: ReactNode;
  /** 视图选择的 localStorage key（仪表盘与状态页各自记忆） */
  storageKey: string;
  /**
   * 点击 agent 的行为：提供时所有视图的点击走此回调（公开状态页展开详情），
   * 缺省时跳转 /agents/:id（仪表盘管理端）
   */
  onSelectAgent?: (agentId: number) => void;
  /** bar 视图单项渲染覆盖（状态页用信息更全的 AgentStatusBar） */
  renderBarItem?: (
    agent: DashboardAgent,
    displayMetric: Partial<MetricHistory> | undefined
  ) => ReactNode;
}

/**
 * 客户端多视图分区（从 Dashboard 抽取，供仪表盘与公开状态页共用）：
 * 标题行 + bar/ring/table/map 视图切换 + 地区筛选栏 + group_name 分组段。
 * 公开状态页数据无 geo 坐标时地图自动降级为国家质心点（WorldMapView 内建）。
 */
const AgentViewsSection = ({
  agents,
  liveMetrics,
  title,
  titleExtra,
  storageKey,
  onSelectAgent,
  renderBarItem,
}: AgentViewsSectionProps) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [view, setView] = useState<AgentView>(() =>
    readStoredAgentView(storageKey)
  );
  // 地区筛选（会话内，不持久化）
  const [regionFilter, setRegionFilter] = useState<string>("all");

  const switchView = (next: AgentView) => {
    setView(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // localStorage 不可用时仅内存切换
    }
  };

  const selectAgent = (agentId: number) => {
    if (onSelectAgent) {
      onSelectAgent(agentId);
    } else {
      navigate(`/agents/${agentId}`);
    }
  };

  // 客户端状态文本
  const agentStatusText: { [key: string]: string } = {
    active: t("agent.status.online"),
    connecting: t("agent.status.connecting"),
    inactive: t("agent.status.offline"),
  };

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

  // 各视图共用的展示指标：REST 最新指标叠加 WS 实时样本（带时间戳仲裁）
  const displayMetricFor = (
    agent: DashboardAgent
  ): Partial<MetricHistory> | undefined => {
    const base = agent.metrics ?? undefined;
    const live = liveMetrics[agent.id];
    if (!live) return base;
    return mergeLatestMetric(base, live) ?? undefined;
  };

  // 按 group_name 分段：空组归入默认「客户端监控」段（排最前），
  // 有名分组按名称排序；全部为默认组时不渲染分段标题（保持单段布局）
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

  // bar 视图默认单项：紧凑条形卡（地区显示与实时指标条）
  const defaultBarItem = (agent: DashboardAgent) => {
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
    const body = (
      <>
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
          <span className="status-label" style={{ color, borderColor: color }}>
            {agentStatusText[agent.status] ?? agent.status}
          </span>
        </div>
        <div
          className="mt-1 flex items-center justify-between gap-2 text-xs"
          style={{ color: "var(--text-secondary)" }}
        >
          <span className="truncate">{agent.hostname || agent.os || "-"}</span>
          {agent.version && <span className="shrink-0">{agent.version}</span>}
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
        {live && (live.cpu_usage !== undefined || liveMemory !== undefined) && (
          <div className="mt-2">
            {live.cpu_usage !== undefined && live.cpu_usage !== null && (
              <StatBar label="CPU" percent={live.cpu_usage} />
            )}
            {liveMemory !== undefined && (
              <StatBar label="RAM" percent={liveMemory} />
            )}
          </div>
        )}
      </>
    );
    return onSelectAgent ? (
      <div
        role="button"
        tabIndex={0}
        className="terminal-card block cursor-pointer p-3 text-[13px]"
        onClick={() => onSelectAgent(agent.id)}
        onKeyDown={(e) => e.key === "Enter" && onSelectAgent(agent.id)}
      >
        {body}
      </div>
    ) : (
      <Link
        to={`/agents/${agent.id}`}
        className="terminal-card block p-3 text-[13px]"
      >
        {body}
      </Link>
    );
  };

  // 三视图渲染（每个分组段内复用；视图切换与地区筛选保持全局一份）
  const renderAgentsView = (list: DashboardAgent[]) =>
    view === "ring" ? (
      /* ring 视图：CPU/RAM/DISK 三环卡片 */
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((agent) => (
          <AgentRingCard
            key={agent.id}
            agent={agent}
            liveMetric={liveMetrics[agent.id]}
            onSelect={
              onSelectAgent ? () => onSelectAgent(agent.id) : undefined
            }
          />
        ))}
      </div>
    ) : view === "table" ? (
      /* table 视图：紧凑表格，行点击跳详情/展开 */
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
              const monthBytes = monthlyTraffic(metric, agent.traffic_calc_type);
              const flag = regionFlagEmoji(agent.region);
              const region = regionLabel(agent.region);
              return (
                <tr
                  key={agent.id}
                  className="cursor-pointer"
                  onClick={() => selectAgent(agent.id)}
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
      /* bar 视图：默认紧凑条形卡，可由 renderBarItem 覆盖（状态页 AgentStatusBar） */
      <div
        className={
          renderBarItem
            ? "grid grid-cols-1 gap-4"
            : "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        }
      >
        {list.map((agent) => (
          <div key={agent.id}>
            {renderBarItem
              ? renderBarItem(agent, displayMetricFor(agent))
              : defaultBarItem(agent)}
          </div>
        ))}
      </div>
    );

  return (
    <section className="mb-6">
      {/* 标题行右侧为 bar/ring/table/map 视图切换按钮组 */}
      <div className="group-title-row">
        <h2 className="group-title">{title}</h2>
        <div className="flex items-center gap-3">
          {titleExtra}
          <div className="view-toggle">
            <button
              type="button"
              className={`view-toggle-btn${view === "bar" ? " active" : ""}`}
              onClick={() => switchView("bar")}
              title={t("dashboard.view.bar")}
            >
              <LayoutGrid size={13} aria-hidden />
              <span className="view-toggle-text">{t("dashboard.view.bar")}</span>
            </button>
            <button
              type="button"
              className={`view-toggle-btn${view === "ring" ? " active" : ""}`}
              onClick={() => switchView("ring")}
              title={t("dashboard.view.ring")}
            >
              <CircleDashed size={13} aria-hidden />
              <span className="view-toggle-text">
                {t("dashboard.view.ring")}
              </span>
            </button>
            <button
              type="button"
              className={`view-toggle-btn${view === "table" ? " active" : ""}`}
              onClick={() => switchView("table")}
              title={t("dashboard.view.table")}
            >
              <List size={13} aria-hidden />
              <span className="view-toggle-text">
                {t("dashboard.view.table")}
              </span>
            </button>
            <button
              type="button"
              className={`view-toggle-btn${view === "map" ? " active" : ""}`}
              onClick={() => switchView("map")}
              title={t("dashboard.view.map")}
            >
              <Globe size={13} aria-hidden />
              <span className="view-toggle-text">{t("dashboard.view.map")}</span>
            </button>
          </div>
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
      ) : view === "map" ? (
        /* 地图视图：单一整幅地图置于分组之外，消费地区筛选后的完整列表；
           点击多机聚合点联动上方地区筛选栏 */
        <Suspense fallback={<PageLoading />}>
          <WorldMapView
            agents={filteredAgents}
            liveMetrics={liveMetrics}
            onSelectRegion={(code) => setRegionFilter(code)}
            onSelectAgent={onSelectAgent}
          />
        </Suspense>
      ) : showAgentGroupHeaders ? (
        /* 分组段：默认「客户端监控」段排最前，视图与地区筛选在每段内生效 */
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
  );
};

export default AgentViewsSection;
