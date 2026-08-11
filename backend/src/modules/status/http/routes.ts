import { Hono } from "hono";
import type { Bindings } from "../../../models/db";
import type { AuthVariables } from "../../../types";
import {
  applicationProblemResponse,
  problemResponse,
} from "../../../platform/http/problem";
import { ApplicationProblem } from "../../../shared/errors/ApplicationProblem";
import { getEnvNumber } from "../../../utils/env";
import { createStatusUseCases } from "../composition";
import { publicAgentIdSchema, statusConfigV2Schema } from "./schemas";
import { getAllowedOrigin } from "../../../middlewares/cors";
import {
  parseAgentRoomSubscriptions,
  realtimeRoomName,
} from "../../agents/realtime/RealtimeSharding";

const statusV2 = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
type AppContext = Parameters<typeof problemResponse>[0];
type WorkerCacheStorage = CacheStorage & { default: Cache };

function etagMatches(value: string | undefined, etag: string) {
  return Boolean(
    value
      ?.split(",")
      .map((item) => item.trim())
      .includes(etag)
  );
}

function publicCacheKey(request: Request, schema: string) {
  const url = new URL(request.url);
  url.searchParams.set("__xugou_public_schema", schema);
  return new Request(url.toString(), request);
}

async function handle<T>(c: AppContext, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApplicationProblem) return applicationProblemResponse(c, error);
    return problemResponse(c, {
      status: 500,
      code: "INTERNAL_ERROR",
      title: "Internal server error",
    });
  }
}

function validation(c: AppContext) {
  return problemResponse(c, {
    status: 400,
    code: "VALIDATION_ERROR",
    title: "Request validation failed",
  });
}

statusV2.get("/config", async (c) => {
  const result = await handle(c, () => createStatusUseCases(c.env).getConfig());
  return result instanceof Response ? result : c.json({ data: result });
});

statusV2.put("/config", async (c) => {
  const parsed = statusConfigV2Schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validation(c);
  const result = await handle(c, () =>
    createStatusUseCases(c.env).saveConfig(parsed.data)
  );
  return result instanceof Response ? result : c.json({ data: result });
});

/**
 * 匿名状态页实时入口。订阅范围必须完全属于当前状态页且节点公开可见；
 * AgentRoom 再按 public scope 投影样本，管理字段不会进入这条连接。
 */
statusV2.get("/public/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json(
      { success: false, message: "Expected WebSocket upgrade request" },
      426
    );
  }
  if (!getAllowedOrigin(c.req.header("Origin") ?? null, c.req.url, c.env)) {
    return c.json({ success: false, message: "WebSocket origin denied" }, 403);
  }

  const agentIds = parseAgentRoomSubscriptions(c.req.query("subscribe"));
  if (!agentIds) {
    return c.json({ success: false, message: "Invalid agent subscriptions" }, 400);
  }

  const selected = await c.env.DB.prepare(
    `SELECT component.component_id AS agent_id
     FROM status_pages page
     JOIN status_components component ON component.page_id = page.id
     JOIN agent_nodes node ON node.id = component.component_id
     WHERE page.singleton_key = 1 AND component.component_type = 'agent'
       AND component.component_id IN (
         SELECT CAST(value AS INTEGER) FROM json_each(?)
       )
       AND node.deleted_at_ms IS NULL AND node.is_hidden <> 1`
  )
    .bind(JSON.stringify(agentIds))
    .all<{ agent_id: number }>();
  const selectedIds = new Set(selected.results.map((row) => Number(row.agent_id)));
  if (agentIds.some((agentId) => !selectedIds.has(agentId))) {
    return c.json({ success: false, message: "Agent is not public" }, 404);
  }

  const namespace = c.env.AGENT_ROOM;
  if (!namespace) {
    return c.json({ success: false, message: "WebSocket not enabled" }, 503);
  }

  try {
    const target = new URL("http://internal/ws");
    target.searchParams.set("agentIds", agentIds.join(","));
    target.searchParams.set("scope", "public");
    return await namespace
      .getByName(realtimeRoomName(agentIds[0]))
      .fetch(new Request(target, { method: "GET", headers: c.req.raw.headers }));
  } catch {
    return c.json({ success: false, message: "WebSocket error" }, 500);
  }
});

statusV2.get("/public", async (c) => {
  let result;
  try {
    result = await createStatusUseCases(c.env).getPublicData();
  } catch (error) {
    if (error instanceof ApplicationProblem) {
      if (error.code === "PUBLICATION_NOT_READY") c.header("Retry-After", "30");
      return applicationProblemResponse(c, error);
    }
    return problemResponse(c, {
      status: 500,
      code: "INTERNAL_ERROR",
      title: "Internal server error",
    });
  }
  const cacheControl = `public, max-age=${getEnvNumber(
    c.env,
    "STATUS_PAGE_CACHE_TTL_SECONDS",
    30,
    { min: 0, max: 3600 }
  )}`;
  if (result.etag && c.req.header("If-None-Match") === result.etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: result.etag, "Cache-Control": cacheControl },
    });
  }
  return new Response(result.payloadJson, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      ...(result.etag ? { ETag: result.etag } : {}),
      "X-Publication-Generated-At": result.generatedAt,
    },
  });
});

statusV2.get("/public/agents/:agentId/metrics", async (c) => {
  const parsed = publicAgentIdSchema.safeParse(c.req.param("agentId"));
  if (!parsed.success) return validation(c);
  const cacheControl = `public, max-age=${getEnvNumber(
    c.env,
    "PUBLIC_METRICS_CACHE_TTL_SECONDS",
    120,
    { min: 0, max: 3600 }
  )}`;
  const cacheKey = publicCacheKey(c.req.raw, "metric-publication-v1");
  const cache = (caches as WorkerCacheStorage).default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedEtag = cached.headers.get("ETag");
    if (cachedEtag && etagMatches(c.req.header("If-None-Match"), cachedEtag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: cachedEtag, "Cache-Control": cacheControl, "X-Cache": "HIT" },
      });
    }
    const response = new Response(cached.body, cached);
    response.headers.set("X-Cache", "HIT");
    return response;
  }

  const result = await handle(c, () =>
    createStatusUseCases(c.env).getPublicAgentMetrics(parsed.data)
  );
  if (result instanceof Response) return result;
  if (etagMatches(c.req.header("If-None-Match"), result.etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: result.etag, "Cache-Control": cacheControl, "X-Cache": "MISS" },
    });
  }
  const response = new Response(result.payloadJson, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      ETag: result.etag,
      "X-Cache": "MISS",
      "X-Publication-Generated-At": result.generatedAt,
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
});

export { statusV2 };
