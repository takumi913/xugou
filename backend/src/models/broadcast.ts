/**
 * 指标实时广播的 wire 类型（Worker 侧 BroadcastService 与 DO 侧
 * MetricsBroadcaster 共用的单一事实源）。
 */

import type { Metrics } from "./agent";

// 广播样本的动态数据（剔除静态字段后的 Metrics 子集）
export type BroadcastMetricData = Partial<
  Omit<Metrics, "id" | "agent_id" | "cpu_cores" | "cpu_model">
>;

export interface BroadcastSample {
  ts: number;
  data: BroadcastMetricData;
}

export interface BroadcastUpdate {
  agentId: number;
  samples: BroadcastSample[];
}
