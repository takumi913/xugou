import { describe, expect, it } from "vitest";

import {
  computeTraffic,
  getTrafficPeriodStart,
  isLoopbackInterface,
  MAX_TRACKED_INTERFACES,
  parseTrafficBaselines,
  type TrafficSampleInterfaces,
  type TrafficState,
} from "./traffic";

const T0 = Date.UTC(2026, 7, 19, 0, 0, 0);
const PERIOD = "2026-08-01";
const GB = 1024 ** 3;

function sample(
  offsetSec: number,
  interfaces: Record<string, [number, number]>
): TrafficSampleInterfaces {
  return {
    ts: T0 + offsetSec * 1000,
    interfaces: Object.entries(interfaces).map(([name, [rx, tx]]) => ({
      name,
      rx,
      tx,
    })),
  };
}

const fresh = (): TrafficState | null => null;

function seeded(interfaces: Record<string, [number, number]>): TrafficState {
  const baselines = Object.fromEntries(
    Object.entries(interfaces).map(([name, [rx, tx]]) => [name, { rx, tx }])
  );
  return {
    month_rx: 0,
    month_tx: 0,
    baselines,
    last_total_rx: null,
    last_total_tx: null,
    month_reset_at: PERIOD,
    last_ts: T0,
  };
}

describe("computeTraffic 逐网卡差分", () => {
  it("首个样本只建基准，不把历史计数当成本月流量", () => {
    const { state, speeds } = computeTraffic(
      fresh(),
      [sample(0, { eth0: [100 * GB, 50 * GB] })],
      PERIOD
    );
    expect(state.month_rx).toBe(0);
    expect(state.month_tx).toBe(0);
    expect(state.baselines).toEqual({ eth0: { rx: 100 * GB, tx: 50 * GB } });
    expect(speeds[0]).toEqual({ rx: null, tx: null });
  });

  it("正常增长按 delta 累计", () => {
    const { state } = computeTraffic(
      seeded({ eth0: [100 * GB, 50 * GB] }),
      [
        sample(60, { eth0: [101 * GB, 50.5 * GB] }),
        sample(120, { eth0: [102 * GB, 51 * GB] }),
      ],
      PERIOD
    );
    expect(state.month_rx).toBe(2 * GB);
    expect(state.month_tx).toBe(GB);
  });

  // 这是 5.91 TB 那个 bug 的核心回归：接口消失不能凭空记进一整个总量
  it("接口消失时不累计任何流量", () => {
    const prev = seeded({ eth0: [200 * GB, 100 * GB], tun0: [5 * GB, 1 * GB] });
    const { state } = computeTraffic(
      prev,
      [sample(60, { eth0: [200 * GB, 100 * GB] })], // tun0 不见了，eth0 没变化
      PERIOD
    );
    expect(state.month_rx).toBe(0);
    expect(state.month_tx).toBe(0);
  });

  it("接口消失又回来时能正确接上差分，不丢不重", () => {
    const prev = seeded({ eth0: [200 * GB, 100 * GB], tun0: [5 * GB, 1 * GB] });
    const gone = computeTraffic(
      prev,
      [sample(60, { eth0: [201 * GB, 100 * GB] })],
      PERIOD
    );
    expect(gone.state.month_rx).toBe(GB);
    // tun0 的基准被保留下来
    expect(gone.state.baselines?.tun0).toEqual({ rx: 5 * GB, tx: 1 * GB });

    const back = computeTraffic(
      gone.state,
      [sample(120, { eth0: [201 * GB, 100 * GB], tun0: [6 * GB, 1 * GB] })],
      PERIOD
    );
    // 只补记 tun0 自己的 1 GB 增量
    expect(back.state.month_rx).toBe(2 * GB);
  });

  it("新接口首次出现只建基准，不把它的历史计数记成本月流量", () => {
    const { state } = computeTraffic(
      seeded({ eth0: [200 * GB, 100 * GB] }),
      [sample(60, { eth0: [200 * GB, 100 * GB], docker0: [80 * GB, 40 * GB] })],
      PERIOD
    );
    expect(state.month_rx).toBe(0);
    expect(state.baselines?.docker0).toEqual({ rx: 80 * GB, tx: 40 * GB });
  });

  it("单块网卡计数器归零时按该网卡当前值累计，不牵连全机总量", () => {
    const prev = seeded({ eth0: [500 * GB, 200 * GB], tun0: [50 * GB, 20 * GB] });
    const { state, speeds } = computeTraffic(
      prev,
      [sample(60, { eth0: [501 * GB, 200 * GB], tun0: [2 * GB, 1 * GB] })],
      PERIOD
    );
    // eth0 增 1 GB + tun0 重置后的 2 GB，而不是旧实现的「整机总和 503 GB」
    expect(state.month_rx).toBe(3 * GB);
    expect(state.month_tx).toBe(GB);
    // 计数器归零那一刻的速率没有意义
    expect(speeds[0]).toEqual({ rx: null, tx: null });
  });

  it("回环接口全程排除，不计进配额", () => {
    const first = computeTraffic(
      fresh(),
      [sample(0, { lo: [50 * GB, 50 * GB], eth0: [10 * GB, 5 * GB] })],
      PERIOD
    );
    expect(Object.keys(first.state.baselines ?? {})).toEqual(["eth0"]);

    const second = computeTraffic(
      first.state,
      [sample(60, { lo: [60 * GB, 60 * GB], eth0: [11 * GB, 5 * GB] })],
      PERIOD
    );
    // lo 涨了 10 GB 也不算数，只认 eth0 的 1 GB
    expect(second.state.month_rx).toBe(GB);
    expect(second.state.last_total_rx).toBe(11 * GB);
  });

  it("速率按相邻样本差分算出，单位 bytes/s", () => {
    const { speeds } = computeTraffic(
      seeded({ eth0: [0, 0] }),
      [sample(10, { eth0: [1000, 500] })],
      PERIOD
    );
    expect(speeds[0].rx).toBeCloseTo(100, 9);
    expect(speeds[0].tx).toBeCloseTo(50, 9);
  });

  it("重放的旧样本整体跳过，不重复累计", () => {
    const prev = seeded({ eth0: [100 * GB, 50 * GB] });
    const { state } = computeTraffic(
      prev,
      [
        sample(-60, { eth0: [999 * GB, 999 * GB] }), // ts 早于基准
        sample(0, { eth0: [999 * GB, 999 * GB] }), // ts 等于基准
        sample(60, { eth0: [101 * GB, 50 * GB] }),
      ],
      PERIOD
    );
    expect(state.month_rx).toBe(GB);
  });

  it("跨计费周期先清零再累计，基准保留以便边界衔接", () => {
    const prev: TrafficState = {
      ...seeded({ eth0: [100 * GB, 50 * GB] }),
      month_rx: 800 * GB,
      month_tx: 400 * GB,
      month_reset_at: "2026-07-01",
    };
    const { state } = computeTraffic(
      prev,
      [sample(60, { eth0: [101 * GB, 50 * GB] })],
      PERIOD
    );
    expect(state.month_rx).toBe(GB);
    expect(state.month_tx).toBe(0);
    expect(state.month_reset_at).toBe(PERIOD);
  });

  it("没有任何非回环接口的样本不影响基准与累计", () => {
    const prev = seeded({ eth0: [100 * GB, 50 * GB] });
    const { state, speeds } = computeTraffic(
      prev,
      [sample(60, { lo: [1 * GB, 1 * GB] }), sample(120, { eth0: [101 * GB, 50 * GB] })],
      PERIOD
    );
    expect(speeds[0]).toEqual({ rx: null, tx: null });
    expect(state.month_rx).toBe(GB);
  });

  it("接口名爆炸时基准表被裁剪到上限", () => {
    let state = fresh();
    const many: Record<string, [number, number]> = {};
    for (let i = 0; i < MAX_TRACKED_INTERFACES + 20; i++) {
      many[`veth${i}`] = [i, i];
    }
    state = computeTraffic(state, [sample(0, many)], PERIOD).state;
    state = computeTraffic(state, [sample(60, { eth0: [1, 1] })], PERIOD).state;
    expect(Object.keys(state.baselines ?? {}).length).toBeLessThanOrEqual(
      MAX_TRACKED_INTERFACES
    );
  });

  // 用真实事故形态兜底：19 天里 tun0 反复起落，旧实现每次加一整个总量
  it("接口反复起落不会把月流量放大成总量的若干倍", () => {
    let state = computeTraffic(
      fresh(),
      [sample(0, { eth0: [250 * GB, 250 * GB], tun0: [5 * GB, 1 * GB] })],
      PERIOD
    ).state;

    let t = 60;
    for (let round = 0; round < 20; round++) {
      state = computeTraffic(
        state,
        [sample(t, { eth0: [(250 + round) * GB, 250 * GB] })],
        PERIOD
      ).state;
      t += 60;
      state = computeTraffic(
        state,
        [
          sample(t, {
            eth0: [(250 + round) * GB, 250 * GB],
            tun0: [5 * GB, 1 * GB],
          }),
        ],
        PERIOD
      ).state;
      t += 60;
    }
    // 真实增量只有 eth0 的 19 GB；旧实现会累计到 20 × ~255 GB ≈ 5 TB
    expect(state.month_rx).toBe(19 * GB);
    expect(state.month_rx).toBeLessThan(100 * GB);
  });
});

describe("parseTrafficBaselines", () => {
  it("解析正常 JSON", () => {
    expect(parseTrafficBaselines('{"eth0":{"rx":1,"tx":2}}')).toEqual({
      eth0: { rx: 1, tx: 2 },
    });
  });

  it("非法输入一律当作没有基准", () => {
    for (const raw of [null, undefined, "", "  ", "not json", "[1,2]", "{}", '{"eth0":{"rx":-1,"tx":0}}']) {
      expect(parseTrafficBaselines(raw)).toBeNull();
    }
  });

  it("跳过坏条目但保留好条目", () => {
    expect(
      parseTrafficBaselines('{"eth0":{"rx":1,"tx":2},"bad":{"rx":"x","tx":0}}')
    ).toEqual({ eth0: { rx: 1, tx: 2 } });
  });
});

describe("辅助函数", () => {
  it("识别回环接口", () => {
    for (const name of ["lo", "lo0", "LO", "Loopback Pseudo-Interface 1"]) {
      expect(isLoopbackInterface(name)).toBe(true);
    }
    for (const name of ["eth0", "enp1s0", "tun0", "docker0", "hello"]) {
      expect(isLoopbackInterface(name)).toBe(false);
    }
  });

  it("计费周期起点按重置日推算", () => {
    expect(getTrafficPeriodStart(new Date("2026-08-19T00:00:00Z"), 1)).toBe(
      "2026-08-01"
    );
    expect(getTrafficPeriodStart(new Date("2026-08-05T00:00:00Z"), 10)).toBe(
      "2026-07-10"
    );
  });
});
