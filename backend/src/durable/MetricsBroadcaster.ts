// Durable Object: 客户端指标广播中心
// 负责维护 WebSocket 连接并在收到新指标时向订阅者实时推送
//
// - Worker 侧 GET /api/ws 完成 JWT 鉴权后转发到本 DO 的 /ws
//   subscribe = 'all'          -> 订阅全部（受 X-Allowed-Agent-Ids 限制）
//   subscribe = '<id,id,...>'  -> 只订阅指定 agent
// - Worker 在指标落库成功后调用 /batch-push 批量推送
// - 使用 DO WebSocket Hibernation API，闲置时休眠以节省资源；
//   通过 setWebSocketAutoResponse 自动响应 ping，无需唤醒 DO。

import type {
  BroadcastMetricData,
  BroadcastSample,
  BroadcastUpdate,
} from "../models/broadcast";
import { MAX_REPORT_SAMPLES } from "../utils/agentConfig";

export type { BroadcastSample, BroadcastUpdate } from "../models/broadcast";

const MAX_SUBSCRIBE_IDS = 500;
const WS_POLICY_VIOLATION = 1008;
const LATEST_REPORT_TTL_MS = 5 * 60 * 1000;
const MAX_LATEST_REPORT_AGENTS = 1000;

// ── Cloudflare Workers 运行时的最小结构化类型（避免引入全局 workers-types 声明冲突）──
export interface HibernatableWebSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(attachment: unknown): void;
  deserializeAttachment(): unknown;
}

export interface MetricsBroadcasterState {
  acceptWebSocket(ws: HibernatableWebSocket): void;
  getWebSockets(): HibernatableWebSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
}

// 运行时全局构造器（由 workerd 提供）
declare const WebSocketPair: new () => Record<string, HibernatableWebSocket>;
declare const WebSocketRequestResponsePair: new (
  request: string,
  response: string
) => unknown;

export type SubscriptionScope = "all" | "ids";

interface SubscriptionAttachment {
  scope: SubscriptionScope;
  agentIds: number[];
  // 允许接收的 agent id 列表；null 表示不受限（admin）
  allowedAgentIds: number[] | null;
}

interface LatestReportEntry extends BroadcastUpdate {
  reportTs: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function normalizeAgentId(value: unknown): number | null {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function normalizeAgentIds(value: unknown): number[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SUBSCRIBE_IDS) return null;
  const seen = new Set<number>();
  for (const item of value) {
    const id = normalizeAgentId(item);
    if (id === null) return null;
    seen.add(id);
  }
  return Array.from(seen);
}

function parseAgentIdListParam(raw: string): number[] | null {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return normalizeAgentIds(parts);
}

export class MetricsBroadcaster {
  private state: MetricsBroadcasterState;
  // 仅用于新页面快速接上最近一包数据；DO 重启后允许自然丢失
  private latestReportUpdates = new Map<number, LatestReportEntry>();

  constructor(state: MetricsBroadcasterState) {
    this.state = state;
    // 自动响应 ping 心跳，DO 无需被唤醒
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/ws") {
      return this.handleWebSocketUpgrade(request, url);
    }

    if (method === "POST" && path === "/batch-push") {
      return this.handleBatchPush(request);
    }

    if (method === "GET" && path === "/latest-report-updates") {
      return this.handleLatestReportUpdates(url);
    }

    if (method === "GET" && path === "/health") {
      return jsonResponse({
        ok: true,
        subscribers: this.state.getWebSockets().length,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  // ── WebSocket 接入 ─────────────────────────────────────
  private handleWebSocketUpgrade(request: Request, url: URL): Response {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade request", { status: 426 });
    }

    const subscription = this.parseSubscribeParam(
      url.searchParams.get("subscribe") ?? "all"
    );
    if (!subscription) {
      return new Response("Invalid subscription scope", { status: 400 });
    }

    const allowedAgentIds = this.parseAllowedAgentIds(
      request.headers.get("X-Allowed-Agent-Ids")
    );

    const pair = new WebSocketPair();
    const client = pair["0"];
    const server = pair["1"];

    // 使用 DO WebSocket Hibernation API 接管连接
    this.state.acceptWebSocket(server);

    // 订阅状态附加到 WebSocket（休眠后仍保留）
    const attachment: SubscriptionAttachment = {
      scope: subscription.scope,
      agentIds: subscription.agentIds,
      allowedAgentIds,
    };
    server.serializeAttachment(attachment);

    try {
      server.send(
        JSON.stringify({
          type: "hello",
          ts: Date.now(),
          subscribed: subscription.scope,
          count: subscription.agentIds.length,
        })
      );
    } catch {
      // 忽略发送失败
    }

    const responseHeaders = new Headers();
    // 客户端通过 Sec-WebSocket-Protocol 携带 token 时，需要回显协议，否则浏览器会断开
    const echoProtocol = request.headers.get("X-Echo-Protocol");
    if (echoProtocol) {
      responseHeaders.set("Sec-WebSocket-Protocol", echoProtocol);
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: responseHeaders,
    } as ResponseInit & { webSocket: HibernatableWebSocket });
  }

  private parseSubscribeParam(
    raw: string
  ): { scope: SubscriptionScope; agentIds: number[] } | null {
    const value = raw.trim().toLowerCase();
    if (value === "" || value === "all") {
      return { scope: "all", agentIds: [] };
    }
    const agentIds = parseAgentIdListParam(value);
    if (!agentIds || agentIds.length === 0) return null;
    return { scope: "ids", agentIds };
  }

  private parseAllowedAgentIds(raw: string | null): number[] | null {
    if (raw === null || raw.trim() === "*") {
      // 未提供或显式 * 表示不受限
      return null;
    }
    return parseAgentIdListParam(raw) ?? [];
  }

  // ── 批量推送 ──────────────────────────────────────────
  private async handleBatchPush(request: Request): Promise<Response> {
    let body: { updates?: unknown } | null = null;
    try {
      body = (await request.json()) as { updates?: unknown };
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }

    const rawUpdates = body?.updates;
    if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
      return jsonResponse({ error: "missing or empty updates array" }, 400);
    }

    const updates = this.normalizeBatchUpdates(rawUpdates);
    if (updates.length === 0) {
      return jsonResponse({ error: "missing valid updates" }, 400);
    }

    const reportTs = Date.now();
    this.cacheLatestReportUpdates(updates, reportTs);
    this.broadcastBatch(updates, reportTs);

    return jsonResponse({
      ok: true,
      count: updates.length,
      subscribers: this.state.getWebSockets().length,
    });
  }

  private normalizeBatchUpdates(rawUpdates: unknown[]): BroadcastUpdate[] {
    const now = Date.now();
    const updates: BroadcastUpdate[] = [];

    for (const item of rawUpdates) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const agentId = normalizeAgentId(record.agentId);
      if (agentId === null) continue;

      const rawSamples = Array.isArray(record.samples) ? record.samples : [];
      const samples: BroadcastSample[] = [];
      for (const sample of rawSamples) {
        if (!sample || typeof sample !== "object") continue;
        const sampleRecord = sample as Record<string, unknown>;
        const data = sampleRecord.data;
        if (!data || typeof data !== "object") continue;
        const ts = Number(sampleRecord.ts) || now;
        samples.push({ ts, data: data as BroadcastMetricData });
      }

      if (samples.length === 0) continue;
      samples.sort((a, b) => a.ts - b.ts);
      updates.push({ agentId, samples: samples.slice(-MAX_REPORT_SAMPLES) });
    }

    return updates;
  }

  // ── 最近一包缓存（供首屏接续）────────────────────────────
  private pruneLatestReportUpdates(now = Date.now()): void {
    // delete + set 维护的插入序即时间序：遇到首个未过期条目即可停止扫描
    for (const [agentId, entry] of this.latestReportUpdates) {
      if (now - entry.reportTs <= LATEST_REPORT_TTL_MS) break;
      this.latestReportUpdates.delete(agentId);
    }
  }

  private cacheLatestReportUpdates(
    updates: BroadcastUpdate[],
    reportTs: number
  ): void {
    this.pruneLatestReportUpdates(reportTs);

    for (const update of updates) {
      // delete + set 让 Map 的插入顺序代表最近更新时间，便于限制内存上限；
      // 唯一消费方只读最后一个样本，因此每个 agent 只保留最新一条
      this.latestReportUpdates.delete(update.agentId);
      this.latestReportUpdates.set(update.agentId, {
        agentId: update.agentId,
        reportTs,
        samples: update.samples.slice(-1),
      });
    }

    while (this.latestReportUpdates.size > MAX_LATEST_REPORT_AGENTS) {
      const oldest = this.latestReportUpdates.keys().next().value;
      if (oldest === undefined) break;
      this.latestReportUpdates.delete(oldest);
    }
  }

  private handleLatestReportUpdates(url: URL): Response {
    const rawIds = url.searchParams.get("agentIds");
    let filterIds: number[] | null = null;
    if (rawIds !== null && rawIds.trim() !== "") {
      filterIds = parseAgentIdListParam(rawIds);
      if (!filterIds) {
        return jsonResponse({ error: "invalid agentIds" }, 400);
      }
    }

    const now = Date.now();
    this.pruneLatestReportUpdates(now);

    const updates: Array<LatestReportEntry & { reportAgeMs: number }> = [];
    const collect = (entry: LatestReportEntry | undefined) => {
      if (!entry) return;
      updates.push({ ...entry, reportAgeMs: Math.max(0, now - entry.reportTs) });
    };

    if (filterIds) {
      for (const agentId of filterIds) {
        collect(this.latestReportUpdates.get(agentId));
      }
    } else {
      for (const entry of this.latestReportUpdates.values()) {
        collect(entry);
      }
    }

    return jsonResponse({ updates });
  }

  // ── 广播 ─────────────────────────────────────────────
  private parseAttachment(value: unknown): SubscriptionAttachment | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const scope = record.scope;
    if (scope !== "all" && scope !== "ids") return null;
    const agentIds = normalizeAgentIds(record.agentIds);
    if (agentIds === null) return null;
    let allowedAgentIds: number[] | null = null;
    if (record.allowedAgentIds !== null) {
      const normalized = normalizeAgentIds(record.allowedAgentIds);
      // 附件损坏时按空列表处理（不投递），避免越权
      allowedAgentIds = normalized ?? [];
    }
    return { scope, agentIds, allowedAgentIds };
  }

  private broadcastBatch(updates: BroadcastUpdate[], ts: number): void {
    const websockets = this.state.getWebSockets();
    // 无限制订阅者（scope=all 且不受 allowedAgentIds 约束）共享同一份序列化结果
    let fullMessage: string | null = null;

    for (const ws of websockets) {
      const attachment = this.parseAttachment(ws.deserializeAttachment());
      if (!attachment) continue;

      let message: string;
      if (attachment.scope === "all" && attachment.allowedAgentIds === null) {
        fullMessage ??= JSON.stringify({ type: "batchUpdate", ts, updates });
        message = fullMessage;
      } else {
        const allowed =
          attachment.allowedAgentIds === null
            ? null
            : new Set(attachment.allowedAgentIds);
        const subscribed =
          attachment.scope === "all" ? null : new Set(attachment.agentIds);
        const scopedUpdates = updates.filter(
          (update) =>
            (allowed === null || allowed.has(update.agentId)) &&
            (subscribed === null || subscribed.has(update.agentId))
        );
        if (scopedUpdates.length === 0) continue;
        message = JSON.stringify({
          type: "batchUpdate",
          ts,
          updates: scopedUpdates,
        });
      }

      try {
        ws.send(message);
      } catch {
        // WebSocket 已异常关闭，DO 会自动清理
      }
    }
  }

  // ── Hibernation API 回调 ─────────────────────────────
  // 收到消息（ping 已被 setWebSocketAutoResponse 拦截，不会到达此处）
  webSocketMessage(ws: HibernatableWebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let msg: Record<string, unknown> | null = null;
    try {
      msg = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!msg || msg.type !== "subscribe") return;

    const current = this.parseAttachment(ws.deserializeAttachment());
    const rawScope =
      msg.scope === undefined ? current?.scope ?? "all" : msg.scope;
    if (rawScope !== "all" && rawScope !== "ids") {
      this.closeInvalidSubscription(ws);
      return;
    }

    const agentIds = normalizeAgentIds(msg.agentIds);
    if (agentIds === null || (rawScope === "ids" && agentIds.length === 0)) {
      this.closeInvalidSubscription(ws);
      return;
    }

    const next: SubscriptionAttachment = {
      scope: rawScope,
      agentIds,
      allowedAgentIds: current ? current.allowedAgentIds : [],
    };
    ws.serializeAttachment(next);

    try {
      ws.send(
        JSON.stringify({
          type: "subscribed",
          ts: Date.now(),
          subscribed: next.scope,
          count: next.agentIds.length,
        })
      );
    } catch {
      // 忽略发送失败
    }
  }

  private closeInvalidSubscription(ws: HibernatableWebSocket): void {
    try {
      ws.close(WS_POLICY_VIOLATION, "invalid subscription");
    } catch {
      // 忽略关闭失败
    }
  }

  // WebSocket 关闭/出错 — DO 自动清理，无需手动移除
  webSocketClose(): void {}

  webSocketError(): void {}
}

export default MetricsBroadcaster;
