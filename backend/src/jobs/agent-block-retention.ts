import type { Bindings } from "../models/db";
import { writeStructuredLog } from "../platform/observability/StructuredLogger";
import { getEnvNumber } from "../utils/env";
import {
  claimIntervalRun,
  HOURLY_INTERVAL_MS,
  INTERVAL_KEY_AGENT_BLOCK_BUDGET,
} from "./interval-gate";

/** 250 MB。resolution=1 热层预算，实测约覆盖 41.5 小时 / 40 台。 */
export const DEFAULT_AGENT_BLOCK_HOT_BUDGET_BYTES = 262_144_000;
export const DEFAULT_AGENT_BLOCK_MAX_AGE_DAYS = 7;
export const DEFAULT_AGENT_BLOCK_GC_BATCH = 500;

/** 单次预算回收最多删多少批，防止一次 cron 调用被 GC 占满时间预算。 */
const MAX_BUDGET_PASSES = 20;
/** 单条 DELETE 里最多绑定多少个 rowid。 */
const DELETE_CHUNK = 50;

export function agentBlockRetentionConfig(env: Bindings) {
  return {
    budgetBytes: getEnvNumber(
      env,
      "AGENT_BLOCK_HOT_BUDGET_BYTES",
      DEFAULT_AGENT_BLOCK_HOT_BUDGET_BYTES,
      { min: 1_048_576, max: 4_294_967_296 }
    ),
    maxAgeDays: getEnvNumber(
      env,
      "AGENT_BLOCK_MAX_AGE_DAYS",
      DEFAULT_AGENT_BLOCK_MAX_AGE_DAYS,
      { min: 1, max: 365 }
    ),
    gcBatch: getEnvNumber(env, "AGENT_BLOCK_GC_BATCH", DEFAULT_AGENT_BLOCK_GC_BATCH, {
      min: 1,
      max: 5000,
    }),
  };
}

/**
 * 规则 1：按年龄删除。走 (resolution, bucket_start) 的 gc 索引，成本低，每个 tick 都跑。
 */
export async function pruneAgedAgentBlocks(
  env: Bindings,
  nowMs: number = Date.now()
) {
  const { maxAgeDays } = agentBlockRetentionConfig(env);
  const cutoff = Math.floor(nowMs / 1000) - maxAgeDays * 86_400;
  const result = await env.DB.prepare(
    `DELETE FROM agent_metric_blocks WHERE bucket_start < ?`
  )
    .bind(cutoff)
    .run();
  return { deleted: result.meta?.changes ?? 0, cutoff };
}

interface BudgetRow {
  n: number | null;
  bytes: number | null;
}

interface VictimRow {
  rowid: number;
  byte_size: number;
}

/**
 * 规则 2：按字节预算删除最旧的 1 秒块。
 *
 * 这条规则的价值在于不需要预测压缩比——压得好就多存几小时，压得差就少存几小时，
 * 但永远不会撑爆。估算错误的后果从「整站瘫痪」降级成「历史短一点」。
 */
export async function enforceAgentBlockBudget(env: Bindings) {
  const { budgetBytes, gcBatch } = agentBlockRetentionConfig(env);
  const before = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(byte_size), 0) AS bytes
     FROM agent_metric_blocks WHERE resolution = 1`
  ).first<BudgetRow>();

  const bytesBefore = Number(before?.bytes ?? 0);
  let excess = bytesBefore - budgetBytes;
  let deleted = 0;
  let freed = 0;

  for (let pass = 0; excess > 0 && pass < MAX_BUDGET_PASSES; pass++) {
    // 只读回 rowid 与 byte_size：按最旧优先累计到刚好覆盖超额部分，
    // 一次 DELETE 打包提交，避免「删一批再重算 SUM」的反复全表扫描。
    const { results } = await env.DB.prepare(
      `SELECT rowid AS rowid, byte_size
       FROM agent_metric_blocks
       WHERE resolution = 1
       ORDER BY bucket_start ASC
       LIMIT ?`
    )
      .bind(gcBatch)
      .all<VictimRow>();
    if (results.length === 0) break;

    const victims: number[] = [];
    let passFreed = 0;
    for (const row of results) {
      victims.push(Number(row.rowid));
      passFreed += Number(row.byte_size) || 0;
      if (passFreed >= excess) break;
    }

    // D1 对单条语句的绑定参数个数有上限，按 50 个 rowid 一条语句切分后合并成一个 batch。
    const statements = [];
    for (let offset = 0; offset < victims.length; offset += DELETE_CHUNK) {
      const chunk = victims.slice(offset, offset + DELETE_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      statements.push(
        env.DB.prepare(
          `DELETE FROM agent_metric_blocks WHERE rowid IN (${placeholders})`
        ).bind(...chunk)
      );
    }
    const batchResult = await env.DB.batch(statements);
    const changes = batchResult.reduce(
      (total, row) => total + (row.meta?.changes ?? 0),
      0
    );
    deleted += changes;
    freed += passFreed;
    excess -= passFreed;
    // 这一批没能覆盖超额部分，说明还得再取一批；取不满 gcBatch 则已无更多可删。
    if (results.length < gcBatch) break;
  }

  return {
    bytesBefore,
    bytesAfter: bytesBefore - freed,
    budgetBytes,
    blocksBefore: Number(before?.n ?? 0),
    deleted,
    freed,
    converged: bytesBefore - freed <= budgetBytes,
  };
}

/**
 * 每个 cron tick 调用：年龄删除总是跑，预算回收每小时跑一次。
 * 内部自行吞掉异常并记日志——保留策略失败不应该再次拖垮整条 cron 链路。
 */
export async function runAgentBlockRetention(
  env: Bindings,
  nowMs: number = Date.now()
) {
  try {
    const aged = await pruneAgedAgentBlocks(env, nowMs);
    if (aged.deleted > 0) {
      writeStructuredLog(env, {
        service: "cron",
        operation: "agent_block_prune_aged",
        result: "success",
        fields: { deleted: aged.deleted, cutoff: aged.cutoff },
      });
    }
  } catch (error) {
    writeStructuredLog(env, {
      service: "cron",
      operation: "agent_block_prune_aged",
      result: "failure",
      errorCode: "AGENT_BLOCK_PRUNE_AGED_FAILED",
      error,
    });
  }

  try {
    const claimed = await claimIntervalRun(
      env,
      INTERVAL_KEY_AGENT_BLOCK_BUDGET,
      HOURLY_INTERVAL_MS,
      nowMs
    );
    if (!claimed) return;
    const budget = await enforceAgentBlockBudget(env);
    if (budget.deleted > 0 || !budget.converged) {
      writeStructuredLog(env, {
        service: "cron",
        operation: "agent_block_budget_gc",
        result: budget.converged ? "success" : "deferred",
        fields: {
          budget_bytes: budget.budgetBytes,
          bytes_before: budget.bytesBefore,
          bytes_after: budget.bytesAfter,
          blocks_before: budget.blocksBefore,
          deleted: budget.deleted,
        },
      });
    }
  } catch (error) {
    writeStructuredLog(env, {
      service: "cron",
      operation: "agent_block_budget_gc",
      result: "failure",
      errorCode: "AGENT_BLOCK_BUDGET_GC_FAILED",
      error,
    });
  }
}
