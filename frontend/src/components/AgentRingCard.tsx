import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { DashboardAgent } from "../api/dashboard";
import type { MetricHistory } from "../types/agents";
import {
  agentStatusColors,
  getUsageColor,
  statusAccentColor,
} from "../utils/statusColors";
import { formatBytes, formatSpeed } from "../utils/format";
import {
  memoryPercent as deriveMemoryPercent,
  mergeLatestMetric,
  monthlyTraffic,
  parseDiskUsage,
  trafficPercent,
} from "../utils/metrics";
import { regionFlagEmoji, regionLabel } from "../utils/region";
import { ProgressBar } from "./StatBar";

interface AgentRingCardProps {
  agent: DashboardAgent;
  liveMetric?: Partial<MetricHistory> | null;
  /** 点击行为覆盖（公开状态页展开详情）；缺省时链接到 /agents/:id */
  onSelect?: () => void;
}

// 单个环形进度（复用 global.css 的 .metric-ring* 系列；无数据时置灰显示 '-'）
const Ring = ({
  label,
  percent,
  subtext,
}: {
  label: string;
  percent?: number;
  subtext?: string;
}) => {
  const hasValue = typeof percent === "number" && Number.isFinite(percent);
  const clamped = hasValue ? Math.min(100, Math.max(0, percent)) : 0;
  return (
    <div className="metric-ring-item">
      <div
        className="metric-ring-chart"
        style={
          {
            "--ring-value": `${clamped}`,
            "--ring-color": hasValue
              ? getUsageColor(clamped)
              : "var(--border-color)",
          } as React.CSSProperties
        }
      >
        <span className="metric-ring-track" />
        <span className="metric-ring-progress" />
        <span className="metric-ring-center">
          {hasValue ? `${Math.round(clamped)}%` : "-"}
        </span>
      </div>
      <div className="metric-ring-label">{label}</div>
      <div className="metric-ring-subtext">{subtext}</div>
    </div>
  );
};

/**
 * 客户端环形卡（Dashboard ring 视图，参照 CF-SM ServerRingCard 布局）：
 * header（名称+状态徽章）→ 分隔线 → CPU/RAM/DISK 三环 → 网络速率行 + 月流量进度
 */
const AgentRingCard = ({ agent, liveMetric, onSelect }: AgentRingCardProps) => {
  const { t } = useTranslation();

  const agentStatus = agent.status || "inactive";
  const statusColor = statusAccentColor(agentStatusColors, agentStatus);
  const statusText: { [key: string]: string } = {
    active: t("agentCard.status.active"),
    inactive: t("agentCard.status.inactive"),
    connecting: t("agentCard.status.connecting"),
  };

  // 叠加实时样本（WS 优先，带时间戳仲裁避免旧样本覆盖新数据）
  const displayMetric = useMemo<Partial<MetricHistory> | undefined>(() => {
    const base = agent.metrics ?? undefined;
    if (!liveMetric) return base;
    return mergeLatestMetric(base, liveMetric) ?? undefined;
  }, [agent.metrics, liveMetric]);

  const memoryPercent = deriveMemoryPercent(displayMetric);
  const diskUsage = useMemo(
    () => parseDiskUsage(displayMetric),
    [displayMetric]
  );

  // 月流量（按计费方式）与限额百分比（有限额时渲染进度条）
  const monthBytes = monthlyTraffic(displayMetric, agent.traffic_calc_type);
  const trafficPct = trafficPercent(monthBytes, agent.traffic_limit_gb);

  const flag = regionFlagEmoji(agent.region);
  const region = regionLabel(agent.region);

  // 标签徽章（逗号分隔，空项过滤；无标签不渲染）
  const tagItems = useMemo(
    () =>
      (agent.tags ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    [agent.tags]
  );

  const ramSubtext =
    typeof displayMetric?.memory_used === "number" &&
    typeof displayMetric?.memory_total === "number"
      ? `${formatBytes(displayMetric.memory_used, 1)} / ${formatBytes(
          displayMetric.memory_total,
          1
        )}`
      : undefined;
  const diskSubtext = diskUsage
    ? `${formatBytes(diskUsage.used, 1)} / ${formatBytes(diskUsage.total, 1)}`
    : undefined;
  const cpuSubtext =
    typeof displayMetric?.cpu_cores === "number"
      ? `${displayMetric.cpu_cores} Cores`
      : undefined;

  // 卡片主体先构造为节点，再按点击行为选择外层（避免内联组件反复重挂子树）
  const body = (
    <>
      {/* header：名称 + 地区 + 状态徽章（与 AgentCard/bar 卡同款样式） */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span style={{ color: statusColor, flexShrink: 0 }}>●</span>
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
          style={{ color: statusColor, borderColor: statusColor }}
        >
          {statusText[agentStatus] ?? agentStatus}
        </span>
      </div>

      {/* 标签徽章行（终端风格小徽章） */}
      {tagItems.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {tagItems.map((tag) => (
            <span key={tag} className="tag-badge">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* 分隔线 */}
      <div
        className="mt-2"
        style={{ borderTop: "1px solid var(--border-color)" }}
      />

      {/* CPU/RAM/DISK 三环 */}
      <div className="ring-card-metrics">
        <Ring label="CPU" percent={displayMetric?.cpu_usage} subtext={cpuSubtext} />
        <Ring label="RAM" percent={memoryPercent} subtext={ramSubtext} />
        <Ring label="DISK" percent={diskUsage?.percent} subtext={diskSubtext} />
      </div>

      {/* 网络速率行 */}
      <div className="stat-row">
        <span className="stat-key">NET</span>
        <span className="net-down">
          ↓ {formatSpeed(displayMetric?.network_rx_speed)}
        </span>
        <span className="net-up">
          ↑ {formatSpeed(displayMetric?.network_tx_speed)}
        </span>
      </div>

      {/* 月流量：有限额时叠加进度条 */}
      {monthBytes !== null && (
        <div className="stat-row mb-0">
          <span className="stat-key">TRF</span>
          {trafficPct !== null ? (
            <>
              <ProgressBar percent={trafficPct} />
              <span
                className="stat-value whitespace-nowrap"
                title={`${trafficPct.toFixed(1)}%`}
              >
                {formatBytes(monthBytes, 2)} /{" "}
                {formatBytes((agent.traffic_limit_gb ?? 0) * 1024 * 1024 * 1024, 1)}
              </span>
            </>
          ) : (
            <span style={{ color: "var(--text-secondary)" }}>
              {formatBytes(monthBytes, 2)}
            </span>
          )}
        </div>
      )}
    </>
  );

  // onSelect 提供时渲染为可点击 div（公开状态页无管理端路由），否则保持 Link
  return onSelect ? (
    <div
      role="button"
      tabIndex={0}
      className="terminal-card block cursor-pointer p-3 text-[13px]"
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
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

export default AgentRingCard;
