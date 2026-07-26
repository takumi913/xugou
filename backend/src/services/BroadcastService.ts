/**
 * 指标实时广播服务
 *
 * 移植自 CF-Server-Monitor 的 queueBroadcastSamples：
 * - 模块级批量队列 + 5 秒窗口合并，减少对 Durable Object 的请求次数
 * - 通过 executionCtx.waitUntil 在响应返回后异步 flush 到 DO 的 /batch-push
 * - 任何失败都静默降级，绝不影响 Agent 上报主链路
 */

import type { DurableObjectNamespaceLike } from "../models/db";
import type { Metrics } from "../models/agent";
import type {
  BroadcastMetricData,
  BroadcastSample,
  BroadcastUpdate,
} from "../models/broadcast";
import { MAX_REPORT_SAMPLES } from "../utils/agentConfig";

export type {
  BroadcastMetricData,
  BroadcastSample,
  BroadcastUpdate,
} from "../models/broadcast";

const BATCH_WINDOW_MS = 5000;

export interface BroadcastEnv {
  METRICS_BROADCASTER?: DurableObjectNamespaceLike;
}

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface LatestReportUpdate {
  agentId: number;
  reportTs: number;
  reportAgeMs?: number;
  samples: BroadcastSample[];
}

// 广播时剔除的静态字段（hostname/os 等不在 Metrics 内；这里剔除表内静态列）
const BROADCAST_STATIC_FIELDS = ["id", "agent_id", "cpu_cores", "cpu_model"] as const;

// 模块级批量队列：agentId -> 待广播样本
let batchQueue = new Map<number, BroadcastSample[]>();
let flushingPromise: Promise<void> | null = null;

function getBroadcasterStub(env: BroadcastEnv | undefined) {
  const namespace = env?.METRICS_BROADCASTER;
  if (!namespace) return null;
  return namespace.get(namespace.idFromName("global"));
}

/**
 * 将一条落库指标转换为广播样本（剔除静态字段，只保留动态指标）
 */
export function toBroadcastSample(metric: Metrics): BroadcastSample {
  const data: Record<string, unknown> = { ...metric };
  for (const field of BROADCAST_STATIC_FIELDS) {
    delete data[field];
  }
  const ts = Date.parse(metric.timestamp);
  return {
    ts: Number.isFinite(ts) ? ts : Date.now(),
    data: data as BroadcastMetricData,
  };
}

async function flushBatch(env: BroadcastEnv | undefined): Promise<void> {
  flushingPromise = null;
  if (batchQueue.size === 0) return;

  // 原子性地取出当前队列，避免并发写入干扰
  const queue = batchQueue;
  batchQueue = new Map();

  const updates: BroadcastUpdate[] = [];
  for (const [agentId, samples] of queue) {
    if (samples.length > 0) {
      updates.push({ agentId, samples });
    }
  }
  if (updates.length === 0) return;

  try {
    const stub = getBroadcasterStub(env);
    if (!stub) return;
    await stub.fetch("http://internal/batch-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
  } catch (error) {
    console.warn(
      "[broadcast] batch push failed:",
      error instanceof Error ? error.message : error
    );
  }
}

function ensureBatchFlush(env: BroadcastEnv | undefined): Promise<void> {
  if (flushingPromise) return flushingPromise;
  flushingPromise = new Promise<void>((resolve) =>
    setTimeout(resolve, BATCH_WINDOW_MS)
  ).then(() => flushBatch(env));
  return flushingPromise;
}

/**
 * 将样本加入批量队列，并确保在 5 秒窗口后 flush 到 DO。
 * 任何异常都被吞掉，不影响上报主链路。
 */
export function queueMetricsBroadcast(
  env: BroadcastEnv | undefined,
  executionCtx: WaitUntilContext | undefined,
  agentId: number,
  samples: BroadcastSample[]
): void {
  try {
    if (!env?.METRICS_BROADCASTER) return;
    if (!Number.isInteger(agentId) || agentId <= 0 || samples.length === 0) {
      return;
    }

    const existing = batchQueue.get(agentId);
    const merged = existing ? existing.concat(samples) : samples.slice();
    batchQueue.set(agentId, merged.slice(-MAX_REPORT_SAMPLES));

    const flushing = ensureBatchFlush(env);
    if (executionCtx) {
      executionCtx.waitUntil(flushing);
    } else {
      // 没有 executionCtx（如本地测试）时尽力而为
      void flushing.catch(() => undefined);
    }
  } catch (error) {
    console.warn(
      "[broadcast] queue failed:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * 读取 DO 内存中每个 agent 的最近一包上报（供列表接口首屏接续）。
 * DO 不可用或响应异常时返回空数组，静默降级。
 */
export async function fetchLatestReportUpdates(
  env: BroadcastEnv | undefined,
  agentIds: number[]
): Promise<LatestReportUpdate[]> {
  try {
    const stub = getBroadcasterStub(env);
    if (!stub || agentIds.length === 0) return [];

    const url = `http://internal/latest-report-updates?agentIds=${agentIds.join(",")}`;
    const response = await stub.fetch(url);
    if (!response.ok) return [];

    const body = (await response.json()) as { updates?: unknown };
    if (!Array.isArray(body.updates)) return [];

    const updates: LatestReportUpdate[] = [];
    for (const item of body.updates) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const agentId = Number(record.agentId);
      const reportTs = Number(record.reportTs);
      if (!Number.isInteger(agentId) || !Number.isFinite(reportTs)) continue;
      const samples = Array.isArray(record.samples)
        ? (record.samples as BroadcastSample[]).filter(
            (sample) =>
              sample &&
              typeof sample === "object" &&
              Number.isFinite(Number(sample.ts)) &&
              sample.data !== null &&
              typeof sample.data === "object"
          )
        : [];
      if (samples.length === 0) continue;
      updates.push({ agentId, reportTs, samples });
    }
    return updates;
  } catch (error) {
    console.warn(
      "[broadcast] fetch latest report updates failed:",
      error instanceof Error ? error.message : error
    );
    return [];
  }
}
