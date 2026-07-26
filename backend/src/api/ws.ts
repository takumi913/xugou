import { Hono } from "hono";
import { verify } from "hono/jwt";
import { Bindings } from "../models/db";
import { JwtPayload } from "../types";
import { getJwtSecret } from "../utils/jwt";
import * as AgentRepository from "../repositories";

/**
 * GET /api/ws —— WebSocket 升级端点
 *
 * 鉴权：支持 ?token=<jwt> 查询参数或 Sec-WebSocket-Protocol 子协议携带 JWT，
 * 校验通过后把请求转发给 MetricsBroadcaster DO（idFromName('global')）。
 * 订阅参数：?subscribe=all | <id,id,...>
 */
const ws = new Hono<{ Bindings: Bindings }>();

function extractToken(c: {
  req: { query: (key: string) => string | undefined; header: (key: string) => string | undefined };
}): { token: string | null; fromProtocol: string | null } {
  const queryToken = c.req.query("token");
  if (queryToken) {
    return { token: queryToken, fromProtocol: null };
  }

  const protocolHeader = c.req.header("Sec-WebSocket-Protocol");
  if (protocolHeader) {
    const candidates = protocolHeader
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    // JWT 形如 xxx.yyy.zzz，取第一个符合格式的子协议值
    const token = candidates.find((value) => value.split(".").length === 3);
    if (token) {
      return { token, fromProtocol: token };
    }
  }

  return { token: null, fromProtocol: null };
}

ws.get("/", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return c.json(
      { success: false, message: "Expected WebSocket upgrade request" },
      400
    );
  }

  const namespace = c.env.METRICS_BROADCASTER;
  if (!namespace) {
    return c.json({ success: false, message: "WebSocket not enabled" }, 503);
  }

  // ── 鉴权：复用现有 JWT 校验逻辑 ──
  const { token, fromProtocol } = extractToken(c);
  if (!token) {
    return c.json({ success: false, message: "Unauthorized" }, 401);
  }

  let payload: JwtPayload;
  try {
    payload = (await verify(token, getJwtSecret(c), "HS256")) as unknown as JwtPayload;
  } catch {
    return c.json({ success: false, message: "Unauthorized" }, 401);
  }

  const userId = Number(payload.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return c.json({ success: false, message: "Unauthorized" }, 401);
  }

  // ── 计算允许订阅的 agent 范围（admin 不受限）──
  let allowedAgentIds = "*";
  if (payload.role !== "admin") {
    try {
      // 只需 id 列表，走轻量查询避免整行 select
      const agentIds = await AgentRepository.getAgentIds(userId);
      allowedAgentIds = agentIds.join(",");
    } catch (error) {
      console.error("[ws] 获取可访问客户端失败:", error);
      // 查询失败时按空列表处理（连接可建立，但收不到任何广播）
      allowedAgentIds = "";
    }
  }

  const subscribe = c.req.query("subscribe") ?? "all";

  try {
    const stub = namespace.get(namespace.idFromName("global"));

    const target = new URL("http://internal/ws");
    target.searchParams.set("subscribe", subscribe);

    const headers = new Headers(c.req.raw.headers);
    headers.set("X-Allowed-Agent-Ids", allowedAgentIds);
    if (fromProtocol) {
      headers.set("X-Echo-Protocol", fromProtocol);
    }

    return await stub.fetch(
      new Request(target.toString(), { method: "GET", headers })
    );
  } catch (error) {
    console.error("[ws] DO upgrade failed:", error);
    return c.json({ success: false, message: "WebSocket error" }, 500);
  }
});

export { ws };
