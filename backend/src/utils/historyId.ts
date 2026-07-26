/**
 * Agent 历史指标整型分区主键工具（参照 CF-Server-Monitor indexOptimization.js）
 *
 * 历史行主键 = history_partition_id * 10^13 + YYMMDDHHmmss（UTC 数字拼接）。
 * "某机某时段" 查询即主键 BETWEEN 范围扫描，无需任何二级索引。
 */

export const HISTORY_PARTITION_MULTIPLIER = 10_000_000_000_000;
// JS 安全整数上限约 9.007e15，分区 ID 最大只能取到 900
export const HISTORY_MAX_PARTITION_ID = 900;
export const HISTORY_MAX_TIME_KEY = 991231235959;

// 历史查询固定最多返回的点数（SQL 层时间桶聚合降采样）
export const MAX_HISTORY_POINTS = 160;

// 历史查询 hours 白名单，默认 24 保持与旧接口(24h 明细)兼容
export const AGENT_METRICS_HOURS_OPTIONS = [1, 6, 12, 24, 168];
export const DEFAULT_AGENT_METRICS_HOURS = 24;

/**
 * 校验 hours 查询参数。未传时返回默认值 24，非法值返回 null。
 */
export function normalizeAgentMetricsHours(
  value: string | undefined | null
): number | null {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_AGENT_METRICS_HOURS;
  }
  const hours = Number(value);
  return AGENT_METRICS_HOURS_OPTIONS.includes(hours) ? hours : null;
}

function padTimePart(value: number) {
  return String(value).padStart(2, "0");
}

/**
 * 归一化时间输入（Date / ISO 字符串 / 秒或毫秒时间戳）为毫秒时间戳
 */
export function normalizeHistoryTimestamp(
  value: unknown,
  fallback = Date.now()
): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : fallback;
  }
  if (typeof value === "string" && value !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return fallback;
  // 秒级时间戳自动升级为毫秒
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}

/**
 * 把时间转换为 YYMMDDHHmmss（UTC）数字
 */
export function formatHistoryTimeKey(timestamp: unknown): number {
  const normalized = normalizeHistoryTimestamp(timestamp);
  const date = new Date(normalized);
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2099) {
    throw new Error(`Invalid year ${year} for history time key`);
  }

  return Number(
    [
      padTimePart(year % 100),
      padTimePart(date.getUTCMonth() + 1),
      padTimePart(date.getUTCDate()),
      padTimePart(date.getUTCHours()),
      padTimePart(date.getUTCMinutes()),
      padTimePart(date.getUTCSeconds()),
    ].join("")
  );
}

export function normalizeHistoryPartitionId(value: unknown): number | null {
  const partitionId = Number(value);
  if (
    !Number.isInteger(partitionId) ||
    partitionId <= 0 ||
    partitionId > HISTORY_MAX_PARTITION_ID
  ) {
    return null;
  }
  return partitionId;
}

export function buildHistoryId(partitionId: unknown, timestamp: unknown): number {
  const normalizedPartitionId = normalizeHistoryPartitionId(partitionId);
  if (!normalizedPartitionId) {
    throw new Error("Invalid history partition id");
  }
  return (
    normalizedPartitionId * HISTORY_PARTITION_MULTIPLIER +
    formatHistoryTimeKey(timestamp)
  );
}

/**
 * 计算某分区在 [startTimestamp, endTimestamp] 时间窗内的主键范围
 */
export function getHistoryIdRange(
  partitionId: unknown,
  startTimestamp: number | null = null,
  endTimestamp: number | null = null
): { startId: number; endId: number } {
  const normalizedPartitionId = normalizeHistoryPartitionId(partitionId);
  if (!normalizedPartitionId) {
    throw new Error("Invalid history partition id");
  }

  const prefix = normalizedPartitionId * HISTORY_PARTITION_MULTIPLIER;
  return {
    startId:
      prefix + (startTimestamp === null ? 0 : formatHistoryTimeKey(startTimestamp)),
    endId:
      prefix +
      (endTimestamp === null
        ? HISTORY_MAX_TIME_KEY
        : formatHistoryTimeKey(endTimestamp)),
  };
}

/**
 * 最近一次周表轮换时间（每周日 UTC 00:00）。
 * 查询窗口早于该时间时需要 UNION agent_metrics_history_old。
 */
export function getLastRotationTime(nowMs = Date.now()): number {
  const now = new Date(nowMs);
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - now.getUTCDay()
  );
}
