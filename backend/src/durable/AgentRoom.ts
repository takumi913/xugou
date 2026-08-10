import { DurableObject } from "cloudflare:workers";

import type {
  BroadcastMetricData,
  BroadcastSample,
  BroadcastUpdate,
} from "../models/broadcast";
import { MAX_REPORT_SAMPLES } from "../utils/agentConfig";

const LATEST_REPORT_TTL_MS = 5 * 60 * 1000;
const MAX_PUSH_BODY_BYTES = 256 * 1024;

interface ConnectionAttachment {
  agentId: number;
  connectedAt: number;
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
    });
  }

  if (samples.length === 0) return null;
  samples.sort((left, right) => left.ts - right.ts);
  return { agentId, samples: samples.slice(-MAX_REPORT_SAMPLES) };
}

/**
 * 单个 Agent 的实时连接房间。
 *
 * Worker 始终以 agent id 作为 Durable Object 名称，因此一个实例只承载一个
 * Agent 的连接与最近一包非关键缓存，避免全局广播实例造成热点和跨 Agent 扇出。
 * 业务事实仍以 D1 为准；该内存缓存被驱逐后自然丢失，不参与数据持久化。
 */
export class AgentRoom extends DurableObject {
  private latestReport: LatestReport | null = null;

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
      this.pruneLatestReport();
      return jsonResponse({
        ok: true,
        subscribers: this.ctx.getWebSockets().length,
        hasLatestReport: this.latestReport !== null,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  private upgradeWebSocket(request: Request, url: URL): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade request", { status: 426 });
    }

    const agentId = normalizeAgentId(url.searchParams.get("agentId"));
    if (agentId === null) {
      return jsonResponse({ error: "invalid agent id" }, 400);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const attachment: ConnectionAttachment = {
      agentId,
      connectedAt: Date.now(),
    };
    server.serializeAttachment(attachment);

    server.send(
      JSON.stringify({
        type: "hello",
        ts: Date.now(),
        agentId,
      })
    );

    this.pruneLatestReport();
    if (this.latestReport?.update.agentId === agentId) {
      server.send(this.serializeUpdate(this.latestReport));
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async pushUpdate(request: Request): Promise<Response> {
    const body = await readBoundedJson(request);

    const update = normalizeUpdate(body);
    if (!update) {
      return jsonResponse({ error: "invalid update" }, 400);
    }

    const report: LatestReport = { update, receivedAt: Date.now() };
    this.latestReport = report;
    const message = this.serializeUpdate(report);
    let delivered = 0;

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.readAttachment(socket);
      if (!attachment || attachment.agentId !== update.agentId) continue;
      try {
        socket.send(message);
        delivered += 1;
      } catch {
        // 运行时会清理异常连接；单个订阅者失败不影响同房间其他连接。
      }
    }

    return jsonResponse({ ok: true, delivered });
  }

  private serializeUpdate(report: LatestReport): string {
    return JSON.stringify({
      type: "batchUpdate",
      ts: report.receivedAt,
      updates: [report.update],
    });
  }

  private pruneLatestReport(now = Date.now()): void {
    if (
      this.latestReport &&
      now - this.latestReport.receivedAt > LATEST_REPORT_TTL_MS
    ) {
      this.latestReport = null;
    }
  }

  private readAttachment(socket: WebSocket): ConnectionAttachment | null {
    const value = socket.deserializeAttachment();
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const agentId = normalizeAgentId(record.agentId);
    const connectedAt = Number(record.connectedAt);
    if (agentId === null || !Number.isFinite(connectedAt)) return null;
    return { agentId, connectedAt };
  }

  webSocketMessage(): void {
    // 客户端只发送字符串 ping，由自动响应处理；房间绑定在升级时已经固定。
  }

  webSocketClose(): void {
    // Hibernation API 负责连接生命周期。
  }

  webSocketError(): void {
    // Hibernation API 负责连接生命周期。
  }
}

export default AgentRoom;
