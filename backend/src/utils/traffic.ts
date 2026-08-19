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

/** 单个网卡在某一刻的累计计数器 */
export interface InterfaceCounters {
  rx: number;
  tx: number;
}

/** 逐网卡基准：接口名 -> 上次见到的累计计数器 */
export type TrafficBaselines = Record<string, InterfaceCounters>;

/** 基准表最多保留多少个接口，超出时丢弃本次样本里没出现的老条目 */
export const MAX_TRACKED_INTERFACES = 64;

/** 一个样本的逐网卡计数器 + 采集时间（Unix 毫秒） */
export interface TrafficSampleInterfaces {
  ts: number;
  interfaces:
    | Array<{ name: string; rx: number | null; tx: number | null }>
    | null;
}

/** 月流量累计状态（agent_current_metrics 上的持久化列） */
export interface TrafficState {
  month_rx: number;
  month_tx: number;
  /** 逐网卡基准。null 表示还没有基准（首次上报或从旧版本迁移过来） */
  baselines: TrafficBaselines | null;
  /** 基准的合计值，仅用于展示与排查；累计逻辑不读它 */
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

/** 解析持久化的基准 JSON；结构不对就当作没有基准，让下一个样本重建。 */
export function parseTrafficBaselines(raw: unknown): TrafficBaselines | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const baselines: TrafficBaselines = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!name || !value || typeof value !== "object") continue;
    const rx = Number((value as Record<string, unknown>).rx);
    const tx = Number((value as Record<string, unknown>).tx);
    if (!Number.isFinite(rx) || !Number.isFinite(tx) || rx < 0 || tx < 0) continue;
    baselines[name] = { rx, tx };
  }
  return Object.keys(baselines).length > 0 ? baselines : null;
}

function sumBaselines(baselines: TrafficBaselines): NetworkTotals {
  let rx = 0;
  let tx = 0;
  for (const counters of Object.values(baselines)) {
    rx += counters.rx;
    tx += counters.tx;
  }
  return { rx, tx };
}

/**
 * 月流量累计：**逐网卡**差分。
 *
 * 之所以不能按「所有网卡求和」再差分：总和会随接口集合变化而跳变。jp 上的
 * tun0(VPN) / docker0 这类接口来去一次，总和就掉一截，旧实现把它当成计数器归零，
 * 于是 `month += 当前总和` —— 一次接口消失就凭空记进 ~290 GB。线上实测
 * month_rx 长到了 last_total_rx 的 19.7 倍，就是这么来的。
 *
 * 逐网卡之后：
 * - 接口消失：它的基准留着不动，什么都不累计（下次回来能正确接上）
 * - 接口新增：只建基准，不累计（不知道多少流量发生在纳入统计之前）
 * - 单块网卡计数器归零：按该网卡当前值累计，量级被这块网卡自身限住，
 *   不会再是全机总和
 * - 回环接口（lo/lo0/Loopback）全程排除，计进配额没有意义
 */
export function computeTraffic(
  prev: TrafficState | null,
  samples: TrafficSampleInterfaces[],
  periodStart: string
): TrafficComputation {
  let monthRx = prev?.month_rx ?? 0;
  let monthTx = prev?.month_tx ?? 0;
  if (!prev || prev.month_reset_at !== periodStart) {
    monthRx = 0;
    monthTx = 0;
  }

  const baselines: TrafficBaselines = { ...(prev?.baselines ?? {}) };
  let lastTs = prev?.last_ts ?? null;
  const speeds: Array<{ rx: number | null; tx: number | null }> = [];

  for (const sample of samples) {
    const ts = Number(sample.ts);
    // ts 不大于上次基准时间的样本视为重放，整体跳过，防止重传导致重复累计
    if (
      !Array.isArray(sample.interfaces) ||
      sample.interfaces.length === 0 ||
      !Number.isFinite(ts) ||
      (lastTs !== null && ts <= lastTs)
    ) {
      speeds.push({ rx: null, tx: null });
      continue;
    }

    const current: TrafficBaselines = {};
    for (const item of sample.interfaces) {
      if (!item || typeof item.name !== "string" || item.name === "") continue;
      if (isLoopbackInterface(item.name)) continue;
      const rx = Number(item.rx);
      const tx = Number(item.tx);
      if (!Number.isFinite(rx) || !Number.isFinite(tx) || rx < 0 || tx < 0) continue;
      current[item.name] = { rx, tx };
    }
    const names = Object.keys(current);
    if (names.length === 0) {
      speeds.push({ rx: null, tx: null });
      continue;
    }

    let deltaRx = 0;
    let deltaTx = 0;
    let matched = false;
    let sawCounterReset = false;
    for (const name of names) {
      const base = baselines[name];
      const now = current[name];
      if (!base) continue; // 新接口：只建基准，本轮不累计
      matched = true;
      const dRx = now.rx - base.rx;
      const dTx = now.tx - base.tx;
      if (dRx < 0 || dTx < 0) sawCounterReset = true;
      deltaRx += dRx < 0 ? now.rx : dRx;
      deltaTx += dTx < 0 ? now.tx : dTx;
    }

    monthRx += deltaRx;
    monthTx += deltaTx;

    const deltaMs = lastTs === null ? 0 : ts - lastTs;
    speeds.push(
      matched && !sawCounterReset && deltaMs > 0
        ? { rx: (deltaRx / deltaMs) * 1000, tx: (deltaTx / deltaMs) * 1000 }
        : { rx: null, tx: null }
    );

    for (const name of names) baselines[name] = current[name];
    // 消失的接口基准刻意保留，回来时才能正确接上差分；只有条目过多才裁剪。
    if (Object.keys(baselines).length > MAX_TRACKED_INTERFACES) {
      for (const name of Object.keys(baselines)) {
        if (!(name in current)) delete baselines[name];
      }
    }
    lastTs = ts;
  }

  const hasBaselines = Object.keys(baselines).length > 0;
  const totals = hasBaselines ? sumBaselines(baselines) : null;
  return {
    speeds,
    state: {
      month_rx: monthRx,
      month_tx: monthTx,
      baselines: hasBaselines ? baselines : null,
      last_total_rx: totals ? totals.rx : null,
      last_total_tx: totals ? totals.tx : null,
      month_reset_at: periodStart,
      last_ts: lastTs,
    },
  };
}
