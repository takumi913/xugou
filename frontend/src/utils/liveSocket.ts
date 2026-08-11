/**
 * WebSocket 实时指标客户端（基于 CF-Server-Monitor createLiveSocket 的订阅模型）。
 *
 * - 管理连接由浏览器自动携带 HttpOnly 会话 Cookie
 * - 多 Agent 自动按固定分片复用连接，避免每台机器各开一个 WebSocket
 * - 每个分片独立指数退避重连（1s 起，上限 30s）
 * - 30s 心跳发 ping，服务端 DO 在休眠状态自动回复 pong
 * - batchUpdate 按样本时间差分桶回放，状态变化则立即应用
 */

import { ENV_API_BASE_URL } from "../config";
import type { MetricHistory } from "../types/agents";

const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_REPLAY_DELAY_MS = 120000;
const REPLAY_BUCKET_MS = 250;
export const AGENT_REALTIME_SHARD_COUNT = 8;

export type LiveAgentStatus = "active" | "inactive";

export interface LiveSocketStatus {
  connected: boolean;
  reason?: string;
}

export interface LiveUpdate {
  agentId: number;
  ts: number;
  data: Partial<MetricHistory>;
  status?: LiveAgentStatus;
  lastSeenAt?: string | null;
  /** 回放滞后（秒）：emit 时刻与样本 ts 的差值，用于 UI 滞后标记 */
  lagSeconds: number;
}

export interface CreateLiveSocketOptions {
  /** 详情页传单个 ID；列表页传当前投影中的全部 Agent ID。 */
  subscribe: number | readonly number[];
  onUpdate?: (update: LiveUpdate) => void;
  onStatusChange?: (status: LiveSocketStatus) => void;
  /** 覆盖 WebSocket API URL（测试/独立 API 域名使用） */
  url?: string;
  /** 与当前 API Origin 同源的 WebSocket 路径。 */
  path?: string;
}

export interface LiveSocket {
  close: () => void;
  readonly isConnected: boolean;
}

interface BatchUpdateMessage {
  type?: string;
  ts?: number;
  updates?: Array<{
    agentId?: number;
    status?: LiveAgentStatus;
    lastSeenAt?: string | null;
    changedAt?: string;
    samples?: Array<{ ts?: number; data?: Partial<MetricHistory> }>;
  }>;
}

interface ShardConnection {
  agentIds: number[];
  ws: WebSocket | null;
  connected: boolean;
  reconnectDelay: number;
  reconnectTimer: number | null;
  heartbeatTimer: number | null;
}

interface ReplaySample {
  ts: number;
  data: Partial<MetricHistory>;
  status?: LiveAgentStatus;
  lastSeenAt?: string | null;
}

export function realtimeShardIndex(agentId: number): number {
  return (agentId - 1) % AGENT_REALTIME_SHARD_COUNT;
}

export function groupRealtimeSubscriptions(
  agentIds: readonly number[]
): number[][] {
  const groups = new Map<number, number[]>();
  const normalized = [...new Set(agentIds)]
    .filter((agentId) => Number.isSafeInteger(agentId) && agentId > 0)
    .sort((left, right) => left - right);
  for (const agentId of normalized) {
    const shard = realtimeShardIndex(agentId);
    const group = groups.get(shard) ?? [];
    group.push(agentId);
    groups.set(shard, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, ids]) => ids);
}

function buildWsUrl(
  agentIds: readonly number[],
  override?: string,
  path = "/api/ws"
): string {
  let base: URL;
  try {
    base = override
      ? new URL(override)
      : ENV_API_BASE_URL
        ? new URL(ENV_API_BASE_URL)
        : new URL(window.location.href);
  } catch {
    base = new URL(window.location.href);
  }

  const wsProtocol = base.protocol === "https:" ? "wss:" : "ws:";
  const url = override
    ? new URL(base.toString())
    : new URL(`${wsProtocol}//${base.host}${path}`);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  url.searchParams.set("subscribe", agentIds.join(","));
  return url.toString();
}

export function createLiveSocket(options: CreateLiveSocketOptions): LiveSocket {
  const { onUpdate, onStatusChange } = options;
  const requestedIds = Array.isArray(options.subscribe)
    ? options.subscribe
    : [options.subscribe];
  const subscriptionGroups = groupRealtimeSubscriptions(requestedIds);
  const connections: ShardConnection[] = subscriptionGroups.map((agentIds) => ({
    agentIds,
    ws: null,
    connected: false,
    reconnectDelay: RECONNECT_INITIAL_DELAY_MS,
    reconnectTimer: null,
    heartbeatTimer: null,
  }));
  const replayTimers = new Set<number>();
  let manualClose = false;
  let lastStatusKey = "";

  const notifyStatus = (reason?: string) => {
    const connected =
      connections.length > 0 &&
      connections.every((connection) => connection.connected);
    const active = connections.filter((connection) => connection.connected).length;
    const resolvedReason = connected
      ? "connected"
      : active > 0
        ? "partial"
        : reason ?? "disconnected";
    const key = `${connected}:${resolvedReason}:${active}/${connections.length}`;
    if (key === lastStatusKey) return;
    lastStatusKey = key;
    onStatusChange?.({ connected, reason: resolvedReason });
  };

  const clearReplayTimers = () => {
    replayTimers.forEach((timer) => window.clearTimeout(timer));
    replayTimers.clear();
  };

  const stopHeartbeat = (connection: ShardConnection) => {
    if (connection.heartbeatTimer !== null) {
      window.clearInterval(connection.heartbeatTimer);
      connection.heartbeatTimer = null;
    }
  };

  const startHeartbeat = (connection: ShardConnection) => {
    stopHeartbeat(connection);
    connection.heartbeatTimer = window.setInterval(() => {
      if (connection.ws?.readyState === WebSocket.OPEN) {
        try {
          connection.ws.send("ping");
        } catch {
          // close/error 事件负责后续重连。
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  const emitUpdate = (sample: ReplaySample, agentId: number) => {
    const lagSeconds = Math.max(0, (Date.now() - sample.ts) / 1000);
    const timestamp = new Date(sample.ts).toISOString();
    onUpdate?.({
      agentId,
      ts: sample.ts,
      data: { ...sample.data, timestamp: sample.data.timestamp ?? timestamp },
      status: sample.status,
      lastSeenAt: sample.lastSeenAt,
      lagSeconds,
    });
  };

  const replayBatch = (msg: BatchUpdateMessage) => {
    const updates = Array.isArray(msg.updates) ? msg.updates : [];
    const buckets = new Map<number, Map<number, ReplaySample>>();

    for (const update of updates) {
      const agentId = Number(update?.agentId);
      if (!Number.isSafeInteger(agentId) || agentId <= 0) continue;
      const status =
        update.status === "active" || update.status === "inactive"
          ? update.status
          : undefined;
      const rawSamples = (Array.isArray(update.samples) ? update.samples : [])
        .filter((sample) => sample && typeof sample.data === "object")
        .map((sample) => ({
          ts: Number(sample.ts) || Date.now(),
          data: sample.data as Partial<MetricHistory>,
        }))
        .sort((left, right) => left.ts - right.ts);
      const fallbackTs =
        (typeof update.changedAt === "string" && Date.parse(update.changedAt)) ||
        Number(msg.ts) ||
        Date.now();
      const samples =
        rawSamples.length > 0
          ? rawSamples
          : status
            ? [{ ts: fallbackTs, data: {} }]
            : [];
      if (samples.length === 0) continue;

      const firstTs = samples[0].ts;
      for (const sample of samples) {
        const delay = Math.max(
          0,
          Math.min(sample.ts - firstTs, MAX_REPLAY_DELAY_MS)
        );
        const bucketIndex = Math.floor(delay / REPLAY_BUCKET_MS);
        let bucket = buckets.get(bucketIndex);
        if (!bucket) {
          bucket = new Map();
          buckets.set(bucketIndex, bucket);
        }
        bucket.set(agentId, {
          ...sample,
          status,
          lastSeenAt: update.lastSeenAt,
        });
      }
    }

    for (const [bucketIndex, bucket] of buckets) {
      const timer = window.setTimeout(() => {
        replayTimers.delete(timer);
        bucket.forEach((sample, agentId) => emitUpdate(sample, agentId));
      }, bucketIndex * REPLAY_BUCKET_MS);
      replayTimers.add(timer);
    }
  };

  const connect = (connection: ShardConnection) => {
    if (manualClose) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(
        buildWsUrl(connection.agentIds, options.url, options.path)
      );
      connection.ws = socket;
    } catch {
      connection.connected = false;
      notifyStatus("unsupported");
      return;
    }

    socket.addEventListener("open", () => {
      if (connection.ws !== socket || manualClose) return;
      connection.connected = true;
      connection.reconnectDelay = RECONNECT_INITIAL_DELAY_MS;
      startHeartbeat(connection);
      notifyStatus();
    });

    socket.addEventListener("message", (event) => {
      if (connection.ws !== socket) return;
      if (typeof event.data !== "string" || event.data === "pong") return;
      let msg: BatchUpdateMessage;
      try {
        msg = JSON.parse(event.data) as BatchUpdateMessage;
      } catch {
        return;
      }
      if (msg.type === "batchUpdate") replayBatch(msg);
    });

    socket.addEventListener("close", () => {
      if (connection.ws !== socket) return;
      stopHeartbeat(connection);
      connection.ws = null;
      connection.connected = false;
      notifyStatus("disconnected");
      if (manualClose || connection.reconnectTimer !== null) return;
      const delay = connection.reconnectDelay;
      connection.reconnectDelay = Math.min(
        connection.reconnectDelay * 2,
        RECONNECT_MAX_DELAY_MS
      );
      connection.reconnectTimer = window.setTimeout(() => {
        connection.reconnectTimer = null;
        connect(connection);
      }, delay);
    });

    socket.addEventListener("error", () => {
      if (connection.ws !== socket) return;
      connection.connected = false;
      notifyStatus("error");
      try {
        socket.close();
      } catch {
        // close 事件负责后续重连。
      }
    });
  };

  for (const connection of connections) connect(connection);
  if (connections.length === 0) notifyStatus("empty");

  return {
    close() {
      manualClose = true;
      clearReplayTimers();
      for (const connection of connections) {
        stopHeartbeat(connection);
        if (connection.reconnectTimer !== null) {
          window.clearTimeout(connection.reconnectTimer);
          connection.reconnectTimer = null;
        }
        const socket = connection.ws;
        connection.ws = null;
        connection.connected = false;
        try {
          socket?.close();
        } catch {
          // 页面卸载时忽略连接关闭竞争。
        }
      }
    },
    get isConnected() {
      return (
        connections.length > 0 &&
        connections.every((connection) => connection.connected)
      );
    },
  };
}
