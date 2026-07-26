/**
 * 流量管理纯函数（C1：月流量与实时网速全部服务端计算，agent 协议不变）
 *
 * 语义参照 CF-Server-Monitor 的流量功能：
 * - 网速：相邻样本累计计数器差值 / 时间差（bytes/s），计数器回绕（重启）记 null
 * - 月流量：delta 累计法，delta = current_total - last_total；delta < 0 视为
 *   计数器归零（重启），该次 delta 记为 current_total；跨重置日（UTC）先清零再累计
 * - 网络总量：各接口 bytes_recv/bytes_sent 求和，排除回环接口（lo/lo0/Loopback…）
 */

export const TRAFFIC_CALC_TYPES = ["sum", "rx", "tx"] as const;
export type TrafficCalcType = (typeof TRAFFIC_CALC_TYPES)[number];

export const MIN_TRAFFIC_RESET_DAY = 1;
export const MAX_TRAFFIC_RESET_DAY = 28;
export const DEFAULT_TRAFFIC_RESET_DAY = 1;

// 重置日白名单：1-28 的整数，越界/非法回退默认 1（避免月末 29/30/31 歧义）
export function normalizeTrafficResetDay(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (
    !Number.isInteger(num) ||
    num < MIN_TRAFFIC_RESET_DAY ||
    num > MAX_TRAFFIC_RESET_DAY
  ) {
    return DEFAULT_TRAFFIC_RESET_DAY;
  }
  return num;
}

export function normalizeTrafficCalcType(value: unknown): TrafficCalcType {
  return TRAFFIC_CALC_TYPES.includes(value as TrafficCalcType)
    ? (value as TrafficCalcType)
    : "sum";
}

/**
 * 当前流量周期起点（UTC，YYYY-MM-DD）：
 * 本月 UTC 日期 >= 重置日则为本月重置日，否则为上月重置日。
 */
export function getTrafficPeriodStart(now: Date, resetDay: number): string {
  const day = normalizeTrafficResetDay(resetDay);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start =
    now.getUTCDate() >= day
      ? new Date(Date.UTC(year, month, day))
      : new Date(Date.UTC(year, month - 1, day));
  return start.toISOString().slice(0, 10);
}

// 回环接口判定（lo / lo0 / Loopback Pseudo-Interface 1 等）
export function isLoopbackInterface(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const lower = name.trim().toLowerCase();
  return /^lo\d*$/.test(lower) || lower.includes("loopback");
}

export interface NetworkTotals {
  rx: number;
  tx: number;
}

/**
 * 单个样本的网络累计总量：各接口 bytes_recv/bytes_sent 求和（排除回环接口）。
 * 无网络数据（缺失/空数组/全部为回环且无有效数值）返回 null。
 */
export function sumNetworkTotals(
  networks:
    | Array<{
        interface?: string;
        bytes_recv?: number;
        bytes_sent?: number;
      }>
    | null
    | undefined
): NetworkTotals | null {
  if (!Array.isArray(networks) || networks.length === 0) {
    return null;
  }
  let rx = 0;
  let tx = 0;
  let hasData = false;
  for (const network of networks) {
    if (!network || typeof network !== "object") continue;
    if (isLoopbackInterface(network.interface)) continue;
    const recv = Number(network.bytes_recv);
    const sent = Number(network.bytes_sent);
    if (Number.isFinite(recv) && recv >= 0) {
      rx += recv;
      hasData = true;
    }
    if (Number.isFinite(sent) && sent >= 0) {
      tx += sent;
      hasData = true;
    }
  }
  return hasData ? { rx, tx } : null;
}

/** 一个样本的累计总量 + 采集时间（Unix 毫秒） */
export interface TrafficSampleTotals {
  ts: number;
  totals: NetworkTotals | null;
}

/** 月流量累计状态（agent_latest_metrics 上的持久化列） */
export interface TrafficState {
  month_rx: number;
  month_tx: number;
  last_total_rx: number | null;
  last_total_tx: number | null;
  month_reset_at: string | null;
  /** 上次基准计数器对应的采集时间（Unix 毫秒），无法确定时为 null */
  last_ts: number | null;
}

export interface TrafficComputation {
  /** 与输入样本一一对应的速率（bytes/s；无法计算记 null） */
  speeds: Array<{ rx: number | null; tx: number | null }>;
  /** 累计后的最新状态（落库用） */
  state: TrafficState;
}

// 相邻计数器速率：delta/dt；dt<=0 或 delta<0（重启/回绕）记 null，不记负值
function computeSpeed(
  prevTotal: number | null,
  prevTs: number | null,
  curTotal: number,
  curTs: number
): number | null {
  if (prevTotal === null || prevTs === null) return null;
  const deltaMs = curTs - prevTs;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return null;
  const deltaBytes = curTotal - prevTotal;
  if (deltaBytes < 0) return null;
  return (deltaBytes / deltaMs) * 1000;
}

/**
 * 单趟遍历样本序列，计算逐样本速率并累计月流量。
 *
 * 规则：
 * - 跨重置日（prev.month_reset_at !== periodStart）先清零 month_rx/tx 再累计，
 *   基准计数器（last_total_*）保留，保证周期边界后 delta 正确衔接；
 * - ts 不大于上次基准时间的样本视为重放，整体跳过（防止重传导致重复累计）；
 * - delta < 0（计数器归零/重启）：速率记 null，月流量按 delta = current_total 累计；
 * - 首次上报（无基准）：只建立基准，不累计、不出速率；
 * - 无网络数据的样本：速率 null，不影响基准与月累计。
 */
export function computeTraffic(
  prev: TrafficState | null,
  samples: TrafficSampleTotals[],
  periodStart: string
): TrafficComputation {
  let monthRx = prev?.month_rx ?? 0;
  let monthTx = prev?.month_tx ?? 0;
  if (!prev || prev.month_reset_at !== periodStart) {
    monthRx = 0;
    monthTx = 0;
  }

  let lastRx = prev?.last_total_rx ?? null;
  let lastTx = prev?.last_total_tx ?? null;
  let lastTs = prev?.last_ts ?? null;

  const speeds: Array<{ rx: number | null; tx: number | null }> = [];

  for (const sample of samples) {
    const totals = sample.totals;
    const ts = Number(sample.ts);
    if (
      !totals ||
      !Number.isFinite(ts) ||
      (lastTs !== null && ts <= lastTs)
    ) {
      speeds.push({ rx: null, tx: null });
      continue;
    }

    speeds.push({
      rx: computeSpeed(lastRx, lastTs, totals.rx, ts),
      tx: computeSpeed(lastTx, lastTs, totals.tx, ts),
    });

    if (lastRx !== null) {
      const deltaRx = totals.rx - lastRx;
      monthRx += deltaRx < 0 ? totals.rx : deltaRx;
    }
    if (lastTx !== null) {
      const deltaTx = totals.tx - lastTx;
      monthTx += deltaTx < 0 ? totals.tx : deltaTx;
    }

    lastRx = totals.rx;
    lastTx = totals.tx;
    lastTs = ts;
  }

  return {
    speeds,
    state: {
      month_rx: monthRx,
      month_tx: monthTx,
      last_total_rx: lastRx,
      last_total_tx: lastTx,
      month_reset_at: periodStart,
      last_ts: lastTs,
    },
  };
}
