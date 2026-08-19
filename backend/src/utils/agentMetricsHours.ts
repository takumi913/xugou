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
