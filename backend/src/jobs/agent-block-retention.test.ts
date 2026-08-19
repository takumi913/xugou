import { beforeEach, describe, expect, it } from "vitest";

import type { Bindings } from "../models/db";
import {
  createSqliteD1,
  METRIC_BLOCK_SCHEMA,
  type SqliteD1,
} from "../test-utils/sqlite-d1";
import {
  enforceAgentBlockBudget,
  pruneAgedAgentBlocks,
  runAgentBlockRetention,
} from "./agent-block-retention";
import { claimIntervalRun, INTERVAL_KEY_AGENT_BLOCK_BUDGET } from "./interval-gate";

const NOW_MS = Date.UTC(2026, 7, 19, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);
const KB = 1024;
const MB = 1024 * 1024;

let sqlite: SqliteD1;
let env: Bindings;

function insertBlock(options: {
  agentId?: number;
  resolution?: number;
  bucketStart: number;
  byteSize?: number;
}) {
  // GC 只看 byte_size 列，data 用占位 blob，免得测试为了凑预算真的分配几 MB。
  sqlite.raw
    .prepare(
      `INSERT INTO agent_metric_blocks
       (agent_id, resolution, bucket_start, point_count, codec, byte_size, data)
       VALUES (?, ?, ?, 60, 1, ?, ?)`
    )
    .run(
      options.agentId ?? 1,
      options.resolution ?? 1,
      options.bucketStart,
      options.byteSize ?? 1000,
      new Uint8Array([0xb1])
    );
}

function remainingBucketStarts(resolution = 1) {
  return (
    sqlite.raw
      .prepare(
        `SELECT bucket_start FROM agent_metric_blocks
         WHERE resolution = ? ORDER BY bucket_start ASC`
      )
      .all(resolution) as { bucket_start: number }[]
  ).map((row) => Number(row.bucket_start));
}

function totalBytes(resolution = 1) {
  const row = sqlite.raw
    .prepare(
      `SELECT COALESCE(SUM(byte_size), 0) AS bytes
       FROM agent_metric_blocks WHERE resolution = ?`
    )
    .get(resolution) as { bytes: number };
  return Number(row.bytes);
}

beforeEach(() => {
  sqlite = createSqliteD1(METRIC_BLOCK_SCHEMA);
  env = { DB: sqlite.DB } as unknown as Bindings;
});

describe("pruneAgedAgentBlocks", () => {
  it("按 AGENT_BLOCK_MAX_AGE_DAYS 删除过期块，保留窗口内的块", async () => {
    insertBlock({ bucketStart: NOW_SEC - 8 * 86400 });
    insertBlock({ bucketStart: NOW_SEC - 7 * 86400 - 1 });
    insertBlock({ bucketStart: NOW_SEC - 6 * 86400 });
    insertBlock({ bucketStart: NOW_SEC - 60, resolution: 60 });

    const result = await pruneAgedAgentBlocks(env, NOW_MS);

    expect(result.deleted).toBe(2);
    expect(remainingBucketStarts()).toEqual([NOW_SEC - 6 * 86400]);
    // 年龄规则对两种分辨率一视同仁，1 分钟块只要在窗口内就留着
    expect(remainingBucketStarts(60)).toEqual([NOW_SEC - 60]);
  });

  it("环境变量能收紧保留窗口", async () => {
    insertBlock({ bucketStart: NOW_SEC - 2 * 86400 });
    insertBlock({ bucketStart: NOW_SEC - 3600 });

    const tightened = {
      DB: sqlite.DB,
      AGENT_BLOCK_MAX_AGE_DAYS: "1",
    } as unknown as Bindings;
    const result = await pruneAgedAgentBlocks(tightened, NOW_MS);

    expect(result.deleted).toBe(1);
    expect(remainingBucketStarts()).toEqual([NOW_SEC - 3600]);
  });
});

describe("enforceAgentBlockBudget", () => {
  const budgetEnv = (budgetBytes: number, gcBatch = 500) =>
    ({
      DB: sqlite.DB,
      AGENT_BLOCK_HOT_BUDGET_BYTES: String(budgetBytes),
      AGENT_BLOCK_GC_BATCH: String(gcBatch),
    }) as unknown as Bindings;

  it("未超预算时一行都不删", async () => {
    for (let i = 0; i < 10; i++) {
      insertBlock({ bucketStart: NOW_SEC - i * 60, byteSize: 64 * KB });
    }

    const result = await enforceAgentBlockBudget(budgetEnv(20 * MB));

    expect(result.deleted).toBe(0);
    expect(result.converged).toBe(true);
    expect(totalBytes()).toBe(640 * KB);
  });

  it("超预算后收敛到预算以内，且删的是最旧的块", async () => {
    // 100 块 × 64 KB = 6.4 MB，预算 4 MB → 需要删掉最旧的 36 块
    for (let i = 0; i < 100; i++) {
      insertBlock({ bucketStart: NOW_SEC - (100 - i) * 60, byteSize: 64 * KB });
    }

    const result = await enforceAgentBlockBudget(budgetEnv(4 * MB));

    expect(result.converged).toBe(true);
    expect(totalBytes()).toBeLessThanOrEqual(4 * MB);
    expect(result.deleted).toBe(36);

    const remaining = remainingBucketStarts();
    expect(remaining.length).toBe(64);
    // 留下的必须是最新的 64 个桶
    expect(remaining[0]).toBe(NOW_SEC - 64 * 60);
    expect(remaining[remaining.length - 1]).toBe(NOW_SEC - 60);
  });

  it("单批容量不够时多轮回收，仍然收敛", async () => {
    // 400 块 × 64 KB = 25 MB，预算 6 MB → 要删 304 块；gcBatch=20 意味着 16 轮
    for (let i = 0; i < 400; i++) {
      insertBlock({ bucketStart: NOW_SEC - (400 - i) * 60, byteSize: 64 * KB });
    }

    const result = await enforceAgentBlockBudget(budgetEnv(6 * MB, 20));

    expect(result.deleted).toBe(304);
    expect(result.converged).toBe(true);
    expect(totalBytes()).toBe(6 * MB);
  });

  it("预算只约束 resolution=1，1 分钟层不受影响", async () => {
    for (let i = 0; i < 50; i++) {
      insertBlock({ bucketStart: NOW_SEC - (50 - i) * 60, byteSize: 64 * KB });
    }
    for (let i = 0; i < 20; i++) {
      insertBlock({
        resolution: 60,
        bucketStart: NOW_SEC - (20 - i) * 3600,
        byteSize: 256 * KB,
      });
    }

    const result = await enforceAgentBlockBudget(budgetEnv(1 * MB));

    expect(result.converged).toBe(true);
    expect(totalBytes(1)).toBeLessThanOrEqual(1 * MB);
    expect(remainingBucketStarts(60).length).toBe(20);
    expect(totalBytes(60)).toBe(20 * 256 * KB);
    expect(result.blocksBefore).toBe(50);
  });

  it("单块就超预算时把 1 秒层删空而不是死循环", async () => {
    insertBlock({ bucketStart: NOW_SEC - 120, byteSize: 2 * MB });
    insertBlock({ bucketStart: NOW_SEC - 60, byteSize: 2 * MB });

    const result = await enforceAgentBlockBudget(budgetEnv(1 * MB));

    expect(result.deleted).toBe(2);
    expect(result.converged).toBe(true);
    expect(remainingBucketStarts()).toEqual([]);
  });
});

describe("runAgentBlockRetention", () => {
  it("年龄回收每个 tick 都跑，预算回收每小时才领取一次", async () => {
    for (let i = 0; i < 20; i++) {
      insertBlock({ bucketStart: NOW_SEC - (20 - i) * 60, byteSize: 1 * KB });
    }
    insertBlock({ bucketStart: NOW_SEC - 30 * 86400, byteSize: 1 * KB });

    await runAgentBlockRetention(env, NOW_MS);
    // 过期块被删掉；热层没超预算所以原样保留
    expect(remainingBucketStarts().length).toBe(20);

    // 一分钟后的下一个 tick 不该再领到预算回收
    const claimed = await claimIntervalRun(
      env,
      INTERVAL_KEY_AGENT_BLOCK_BUDGET,
      60 * 60 * 1000,
      NOW_MS + 60_000
    );
    expect(claimed).toBe(false);
  });

  it("DB 抛异常时自己吞掉，不把异常抛给调用方", async () => {
    const brokenEnv = {
      DB: {
        prepare() {
          throw new Error("D1_ERROR: Exceeded maximum DB size");
        },
      },
    } as unknown as Bindings;

    await expect(runAgentBlockRetention(brokenEnv, NOW_MS)).resolves.toBeUndefined();
  });
});
