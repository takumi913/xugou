import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import { Bindings } from "../models/db";
import { authenticateAdminSession } from "../modules/auth/persistence/D1SessionStore";
import { SESSION_COOKIE_NAME } from "../utils/session-cookie";
import { getAllowedOrigin } from "../middlewares/cors";
import {
  parseAgentRoomSubscription,
  parseAgentRoomSubscriptions,
  realtimeRoomName,
} from "../modules/agents/realtime/RealtimeSharding";

/**
 * GET /api/ws?subscribe=<agent-id[,agent-id...]>
 *
 * 入口校验管理员会话与订阅 ID。同一请求中的 ID 必须属于同一个稳定分片；
 * Dashboard 客户端会自动按分片建立少量连接，详情页仍只建立一条连接。
 */
const ws = new Hono<{ Bindings: Bindings }>();

export { parseAgentRoomSubscription, parseAgentRoomSubscriptions };

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

  const agentIds = parseAgentRoomSubscriptions(c.req.query("subscribe"));
  if (!agentIds) {
    return c.json(
      {
        success: false,
        message: "Agent ids must be valid and belong to one realtime shard",
      },
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
    target.searchParams.set("agentIds", agentIds.join(","));

    return await namespace
      .getByName(realtimeRoomName(agentIds[0]))
      .fetch(new Request(target, { method: "GET", headers: c.req.raw.headers }));
  } catch {
    return c.json({ success: false, message: "WebSocket error" }, 500);
  }
});

export { ws };
