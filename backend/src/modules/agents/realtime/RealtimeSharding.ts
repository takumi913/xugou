/**
 * 实时房间按 Agent ID 固定分片。Dashboard 最多建立 SHARD_COUNT 条连接，
 * Agent 上报也只命中一个房间，避免单个全局 Durable Object 成为热点。
 */
export const AGENT_REALTIME_SHARD_COUNT = 8;
const MAX_SUBSCRIBED_AGENTS = 200;

export function realtimeShardIndex(agentId: number): number {
  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    throw new TypeError("agentId must be a positive safe integer");
  }
  return (agentId - 1) % AGENT_REALTIME_SHARD_COUNT;
}

export function realtimeRoomName(agentId: number): string {
  return `agent-shard:${realtimeShardIndex(agentId)}`;
}

export function parseAgentRoomSubscriptions(
  raw: string | undefined
): number[] | null {
  if (!raw || raw.length > 2_048 || raw.trim().toLowerCase() === "all") {
    return null;
  }
  const ids = [
    ...new Set(
      raw.split(",").map((value) => {
        const agentId = Number(value);
        return Number.isSafeInteger(agentId) && agentId > 0 ? agentId : null;
      })
    ),
  ];
  if (
    ids.length === 0 ||
    ids.length > MAX_SUBSCRIBED_AGENTS ||
    ids.some((agentId) => agentId === null)
  ) {
    return null;
  }
  const agentIds = (ids as number[]).sort((left, right) => left - right);
  const shard = realtimeShardIndex(agentIds[0]);
  return agentIds.every((agentId) => realtimeShardIndex(agentId) === shard)
    ? agentIds
    : null;
}

/** 保留单 Agent 解析入口，供详情页契约使用。 */
export function parseAgentRoomSubscription(
  raw: string | undefined
): number | null {
  const agentIds = parseAgentRoomSubscriptions(raw);
  return agentIds?.length === 1 ? agentIds[0] : null;
}
