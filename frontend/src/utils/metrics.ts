/**
 * 指标派生/合并的共享纯函数（AgentCard / AgentDetail / AgentStatusBar / Dashboard 共用）
 */
import type { DisplayMetricHistory, MetricHistory } from "../types/agents";

// 单块磁盘指标（disk_metrics JSON 字符串内的元素）
export interface DiskMetric {
  device: string;
  mount_point: string;
  total: number;
  used: number;
  free: number;
  usage_rate: number;
  fs_type: string;
}

export interface DiskUsage {
  total: number;
  used: number;
  percent: number;
}

export interface NetworkMetric {
  interface: string;
  bytes_sent: number;
  bytes_recv: number;
  packets_sent: number;
  packets_recv: number;
}

/** 兼容管理 DTO 的 JSON 字符串与公开 DTO 已解码数组。 */
export function parseNetworkMetrics(
  metric?: Partial<DisplayMetricHistory> | null
): NetworkMetric[] {
  if (!metric?.network_metrics) return [];
  try {
    const value: unknown = Array.isArray(metric.network_metrics)
      ? metric.network_metrics
      : JSON.parse(metric.network_metrics);
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      const finite = (field: string) =>
        typeof row[field] === "number" && Number.isFinite(row[field])
          ? (row[field] as number)
          : 0;
      return [
        {
          interface: typeof row.interface === "string" ? row.interface : "",
          bytes_sent: finite("bytes_sent"),
          bytes_recv: finite("bytes_recv"),
          packets_sent: finite("packets_sent"),
          packets_recv: finite("packets_recv"),
        },
      ];
    });
  } catch {
    return [];
  }
}

// 内存使用率：优先用后端算好的 memory_usage_rate，缺失时按 used/total 派生
export function memoryPercent(
  metric?: Partial<DisplayMetricHistory> | null
): number | undefined {
  if (!metric) return undefined;
  return (
    metric.memory_usage_rate ??
    (metric.memory_total && metric.memory_used !== undefined
      ? (metric.memory_used / metric.memory_total) * 100
      : undefined)
  );
}

// 聚合磁盘用量：解析 disk_metrics JSON 求和算 percent；无数据/解析失败/total<=0 返回 null
export function parseDiskUsage(
  metric?: Partial<DisplayMetricHistory> | null
): DiskUsage | null {
  if (!metric?.disk_metrics) return null;
  try {
    const disks = Array.isArray(metric.disk_metrics)
      ? (metric.disk_metrics as DiskMetric[])
      : (JSON.parse(metric.disk_metrics) as DiskMetric[]);
    let total = 0;
    let used = 0;
    disks.forEach((disk) => {
      total += disk.total;
      used += disk.used;
    });
    if (total <= 0) return null;
    return { total, used, percent: (used / total) * 100 };
  } catch {
    return null;
  }
}

// 流量计费方式（与后端 traffic_calc_type 枚举一致）
export type TrafficCalcType = "sum" | "rx" | "tx";

// 月流量字节数：按计费方式（sum/rx/tx）从最新指标的 month_rx/month_tx 派生；
// 无月流量数据（两个方向都缺失）返回 null
export function monthlyTraffic(
  metric: Partial<MetricHistory> | null | undefined,
  calcType?: string | null
): number | null {
  const rx = typeof metric?.month_rx === "number" ? metric.month_rx : null;
  const tx = typeof metric?.month_tx === "number" ? metric.month_tx : null;
  if (rx === null && tx === null) return null;
  if (calcType === "rx") return rx ?? 0;
  if (calcType === "tx") return tx ?? 0;
  return (rx ?? 0) + (tx ?? 0);
}

// 月流量用量百分比：limitGb（GB）为空/非正数视为不限额，返回 null
export function trafficPercent(
  monthBytes: number | null | undefined,
  limitGb: number | null | undefined
): number | null {
  if (
    typeof monthBytes !== "number" ||
    typeof limitGb !== "number" ||
    !Number.isFinite(limitGb) ||
    limitGb <= 0
  ) {
    return null;
  }
  return (monthBytes / (limitGb * 1024 * 1024 * 1024)) * 100;
}

const metricTs = (metric?: Partial<MetricHistory> | null): number =>
  metric?.timestamp ? Date.parse(metric.timestamp) || 0 : 0;

// 带时间戳仲裁的最新指标合并：incoming 不旧于 base 时叠加覆盖，否则保留 base
// （避免 WS 回放的旧样本覆盖较新的数据）
export function mergeLatestMetric<T extends Partial<MetricHistory>>(
  base: T,
  incoming: Partial<MetricHistory> | null | undefined
): T;
export function mergeLatestMetric<T extends Partial<MetricHistory>>(
  base: T | null | undefined,
  incoming: Partial<MetricHistory>
): T | Partial<MetricHistory>;
export function mergeLatestMetric<T extends Partial<MetricHistory>>(
  base: T | null | undefined,
  incoming: Partial<MetricHistory> | null | undefined
): T | Partial<MetricHistory> | null | undefined {
  if (!incoming) return base;
  if (!base) return incoming;
  if (metricTs(incoming) >= metricTs(base)) {
    return { ...base, ...incoming };
  }
  return base;
}
