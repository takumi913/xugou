import React from "react";
import { MetricHistory, AgentWithLatestMetrics } from "../types";
import { Badge } from "./ui/badge";
import {
  Apple,
  Laptop,
  Monitor,
  Smartphone,
  Terminal,
  type LucideIcon,
} from "lucide-react";

interface AgentStatusBarProps {
  latestMetric?: MetricHistory;
  agent: AgentWithLatestMetrics;
}

interface DiskMetric {
  device: string;
  mount_point: string;
  total: number;
  used: number;
  free: number;
  usage_rate: number;
  fs_type: string;
}

interface NetworkMetric {
  interface: string;
  bytes_sent: number;
  bytes_recv: number;
  packets_sent: number;
  packets_recv: number;
}

const formatBytes = (bytes: number | undefined, decimals = 2): string => {
  if (bytes === undefined || bytes === 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
};

const formatPercent = (val: number | undefined, decimals = 2) =>
  val !== undefined ? `${val.toFixed(decimals)}%` : "-";

const ProgressBar = ({
  percent,
  color,
}: {
  percent: number;
  color: string;
}) => (
  <div className="w-full h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
    <div
      style={{ width: `${percent}%`, background: color }}
      className="h-full transition-all duration-300 rounded-full"
    />
  </div>
);

const MetricCard = ({
  label,
  value,
  subValue,
  percent,
  color,
}: {
  label: string;
  value: string;
  subValue?: string;
  percent?: number;
  color?: string;
}) => (
  <div className="flex flex-col space-y-1 min-w-[80px] flex-1">
    <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
    <span className="text-base font-semibold">{value}</span>
    {subValue && <span className="text-xs text-gray-500">{subValue}</span>}
    {percent !== undefined && color && (
      <ProgressBar percent={percent} color={color} />
    )}
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
  const OsIcon = getOsIcon(agent.os);

  // 计算存储总量和使用情况
  let totalStorage = 0;
  let usedStorage = 0;
  let storageUsageRate = 0;

  // 计算网络总量
  let totalUpload = 0;
  let totalDownload = 0;

  if (latestMetric) {
    // 解析并聚合所有磁盘数据
    if (latestMetric.disk_metrics) {
      try {
        const disks = JSON.parse(latestMetric.disk_metrics) as DiskMetric[];
        disks.forEach((disk) => {
          totalStorage += disk.total;
          usedStorage += disk.used;
        });
        storageUsageRate = (usedStorage / totalStorage) * 100;
      } catch (e) {
        console.error("解析磁盘数据失败:", e);
      }
    }

    // 解析并聚合所有网络接口数据
    if (latestMetric.network_metrics) {
      try {
        const networks = JSON.parse(
          latestMetric.network_metrics
        ) as NetworkMetric[];
        networks.forEach((network) => {
          totalUpload += network.bytes_sent;
          totalDownload += network.bytes_recv;
        });
      } catch (e) {
        console.error("解析网络数据失败:", e);
      }
    }
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-4 transition-all">
      {/* 顶部信息栏 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="flex items-center gap-1">
            <OsIcon className="size-4" />
          </Badge>
          <span className="text-lg font-bold dark:text-white">
            {agent.name}
          </span>
          <Badge
            variant="outline"
            color={agent.status === "active" ? "green" : "gray"}
          >
            {agent.status === "active" ? "在线" : "离线"}
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
          color="#2d8cf0"
        />
        <MetricCard
          label="内存"
          value={formatPercent(latestMetric?.memory_usage_rate)}
          subValue={
            latestMetric
              ? `${formatBytes(latestMetric.memory_used)} / ${formatBytes(
                  latestMetric.memory_total
                )}`
              : undefined
          }
          percent={latestMetric?.memory_usage_rate}
          color="#faad14"
        />
        <MetricCard
          label="存储"
          value={formatPercent(storageUsageRate)}
          subValue={`${formatBytes(usedStorage)} / ${formatBytes(
            totalStorage
          )}`}
          percent={storageUsageRate}
          color="#13c2c2"
        />
        <MetricCard
          label="系统负载"
          value={latestMetric?.load_1?.toFixed(2) || "-"}
          subValue={
            latestMetric
              ? `${latestMetric.load_5?.toFixed(
                  2
                )} / ${latestMetric.load_15?.toFixed(2)}`
              : undefined
          }
        />
      </div>

      {/* 底部统计信息 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-sm text-gray-600 dark:text-gray-300">
        <div className="flex items-center gap-4">
          <span>总上传：{formatBytes(totalUpload)}</span>
          <span>总下载：{formatBytes(totalDownload)}</span>
        </div>
      </div>
    </div>
  );
};

export default AgentStatusBar;
