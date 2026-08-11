/**
 * Agent realtime publisher 与 AgentRoom 共用的指标实时 wire 类型。
 */

import type { Metrics } from "./agent";

// 广播样本的动态数据（剔除静态字段后的 Metrics 子集）
export type BroadcastMetricData = Partial<
  Omit<Metrics, "id" | "agent_id" | "cpu_cores" | "cpu_model">
>;

export interface BroadcastSample {
  ts: number;
  data: BroadcastMetricData;
  /** 匿名状态页使用的服务端白名单投影。 */
  publicData?: BroadcastMetricData;
}

export interface BroadcastUpdate {
  agentId: number;
  samples: BroadcastSample[];
  status?: "active" | "inactive";
  lastSeenAt?: string | null;
  changedAt?: string;
}
