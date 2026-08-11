import { DurableObject } from "cloudflare:workers";

import type {
  BroadcastMetricData,
  BroadcastSample,
  BroadcastUpdate,
} from "../models/broadcast";
import { MAX_REPORT_SAMPLES } from "../utils/agentConfig";

const LATEST_REPORT_TTL_MS = 5 * 60 * 1000;
const MAX_PUSH_BODY_BYTES = 256 * 1024;
const MAX_ROOM_SUBSCRIPTIONS = 200;
const MAX_CACHED_AGENTS = 1_000;

interface ConnectionAttachment {
  agentIds: number[];
  connectedAt: number;
  scope: "admin" | "public";
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
    if (request.method === "POST" && url.pathname === "/push") {
      return this.pushUpdate(request);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      this.pruneLatestReports();
      const agentId = normalizeAgentId(url.searchParams.get("agentId"));
      return jsonResponse({
        ok: true,
        subscribers: this.ctx.getWebSockets().length,
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

    const attachment: ConnectionAttachment = {
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

  private async pushUpdate(request: Request): Promise<Response> {
    const body = await readBoundedJson(request);
    const incoming = normalizeUpdate(body);
    if (!incoming) {
      return jsonResponse({ error: "invalid update" }, 400);
    }

    this.pruneLatestReports();
    const previous = this.latestReports.get(incoming.agentId)?.update;
    const update: BroadcastUpdate = {
      agentId: incoming.agentId,
      samples:
        incoming.samples.length > 0
          ? incoming.samples
          : previous?.samples ?? [],
      status: incoming.status ?? previous?.status,
      lastSeenAt:
        incoming.lastSeenAt !== undefined
          ? incoming.lastSeenAt
          : previous?.lastSeenAt,
      changedAt: incoming.changedAt ?? previous?.changedAt,
    };
    const report: LatestReport = { update, receivedAt: Date.now() };
    this.latestReports.set(update.agentId, report);
    this.enforceCacheLimit();

    // 当前广播只发送本次变化。状态变更无需重复传输缓存指标；新连接仍会收到合并缓存。
    const outgoing: LatestReport = {
      update: incoming,
      receivedAt: report.receivedAt,
    };
    let delivered = 0;

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.readAttachment(socket);
      if (!attachment || !attachment.agentIds.includes(update.agentId)) continue;
      try {
        socket.send(this.serializeUpdates([outgoing], attachment.scope));
        delivered += 1;
      } catch {
        // 单个订阅者失败不影响同分片其他连接，运行时会回收异常连接。
      }
    }

    return jsonResponse({ ok: true, delivered });
  }

  private serializeUpdates(
    reports: LatestReport[],
    scope: ConnectionAttachment["scope"]
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

  private readAttachment(socket: WebSocket): ConnectionAttachment | null {
    const value = socket.deserializeAttachment();
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.agentIds)) return null;
    const agentIds = record.agentIds
      .map(normalizeAgentId)
      .filter((agentId): agentId is number => agentId !== null);
    const connectedAt = Number(record.connectedAt);
    const scope = record.scope === "public" ? "public" : "admin";
    if (agentIds.length === 0 || !Number.isFinite(connectedAt)) return null;
    return { agentIds, connectedAt, scope };
  }

  webSocketMessage(): void {
    // 客户端心跳由自动响应处理；订阅范围在升级时固定并存入 attachment。
  }

  webSocketClose(): void {
    // Hibernation API 负责连接生命周期。
  }

  webSocketError(): void {
    // Hibernation API 负责连接生命周期。
  }
}

export default AgentRoom;
