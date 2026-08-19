/**
 * 还原层测试。用 Go 编码器产出的真实 fixture 走完整链路：
 * base64 -> decodeBlock -> blockSamples，确认还原出的样本形状与推导字段正确。
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { decodeBlock } from "./decode";
import {
  blockSamples,
  maxDiskUsageRate,
  maxOf,
} from "./materialize";

const FIXTURE_PATH = join(
  process.cwd(),
  "src/modules/agents/metricblock/__fixtures__/blocks.json"
);
if (!existsSync(FIXTURE_PATH)) {
  throw new Error(
    `跨语言 fixture 缺失: ${FIXTURE_PATH}\n` +
      "请先运行 `cd agent && go test ./pkg/metricblock/` 生成。"
  );
}
const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  cases: { name: string; data: string; pointCount: number }[];
};

function caseNamed(name: string) {
  const found = fixtures.cases.find((c) => c.name === name);
  if (!found) throw new Error(`fixture ${name} 不存在`);
  return found;
}

async function samplesOf(name: string, agg = 0) {
  const testCase = caseNamed(name);
  const block = await decodeBlock(
    Uint8Array.from(Buffer.from(testCase.data, "base64"))
  );
  return { block, samples: blockSamples(block, agg), expected: testCase };
}

describe("blockSamples", () => {
  it("稠密块还原出 60 个连续样本，间隔 1 秒", async () => {
    const { block, samples } = await samplesOf("dense-1s");
    expect(samples.length).toBe(60);
    for (let i = 0; i < samples.length; i++) {
      expect(samples[i].timestampMs).toBe((block.bucketStart + i) * 1000);
    }
  });

  it("样本数等于 point_count 而非 slot_count", async () => {
    const { samples, expected } = await samplesOf("sparse-1s");
    expect(samples.length).toBe(expected.pointCount);
    expect(samples.length).toBe(40);
  });

  it("稀疏块跳过缺失槽，时间戳保持真实间隔", async () => {
    const { block, samples } = await samplesOf("sparse-1s");
    const offsets = samples.map(
      (s) => s.timestampMs / 1000 - block.bucketStart
    );
    // fixture 抽掉了 20..39 这 20 个槽
    expect(offsets.slice(0, 20)).toEqual(
      Array.from({ length: 20 }, (_, i) => i)
    );
    expect(offsets.slice(20)).toEqual(
      Array.from({ length: 20 }, (_, i) => 40 + i)
    );
  });

  it("单点块还原出 1 个样本", async () => {
    const { samples } = await samplesOf("single-point-1s");
    expect(samples.length).toBe(1);
  });

  it("推导字段：usage_rate 与 free 由 used/total 算出", async () => {
    const { samples } = await samplesOf("dense-1s");
    const sample = samples[0];

    expect(sample.memoryTotal).toBeGreaterThan(0);
    expect(sample.memoryUsed).not.toBeNull();
    expect(sample.memoryUsageRate).toBeCloseTo(
      (sample.memoryUsed! / sample.memoryTotal) * 100,
      6
    );

    expect(sample.disks.length).toBe(3);
    for (const disk of sample.disks) {
      expect(disk.used).not.toBeNull();
      expect(disk.usageRate).toBeCloseTo((disk.used! / disk.total) * 100, 6);
      expect(disk.free).toBeCloseTo(disk.total - disk.used!, 6);
    }
  });

  it("total 为 0 时 usage_rate 返回 null 而不是 NaN/Infinity", async () => {
    const { block } = await samplesOf("dense-1s");
    const zeroed = { ...block, swapTotal: 0 };
    const samples = blockSamples(zeroed);
    expect(samples[0].swapUsageRate).toBeNull();
  });

  it("维度头顺序决定磁盘/网卡/ping 的还原顺序", async () => {
    const { block, samples } = await samplesOf("dense-1s");
    expect(samples[0].disks.map((d) => d.mountPoint)).toEqual(
      block.dims.disks.map((d) => d.name)
    );
    expect(samples[0].nets.map((n) => n.iface)).toEqual(block.dims.nets);
    expect(samples[0].pings.map((p) => p.key)).toEqual(block.dims.pings);
  });

  it("网络计数器单调递增，可用于差分算速率", async () => {
    const { samples } = await samplesOf("dense-1s");
    for (let i = 1; i < samples.length; i++) {
      for (const [slot, cur] of samples[i].nets.entries()) {
        const prev = samples[i - 1].nets[slot];
        expect(cur.iface).toBe(prev.iface);
        expect(cur.bytesRecv!).toBeGreaterThanOrEqual(prev.bytesRecv!);
        expect(cur.bytesSent!).toBeGreaterThanOrEqual(prev.bytesSent!);
      }
    }
  });

  it("丢包样本的 loss 还原为 true，latency 保真为 -1", async () => {
    const { samples } = await samplesOf("ping-loss-1s");
    const ct = samples[0].pings.find((p) => p.key === "ct");
    expect(ct).toBeDefined();
    expect(ct!.loss).toBe(true);
    expect(ct!.latencyMs).toBeCloseTo(-1, 6);
  });

  it("布尔序列还原为 boolean 而非数字", async () => {
    const { samples } = await samplesOf("dense-1s");
    expect(typeof samples[0].ipv4Reachable).toBe("boolean");
    expect(samples[0].ipv4Reachable).toBe(true);
    expect(samples[0].ipv6Reachable).toBe(false);
  });
});

describe("聚合块的三个聚合位", () => {
  it("agg=0/1/2 分别取到 avg/min/max，且 min <= avg <= max", async () => {
    const avg = (await samplesOf("rollup-60s", 0)).samples;
    const min = (await samplesOf("rollup-60s", 1)).samples;
    const max = (await samplesOf("rollup-60s", 2)).samples;

    expect(avg.length).toBe(min.length);
    expect(avg.length).toBe(max.length);
    for (let i = 0; i < avg.length; i++) {
      expect(min[i].cpuUsage!).toBeLessThanOrEqual(avg[i].cpuUsage!);
      expect(avg[i].cpuUsage!).toBeLessThanOrEqual(max[i].cpuUsage!);
    }
  });

  it("聚合块样本间隔为 60 秒", async () => {
    const { block, samples } = await samplesOf("rollup-60s");
    expect(block.interval).toBe(60);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].timestampMs - samples[i - 1].timestampMs).toBe(60_000);
    }
  });

  it("agg 越界时回退到 0 而非崩溃", async () => {
    const { block } = await samplesOf("dense-1s");
    expect(block.aggregateCount).toBe(1);
    const fallback = blockSamples(block, 2);
    const base = blockSamples(block, 0);
    expect(fallback.length).toBe(base.length);
    expect(fallback[0].cpuUsage).toBe(base[0].cpuUsage);
  });
});

describe("聚合辅助函数", () => {
  it("maxOf 忽略 null 与非有限值", async () => {
    const { samples } = await samplesOf("dense-1s");
    const peak = maxOf(samples, (s) => s.cpuUsage);
    expect(peak).not.toBeNull();
    for (const sample of samples) {
      if (sample.cpuUsage !== null) {
        expect(sample.cpuUsage).toBeLessThanOrEqual(peak!);
      }
    }
    expect(maxOf(samples, () => null)).toBeNull();
    expect(maxOf(samples, () => Number.NaN)).toBeNull();
    expect(maxOf([], (s) => s.cpuUsage)).toBeNull();
  });

  it("maxDiskUsageRate 取所有挂载点里最高的使用率", async () => {
    const { samples } = await samplesOf("dense-1s");
    const peak = maxDiskUsageRate(samples[0]);
    const manual = Math.max(
      ...samples[0].disks.map((d) => d.usageRate ?? -Infinity)
    );
    expect(peak).toBeCloseTo(manual, 9);
  });

});
