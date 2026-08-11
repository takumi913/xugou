import { DurableObject } from "cloudflare:workers";

import type {
  BroadcastMetricData,
  BroadcastSample,
  BroadcastUpdate,
} from "../models/broadcast";
import {
  agentLiveMetricFrameSchema,
  liveFrameToBroadcastUpdate,
} from "../modules/agents/realtime/AgentLiveProtocol";
import { MAX_REPORT_SAMPLES } from "../utils/agentConfig";

const LATEST_REPORT_TTL_MS = 5 * 60 * 1000;
const MAX_PUSH_BODY_BYTES = 256 * 1024;
const MAX_ROOM_SUBSCRIPTIONS = 200;
const MAX_CACHED_AGENTS = 1_000;
const MAX_LIVE_FRAME_BYTES = 64 * 1024;

interface SubscriberAttachment {
  kind: "subscriber";
  agentIds: number[];
  connectedAt: number;
  scope: "admin" | "public";
}

interface AgentConnectionAttachment {
  kind: "agent";
  agentId: number;
  connectedAt: number;
  sequence: number;
}

interface LatestReport {
  update: BroadcastUpdate;
  receivedAt: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function normalizeAgentId(value: unknown): number | null {
  const agentId = Number(value);
  return Number.isSafeInteger(agentId) && agentId > 0 ? agentId : null;
}

function normalizeAgentIds(value: string | null): number[] | null {
  if (!value || value.length > 2_048) return null;
  const ids = [...new Set(value.split(",").map(normalizeAgentId))];
  if (
    ids.length === 0 ||
    ids.length > MAX_ROOM_SUBSCRIPTIONS ||
    ids.some((id) => id === null)
  ) {
    return null;
  }
  return (ids as number[]).sort((left, right) => left - right);
}

async function readBoundedJson(request: Request): Promise<unknown | null> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PUSH_BODY_BYTES) {
    return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PUSH_BODY_BYTES) {
        await reader.cancel("agent room update exceeds limit");
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function normalizeUpdate(value: unknown): BroadcastUpdate | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const agentId = normalizeAgentId(record.agentId);
  if (agentId === null || !Array.isArray(record.samples)) return null;

  const status =
    record.status === "active" || record.status === "inactive"
      ? record.status
      : undefined;
  const lastSeenAt =
    typeof record.lastSeenAt === "string" || record.lastSeenAt === null
      ? record.lastSeenAt
      : undefined;
  const changedAt =
    typeof record.changedAt === "string" ? record.changedAt : undefined;
  const receivedAt = Date.now();
  const samples: BroadcastSample[] = [];
  for (const sample of record.samples) {
    if (!sample || typeof sample !== "object") continue;
    const sampleRecord = sample as Record<string, unknown>;
    if (!sampleRecord.data || typeof sampleRecord.data !== "object") continue;
    const rawTimestamp = Number(sampleRecord.ts);
    samples.push({
      ts: Number.isFinite(rawTimestamp) ? rawTimestamp : receivedAt,
      data: sampleRecord.data as BroadcastMetricData,
      ...(sampleRecord.publicData &&
      typeof sampleRecord.publicData === "object" &&
      !Array.isArray(sampleRecord.publicData)
        ? { publicData: sampleRecord.publicData as BroadcastMetricData }
        : {}),
    });
  }

  if (samples.length === 0 && status === undefined) return null;
  samples.sort((left, right) => left.ts - right.ts);
  return {
    agentId,
    samples: samples.slice(-MAX_REPORT_SAMPLES),
    ...(status ? { status } : {}),
    ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
    ...(changedAt !== undefined ? { changedAt } : {}),
  };
}

/**
 * Agent 实时分片房间。
 *
 * Worker 以 Agent ID 的稳定哈希选择少量分片；连接附件保存该浏览器在当前
 * 分片订阅的 Agent ID。这样详情页仍是一条连接，Dashboard 也只需每分片
 * 一条连接，同时避免参考项目中单个全局广播 DO 的热点。
 */
export class AgentRoom extends DurableObject {
  private readonly latestReports = new Map<number, LatestReport>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/ws") {
      return this.upgradeWebSocket(request, url);
    }
    if (request.method === "GET" && url.pathname === "/agent-ws") {
      return this.upgradeAgentWebSocket(request, url);
    }
    if (request.method === "POST" && url.pathname === "/push") {
      return this.pushUpdate(request);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      this.pruneLatestReports();
      const agentId = normalizeAgentId(url.searchParams.get("agentId"));
      const connections = this.ctx.getWebSockets();
      return jsonResponse({
        ok: true,
        subscribers: connections.filter((socket) =>
          Boolean(this.readSubscriberAttachment(socket))
        ).length,
        upstreams: connections.filter((socket) =>
          Boolean(this.readAgentAttachment(socket))
        ).length,
        cachedAgents: this.latestReports.size,
        hasLatestReport:
          agentId === null
            ? this.latestReports.size > 0
            : this.latestReports.has(agentId),
      });
    }

    return new Response("Not found", { status: 404 });
  }

  private upgradeWebSocket(request: Request, url: URL): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade request", { status: 426 });
    }

    const agentIds = normalizeAgentIds(url.searchParams.get("agentIds"));
    if (!agentIds) {
      return jsonResponse({ error: "invalid agent ids" }, 400);
    }
    const scope = url.searchParams.get("scope") === "public" ? "public" : "admin";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const attachment: SubscriberAttachment = {
      kind: "subscriber",
      agentIds,
      connectedAt: Date.now(),
      scope,
    };
    server.serializeAttachment(attachment);

    server.send(
      JSON.stringify({
        type: "hello",
        ts: Date.now(),
        agentIds,
      })
    );

    this.pruneLatestReports();
    const cached = agentIds
      .map((agentId) => this.latestReports.get(agentId))
      .filter((report): report is LatestReport => Boolean(report));
    if (cached.length > 0) {
      server.send(this.serializeUpdates(cached, scope));
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private upgradeAgentWebSocket(request: Request, url: URL): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade request", { status: 426 });
    }
    const agentId = normalizeAgentId(url.searchParams.get("agentId"));
    if (agentId === null) {
      return jsonResponse({ error: "invalid agent id" }, 400);
    }

    // 同一 Agent 只保留最新上行，避免旧进程与新进程同时广播重复样本。
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.readAgentAttachment(socket);
      if (attachment?.agentId !== agentId) continue;
      try {
        socket.close(4001, "replaced by newer agent connection");
      } catch {
        // 运行时会回收已结束的旧连接。
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const attachment: AgentConnectionAttachment = {
      kind: "agent",
      agentId,
      connectedAt: Date.now(),
      sequence: -1,
    };
    server.serializeAttachment(attachment);
    server.send(
      JSON.stringify({ type: "hello", protocol_version: 1, agentId, ts: Date.now() })
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  private async pushUpdate(request: Request): Promise<Response> {
    const body = await readBoundedJson(request);
    const incoming = normalizeUpdate(body);
    if (!incoming) {
      return jsonResponse({ error: "invalid update" }, 400);
    }

    const delivered = this.acceptUpdate(incoming);
    return jsonResponse({ ok: true, delivered });
  }

  private acceptUpdate(incoming: BroadcastUpdate): number {
    this.pruneLatestReports();
    const previous = this.latestReports.get(incoming.agentId)?.update;
    let inheritedData = previous?.samples.at(-1)?.data ?? {};
    let inheritedPublicData = previous?.samples.at(-1)?.publicData ?? {};
    const mergedSamples = incoming.samples.map((sample) => {
      inheritedData = { ...inheritedData, ...sample.data };
      inheritedPublicData = {
        ...inheritedPublicData,
        ...(sample.publicData ?? {}),
      };
      return {
        ...sample,
        data: inheritedData,
        publicData: inheritedPublicData,
      };
    });
    const mergedIncoming: BroadcastUpdate = {
      ...incoming,
      samples: mergedSamples,
    };
    const update: BroadcastUpdate = {
      agentId: incoming.agentId,
      samples:
        mergedIncoming.samples.length > 0
          ? mergedIncoming.samples
          : previous?.samples ?? [],
      status: incoming.status ?? previous?.status,
      lastSeenAt:
        incoming.lastSeenAt !== undefined
          ? incoming.lastSeenAt
          : previous?.lastSeenAt,
      changedAt: incoming.changedAt ?? previous?.changedAt,
    };
    const receivedAt = Date.now();
    this.latestReports.set(update.agentId, { update, receivedAt });
    this.enforceCacheLimit();

    // 当前广播只发送本次变化。状态变更不重复传输缓存指标；新连接收到合并缓存。
    const outgoing: LatestReport = { update: mergedIncoming, receivedAt };
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.readSubscriberAttachment(socket);
      if (!attachment || !attachment.agentIds.includes(update.agentId)) continue;
      try {
        socket.send(this.serializeUpdates([outgoing], attachment.scope));
        delivered += 1;
      } catch {
        // 单个订阅者失败不影响同分片其他连接，运行时会回收异常连接。
      }
    }
    return delivered;
  }

  private serializeUpdates(
    reports: LatestReport[],
    scope: SubscriberAttachment["scope"]
  ): string {
    return JSON.stringify({
      type: "batchUpdate",
      ts: Math.max(...reports.map((report) => report.receivedAt)),
      updates: reports.map((report) => ({
        ...report.update,
        samples: report.update.samples.map((sample) => ({
          ts: sample.ts,
          data: scope === "public" ? sample.publicData ?? {} : sample.data,
        })),
      })),
    });
  }

  private pruneLatestReports(now = Date.now()): void {
    for (const [agentId, report] of this.latestReports) {
      if (now - report.receivedAt > LATEST_REPORT_TTL_MS) {
        this.latestReports.delete(agentId);
      }
    }
  }

  private enforceCacheLimit(): void {
    while (this.latestReports.size > MAX_CACHED_AGENTS) {
      const oldestAgentId = this.latestReports.keys().next().value as
        | number
        | undefined;
      if (oldestAgentId === undefined) return;
      this.latestReports.delete(oldestAgentId);
    }
  }

  private readSubscriberAttachment(
    socket: WebSocket
  ): SubscriberAttachment | null {
    const value = socket.deserializeAttachment();
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    // kind 缺失时兼容部署前仍由 Hibernation 保存的浏览器连接附件。
    if (
      (record.kind !== undefined && record.kind !== "subscriber") ||
      !Array.isArray(record.agentIds)
    ) {
      return null;
    }
    const agentIds = record.agentIds
      .map(normalizeAgentId)
      .filter((agentId): agentId is number => agentId !== null);
    const connectedAt = Number(record.connectedAt);
    const scope = record.scope === "public" ? "public" : "admin";
    if (agentIds.length === 0 || !Number.isFinite(connectedAt)) return null;
    return { kind: "subscriber", agentIds, connectedAt, scope };
  }

  private readAgentAttachment(socket: WebSocket): AgentConnectionAttachment | null {
    const value = socket.deserializeAttachment();
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (record.kind !== "agent") return null;
    const agentId = normalizeAgentId(record.agentId);
    const connectedAt = Number(record.connectedAt);
    const sequence = Number(record.sequence);
    if (
      agentId === null ||
      !Number.isFinite(connectedAt) ||
      !Number.isSafeInteger(sequence)
    ) {
      return null;
    }
    return { kind: "agent", agentId, connectedAt, sequence };
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const attachment = this.readAgentAttachment(socket);
    if (!attachment) {
      // 浏览器心跳由自动响应处理；订阅范围在升级时固定。
      return;
    }
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text === "ping") return;
    if (new TextEncoder().encode(text).byteLength > MAX_LIVE_FRAME_BYTES) {
      socket.close(1009, "live metric frame too large");
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      socket.close(1008, "invalid live metric json");
      return;
    }
    const parsed = agentLiveMetricFrameSchema.safeParse(decoded);
    if (!parsed.success) {
      socket.close(1008, "invalid live metric frame");
      return;
    }
    if (parsed.data.sequence <= attachment.sequence) return;
    attachment.sequence = parsed.data.sequence;
    socket.serializeAttachment(attachment);
    this.acceptUpdate(liveFrameToBroadcastUpdate(attachment.agentId, parsed.data));
  }

  webSocketClose(): void {
    // Hibernation API 负责连接生命周期。
  }

  webSocketError(): void {
    // Hibernation API 负责连接生命周期。
  }
}

export default AgentRoom;
