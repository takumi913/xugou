/**
 * 按时间窗口读取指标块并还原成样本序列。
 *
 * 状态页与仪表盘共用本层，两处都不再直接碰 agent_metric_blocks。
 */

import type { Bindings } from "../../../models/db";
import { writeStructuredLog } from "../../../platform/observability/StructuredLogger";
import { decodeBlock } from "./decode";
import { blockSamples, type BlockSample } from "./materialize";

/**
 * 窗口超过这个跨度就改查 1 分钟层。
 *
 * 依据：图表宽度约 1500 px，1 秒精度超过约 25 分钟就必然要降采样，
 * 与其读 60 倍的块再丢掉，不如直接读聚合层。
 */
export const HOT_WINDOW_SECONDS = 25 * 60;

/** 单次查询最多读取的块数，防止超大窗口把 Worker 拖垮。 */
const MAX_BLOCKS_PER_QUERY = 400;

/** 返回给图表的点数上限。 */
export const MAX_CHART_POINTS = 2000;

export type Resolution = 1 | 60;

/** 一个块覆盖的秒数：1 秒块跨 1 分钟，1 分钟块跨 1 小时。 */
function bucketSpan(resolution: Resolution): number {
  return resolution * 60;
}

export function pickResolution(fromSec: number, toSec: number): Resolution {
  return toSec - fromSec <= HOT_WINDOW_SECONDS ? 1 : 60;
}

export interface AgentSampleWindow {
  resolution: Resolution;
  samples: BlockSample[];
  /** 因解码失败被跳过的块数，非 0 说明存储里有损坏数据。 */
  corruptBlocks: number;
}

interface BlockRow {
  agent_id: number;
  bucket_start: number;
  data: ArrayBuffer | Uint8Array;
}

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * 批量读取多个 agent 的样本，一次 D1 往返。
 *
 * 状态页要同时渲染多台机器，逐个查会把往返次数放大到 agent 数量。
 */
export async function queryAgentSamplesBatch(
  env: Bindings,
  agentIds: number[],
  fromSec: number,
  toSec: number,
  options: { resolution?: Resolution; aggregate?: number } = {}
): Promise<Map<number, BlockSample[]>> {
  const result = new Map<number, BlockSample[]>();
  if (agentIds.length === 0) return result;

  const resolution = options.resolution ?? pickResolution(fromSec, toSec);
  const span = bucketSpan(resolution);
  const rows = await env.DB.prepare(
    `SELECT agent_id, bucket_start, data
     FROM agent_metric_blocks
     WHERE agent_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
       AND resolution = ? AND bucket_start >= ? AND bucket_start <= ?
     ORDER BY agent_id ASC, bucket_start ASC
     LIMIT ?`
  )
    .bind(
      JSON.stringify(agentIds),
      resolution,
      fromSec - span,
      toSec,
      MAX_BLOCKS_PER_QUERY * agentIds.length
    )
    .all<BlockRow>();

  for (const row of rows.results) {
    let decoded;
    try {
      decoded = await decodeBlock(toBytes(row.data));
    } catch (error) {
      // 单个坏块不该让整张图空掉
      writeStructuredLog(env, {
        service: "http",
        operation: "decode_metric_block",
        result: "failure",
        entityType: "agent",
        entityId: row.agent_id,
        errorCode: "METRIC_BLOCK_DECODE_FAILED",
        fields: { bucket_start: row.bucket_start, resolution },
        error,
      });
      continue;
    }
    const bucket = result.get(row.agent_id) ?? [];
    for (const sample of blockSamples(decoded, options.aggregate ?? 0)) {
      const sec = sample.timestampMs / 1000;
      if (sec < fromSec || sec > toSec) continue;
      bucket.push(sample);
    }
    result.set(row.agent_id, bucket);
  }

  for (const samples of result.values()) {
    samples.sort((left, right) => left.timestampMs - right.timestampMs);
  }
  return result;
}

/**
 * 读取 [fromSec, toSec] 内的样本。
 *
 * `aggregate` 只对 1 分钟层有意义：0=avg（默认）、1=min、2=max。
 */
export async function queryAgentSamples(
  env: Bindings,
  agentId: number,
  fromSec: number,
  toSec: number,
  options: { resolution?: Resolution; aggregate?: number } = {}
): Promise<AgentSampleWindow> {
  const resolution = options.resolution ?? pickResolution(fromSec, toSec);
  const span = bucketSpan(resolution);

  // 起点前推一个桶跨度，把跨越窗口左边界的块也捞进来
  const rows = await env.DB.prepare(
    `SELECT bucket_start, data
     FROM agent_metric_blocks
     WHERE agent_id = ? AND resolution = ?
       AND bucket_start >= ? AND bucket_start <= ?
     ORDER BY bucket_start ASC
     LIMIT ?`
  )
    .bind(agentId, resolution, fromSec - span, toSec, MAX_BLOCKS_PER_QUERY)
    .all<BlockRow>();

  const samples: BlockSample[] = [];
  let corruptBlocks = 0;

  for (const row of rows.results) {
    try {
      const decoded = await decodeBlock(toBytes(row.data));
      for (const sample of blockSamples(decoded, options.aggregate ?? 0)) {
        const sec = sample.timestampMs / 1000;
        if (sec < fromSec || sec > toSec) continue;
        samples.push(sample);
      }
    } catch (error) {
      // 单个坏块不该让整张图空掉：跳过它，记日志，其余照常返回
      corruptBlocks++;
      writeStructuredLog(env, {
        // 读路径都由 HTTP 请求驱动
        service: "http",
        operation: "decode_metric_block",
        result: "failure",
        entityType: "agent",
        entityId: agentId,
        errorCode: "METRIC_BLOCK_DECODE_FAILED",
        fields: { bucket_start: row.bucket_start, resolution },
        error,
      });
    }
  }

  samples.sort((left, right) => left.timestampMs - right.timestampMs);
  return { resolution, samples, corruptBlocks };
}

/**
 * 等距抽样到不超过 maxPoints 个点，并始终保留最后一个点
 * （最新数据点是用户最关心的，不能因为步长对不齐被丢掉）。
 */
export function downsample<T>(items: T[], maxPoints: number): T[] {
  if (maxPoints <= 0 || items.length <= maxPoints) return items;
  const step = Math.ceil(items.length / maxPoints);
  const out: T[] = [];
  for (let i = 0; i < items.length; i += step) out.push(items[i]);
  const last = items[items.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}
