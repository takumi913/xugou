import React from "react";
import { useTranslation } from "react-i18next";
import type { MetricHistory } from "../types";
import { Badge } from "./ui/badge";
import { ProgressBar } from "./StatBar";
import { formatBytes, formatSpeed } from "../utils/format";
import {
  memoryPercent,
  parseDiskUsage,
  parseNetworkMetrics,
} from "../utils/metrics";
import { regionFlagEmoji, regionLabel } from "../utils/region";
import {
  Apple,
  Laptop,
  Monitor,
  Smartphone,
  Terminal,
  type LucideIcon,
} from "lucide-react";

interface AgentStatusBarProps {
  latestMetric?: Partial<MetricHistory> | null;
  agent: {
    name: string;
    status: string;
    os?: string | null;
    region?: string | null;
  };
}

const formatPercent = (val: number | undefined, decimals = 2) =>
  val !== undefined ? `${val.toFixed(decimals)}%` : "-";

const MetricCard = ({
  label,
  value,
  subValue,
  percent,
}: {
  label: string;
  value: string;
  subValue?: string;
  percent?: number;
}) => (
  <div className="flex flex-col space-y-1 min-w-[80px] flex-1">
    <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
      {label}
    </span>
    <span
      className="text-base font-semibold"
      style={{ color: "var(--text-primary)" }}
    >
      {value}
    </span>
    {subValue && (
      <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
        {subValue}
      </span>
    )}
    {percent !== undefined && <ProgressBar percent={percent} />}
  </div>
);

const getOsIcon = (os: string | undefined): LucideIcon => {
  if (!os) return Laptop;
  const osLower = os.toLowerCase();
  if (osLower.includes("windows")) return Monitor;
  if (osLower.includes("mac") || osLower.includes("darwin")) return Apple;
  if (osLower.includes("linux")) return Terminal;
  if (osLower.includes("android") || osLower.includes("ios")) return Smartphone;
  return Laptop;
};

const AgentStatusBar: React.FC<AgentStatusBarProps> = ({
  latestMetric,
  agent,
}) => {
  const { t } = useTranslation();
  const OsIcon = getOsIcon(agent.os ?? undefined);

  // 聚合存储总量和使用情况
  const diskUsage = parseDiskUsage(latestMetric);
  const totalStorage = diskUsage?.total ?? 0;
  const usedStorage = diskUsage?.used ?? 0;
  const storageUsageRate = diskUsage?.percent ?? 0;

  // 内存使用率（优先用后端算好的字段，缺失时按 used/total 派生）
  const memoryUsageRate = memoryPercent(latestMetric);

  // 计算网络总量
  let totalUpload = 0;
  let totalDownload = 0;

  parseNetworkMetrics(latestMetric).forEach((network) => {
    totalUpload += network.bytes_sent;
    totalDownload += network.bytes_recv;
  });

  return (
    <div className="terminal-card p-4 transition-all">
      {/* 顶部信息栏 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="flex items-center gap-1">
            <OsIcon className="size-4" />
          </Badge>
          <span
            className="text-lg font-bold"
            style={{ color: "var(--text-primary)" }}
          >
            {agent.name}
          </span>
          {regionFlagEmoji(agent.region) && (
            <span
              className="text-xs"
              style={{ color: "var(--text-secondary)" }}
              title={regionLabel(agent.region) ?? undefined}
            >
              {regionFlagEmoji(agent.region)} {regionLabel(agent.region)}
            </span>
          )}
          <Badge
            variant="outline"
            color={agent.status === "active" ? "green" : "gray"}
          >
            {agent.status === "active"
              ? t("agent.status.online")
              : t("agent.status.offline")}
          </Badge>
        </div>
      </div>

      {/* 主要指标 - 响应式网格布局 */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-4">
        <MetricCard
          label="CPU"
          value={formatPercent(latestMetric?.cpu_usage)}
          subValue={latestMetric?.cpu_model}
          percent={latestMetric?.cpu_usage}
        />
        <MetricCard
          label={t("agent.metrics.memory.title")}
          value={formatPercent(memoryUsageRate)}
          subValue={
            typeof latestMetric?.memory_used === "number" &&
            typeof latestMetric.memory_total === "number"
              ? `${formatBytes(latestMetric.memory_used, 2)} / ${formatBytes(
                  latestMetric.memory_total,
                  2
                )}`
              : undefined
          }
          percent={memoryUsageRate}
        />
        <MetricCard
          label={t("agentStatusBar.storage")}
          value={formatPercent(storageUsageRate)}
          subValue={`${formatBytes(usedStorage, 2)} / ${formatBytes(
            totalStorage,
            2
          )}`}
          percent={storageUsageRate}
        />
        <MetricCard
          label={t("agent.metrics.load.title")}
          value={
            typeof latestMetric?.load_1 === "number"
              ? latestMetric.load_1.toFixed(2)
              : "-"
          }
          subValue={
            typeof latestMetric?.load_5 === "number" &&
            typeof latestMetric.load_15 === "number"
              ? `${latestMetric.load_5.toFixed(2)} / ${latestMetric.load_15.toFixed(2)}`
              : undefined
          }
        />
        <MetricCard
          label={t("agentStatusBar.uploadSpeed")}
          value={formatSpeed(latestMetric?.network_tx_speed)}
        />
        <MetricCard
          label={t("agentStatusBar.downloadSpeed")}
          value={formatSpeed(latestMetric?.network_rx_speed)}
        />
      </div>

      {/* 底部统计信息 */}
      <div
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-sm"
        style={{ color: "var(--text-secondary)" }}
      >
        <div className="flex items-center gap-4">
          <span>
            <span className="net-up">▲</span>{" "}
            {t("agentStatusBar.totalUpload")}: {formatBytes(totalUpload, 2)}
          </span>
          <span>
            <span className="net-down">▼</span>{" "}
            {t("agentStatusBar.totalDownload")}: {formatBytes(totalDownload, 2)}
          </span>
        </div>
      </div>
    </div>
  );
};

export default AgentStatusBar;
