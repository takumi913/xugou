import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import { Bindings } from "../models/db";
import { authenticateAdminSession } from "../modules/auth/persistence/D1SessionStore";
import { SESSION_COOKIE_NAME } from "../utils/session-cookie";
import { getAllowedOrigin } from "../middlewares/cors";

/**
 * GET /api/ws?subscribe=<agent-id>
 *
 * 实时连接只服务 Agent 详情页。入口先校验单一 Agent ID 和管理员会话，再把
 * 升级请求转发到以该 ID 命名的 AgentRoom。Dashboard 与公开状态页读取查询
 * 投影并定时刷新，不再接入全局实时广播。
 */
const ws = new Hono<{ Bindings: Bindings }>();

export function parseAgentRoomSubscription(raw: string | undefined): number | null {
  if (!raw || raw.includes(",") || raw.trim().toLowerCase() === "all") {
    return null;
  }
  const agentId = Number(raw);
  return Number.isSafeInteger(agentId) && agentId > 0 ? agentId : null;
}

ws.get("/", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json(
      { success: false, message: "Expected WebSocket upgrade request" },
      426
    );
  }

  if (
    !getAllowedOrigin(c.req.header("Origin") ?? null, c.req.url, c.env)
  ) {
    return c.json({ success: false, message: "WebSocket origin denied" }, 403);
  }

  const agentId = parseAgentRoomSubscription(c.req.query("subscribe"));
  if (agentId === null) {
    return c.json(
      { success: false, message: "Exactly one agent id is required" },
      400
    );
  }

  const namespace = c.env.AGENT_ROOM;
  if (!namespace) {
    return c.json({ success: false, message: "WebSocket not enabled" }, 503);
  }

  const cookieToken = getCookie(c, SESSION_COOKIE_NAME) ?? null;
  if (!cookieToken) {
    return c.json({ success: false, message: "Unauthorized" }, 401);
  }

  let authenticated = false;
  try {
    authenticated = Boolean(await authenticateAdminSession(c.env, cookieToken));
  } catch {
    authenticated = false;
  }

  if (!authenticated) {
    return c.json({ success: false, message: "Unauthorized" }, 401);
  }

  try {
    const target = new URL("http://internal/ws");
    target.searchParams.set("agentId", String(agentId));

    return await namespace
      .getByName(String(agentId))
      .fetch(new Request(target, { method: "GET", headers: c.req.raw.headers }));
  } catch {
    return c.json({ success: false, message: "WebSocket error" }, 500);
  }
});

export { ws };
