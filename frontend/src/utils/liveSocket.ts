/**
 * WebSocket 实时指标客户端（参照 CF-Server-Monitor createLiveSocket 移植）
 *
 * - token 从 localStorage 取（与 AuthProvider/api client 一致），以 ?token= 携带
 * - 断线指数退避重连（1s 起，上限 30s）
 * - 30s 心跳发 'ping'（服务端 DO 通过 setWebSocketAutoResponse 自动回 'pong'）
 * - 收到 batchUpdate 按样本 ts 差值分时间桶合并回放（上限 120s，超出直接套用）
 */

import { ENV_API_BASE_URL } from "../config";
import { getStoredToken } from "../api/client";
import type { MetricHistory } from "../types/agents";

const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_REPLAY_DELAY_MS = 120000;
// 回放合并调度粒度：同一时间桶内的样本共用一个 timer
const REPLAY_BUCKET_MS = 250;

export interface LiveSocketStatus {
  connected: boolean;
  reason?: string;
}

export interface LiveUpdate {
  agentId: number;
  ts: number;
  data: Partial<MetricHistory>;
  /** 回放滞后（秒）：emit 时刻与样本 ts 的差值，用于 UI 滞后标记 */
  lagSeconds: number;
}

export interface CreateLiveSocketOptions {
  /** 订阅范围："all" 或 agent id 列表 */
  subscribe: "all" | number[];
  /**
   * 公开状态页模式：以 ?public=<userId> 匿名连接（不携带 token），
   * 服务端把可接收范围强制限定为该用户状态页勾选且未隐藏的客户端
   */
  publicUserId?: number;
  onUpdate?: (update: LiveUpdate) => void;
  onStatusChange?: (status: LiveSocketStatus) => void;
  /** 覆盖 WebSocket URL（默认由 API 基地址 / 当前页面推导） */
  url?: string;
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
    samples?: Array<{ ts?: number; data?: Partial<MetricHistory> }>;
  }>;
}

function buildWsUrl(
  subscribeParam: string,
  override?: string,
  publicUserId?: number
): string {
  if (override) return override;

  let base: URL;
  try {
    base = ENV_API_BASE_URL
      ? new URL(ENV_API_BASE_URL)
      : new URL(window.location.href);
  } catch {
    base = new URL(window.location.href);
  }

  const wsProtocol = base.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${wsProtocol}//${base.host}/api/ws`);
  url.searchParams.set("subscribe", subscribeParam);

  if (publicUserId != null) {
    // 公开状态页模式：匿名连接，不携带 token
    url.searchParams.set("public", String(publicUserId));
    return url.toString();
  }

  const token = getStoredToken();
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

export function createLiveSocket(options: CreateLiveSocketOptions): LiveSocket {
  const { onUpdate, onStatusChange } = options;
  const agentIds = Array.isArray(options.subscribe) ? options.subscribe : [];
  const scope: "all" | "ids" = Array.isArray(options.subscribe) ? "ids" : "all";
  const subscribeParam = scope === "all" ? "all" : agentIds.join(",");

  let ws: WebSocket | null = null;
  let manualClose = false;
  let isConnected = false;
  let reconnectDelay = RECONNECT_INITIAL_DELAY_MS;
  let reconnectTimer: number | null = null;
  let heartbeatTimer: number | null = null;
  const replayTimers = new Set<number>();

  const setStatus = (connected: boolean, reason?: string) => {
    isConnected = connected;
    onStatusChange?.({ connected, reason });
  };

  const clearReplayTimers = () => {
    replayTimers.forEach((timer) => window.clearTimeout(timer));
    replayTimers.clear();
  };

  const stopHeartbeat = () => {
    if (heartbeatTimer !== null) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    heartbeatTimer = window.setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send("ping");
        } catch {
          // 忽略心跳发送失败，交给 close/error 事件处理
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  const emitUpdate = (agentId: number, ts: number, data: Partial<MetricHistory>) => {
    // 滞后 = emit 时刻与样本时间戳的差值（回放/网络延迟叠加），负值按 0 计
    const lagSeconds = Math.max(0, (Date.now() - ts) / 1000);
    onUpdate?.({ agentId, ts, data, lagSeconds });
  };

  // 按样本 ts 差值分时间桶（REPLAY_BUCKET_MS 粒度）合并回放：
  // 同桶一个 timer，回调里每个 agent 只 emit 桶内最后一个样本（中间样本对 UI 无意义），
  // 超过上限的直接按上限套用（即立即追平最新）
  const replayBatch = (msg: BatchUpdateMessage) => {
    const updates = Array.isArray(msg.updates) ? msg.updates : [];
    // 桶序号 -> (agentId -> 桶内最后一个样本)
    const buckets = new Map<
      number,
      Map<number, { ts: number; data: Partial<MetricHistory> }>
    >();

    for (const update of updates) {
      const agentId = Number(update?.agentId);
      if (!Number.isInteger(agentId) || agentId <= 0) continue;

      const samples = (Array.isArray(update.samples) ? update.samples : [])
        .filter((sample) => sample && typeof sample.data === "object")
        .map((sample) => ({
          ts: Number(sample.ts) || Date.now(),
          data: sample.data as Partial<MetricHistory>,
        }))
        .sort((a, b) => a.ts - b.ts);
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
        // samples 已按 ts 升序，后写入的即桶内最后一个样本
        bucket.set(agentId, sample);
      }
    }

    for (const [bucketIndex, bucket] of buckets) {
      const timer = window.setTimeout(() => {
        replayTimers.delete(timer);
        bucket.forEach((sample, agentId) =>
          emitUpdate(agentId, sample.ts, sample.data)
        );
      }, bucketIndex * REPLAY_BUCKET_MS);
      replayTimers.add(timer);
    }
  };

  const scheduleReconnect = () => {
    if (manualClose || reconnectTimer !== null) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (manualClose) return;
    try {
      ws = new WebSocket(
        buildWsUrl(subscribeParam, options.url, options.publicUserId)
      );
    } catch {
      setStatus(false, "unsupported");
      return;
    }

    ws.addEventListener("open", () => {
      reconnectDelay = RECONNECT_INITIAL_DELAY_MS;
      try {
        ws?.send(JSON.stringify({ type: "subscribe", scope, agentIds }));
      } catch {
        // 忽略订阅消息发送失败
      }
      startHeartbeat();
      setStatus(true, "connected");
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data === "pong") return;
      let msg: BatchUpdateMessage | null = null;
      try {
        msg = JSON.parse(event.data) as BatchUpdateMessage;
      } catch {
        return;
      }
      if (msg?.type === "batchUpdate") {
        replayBatch(msg);
      }
    });

    ws.addEventListener("close", () => {
      stopHeartbeat();
      setStatus(false, "disconnected");
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      setStatus(false, "error");
      try {
        ws?.close();
      } catch {
        // 忽略关闭失败
      }
    });
  };

  // 统一拆卸序列：清回放/心跳/重连定时器并关闭连接
  const teardown = () => {
    clearReplayTimers();
    stopHeartbeat();
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        // 忽略关闭失败
      }
      ws = null;
    }
  };

  connect();

  return {
    close() {
      manualClose = true;
      teardown();
    },
    get isConnected() {
      return isConnected;
    },
  };
}
