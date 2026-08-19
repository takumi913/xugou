import { useEffect, useMemo, useState } from "react";

import { createLiveSocket, type LiveAgentStatus } from "../utils/liveSocket";
import { mergeLatestMetric } from "../utils/metrics";
import type { MetricHistory } from "../types/agents";

interface LiveAgentState {
  metric: Partial<MetricHistory>;
  status?: LiveAgentStatus;
  lastSeenAt?: string | null;
  ts: number;
}

export interface LiveAgentMetrics {
  /** agent_id -> 实时叠加的指标增量 */
  liveMetrics: Record<number, Partial<MetricHistory>>;
  /** agent_id -> 实时状态与最后在线时间 */
  liveStatus: Record<
    number,
    { status?: LiveAgentStatus; lastSeenAt?: string | null }
  >;
  connected: boolean;
  lagSeconds: number;
  /** 把某个 agent 的基线指标与实时增量合并；没有实时数据时原样返回 */
  merge: (
    agentId: number,
    base: Partial<MetricHistory> | null | undefined
  ) => Partial<MetricHistory> | null | undefined;
}

/**
 * 订阅一组 Agent 的实时指标。
 *
 * 所有展示 Agent 指标的页面都应该走这里，避免出现「有的页面实时、有的页面
 * 要刷新才更新」的割裂——列表页此前就是只在 useQuery 轮询时才变。
 */
export function useLiveAgentMetrics(agentIds: number[]): LiveAgentMetrics {
  const [liveState, setLiveState] = useState<Record<number, LiveAgentState>>({});
  const [connected, setConnected] = useState(false);
  const [lagSeconds, setLagSeconds] = useState(0);

  // 用 id 列表的字符串形式做依赖，避免每次渲染新建数组导致反复重连
  const subscriptionKey = useMemo(
    () => Array.from(new Set(agentIds)).sort((a, b) => a - b).join(","),
    [agentIds]
  );

  useEffect(() => {
    setConnected(false);
    if (!subscriptionKey) return;
    const socket = createLiveSocket({
      subscribe: subscriptionKey.split(",").map(Number),
      onUpdate: ({ agentId, ts, data, status, lastSeenAt, lagSeconds: lag }) => {
        setLiveState((current) => {
          const previous = current[agentId];
          // 乱序到达的旧样本不能覆盖新样本
          if (previous && previous.ts > ts) return current;
          return {
            ...current,
            [agentId]: {
              metric: { ...previous?.metric, ...data },
              status: status ?? previous?.status,
              lastSeenAt:
                lastSeenAt !== undefined ? lastSeenAt : previous?.lastSeenAt,
              ts,
            },
          };
        });
        setLagSeconds(lag);
      },
      onStatusChange: ({ connected: isConnected }) => setConnected(isConnected),
    });
    return () => socket.close();
  }, [subscriptionKey]);

  const liveMetrics = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(liveState).map(([agentId, state]) => [
          Number(agentId),
          state.metric,
        ])
      ) as Record<number, Partial<MetricHistory>>,
    [liveState]
  );

  const liveStatus = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(liveState).map(([agentId, state]) => [
          Number(agentId),
          { status: state.status, lastSeenAt: state.lastSeenAt },
        ])
      ) as Record<
        number,
        { status?: LiveAgentStatus; lastSeenAt?: string | null }
      >,
    [liveState]
  );

  const merge = useMemo(
    () =>
      (agentId: number, base: Partial<MetricHistory> | null | undefined) => {
        const live = liveMetrics[agentId];
        return live ? mergeLatestMetric(base ?? undefined, live) : base;
      },
    [liveMetrics]
  );

  return { liveMetrics, liveStatus, connected, lagSeconds, merge };
}
