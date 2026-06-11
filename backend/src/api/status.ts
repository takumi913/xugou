import { Hono } from "hono";
import { JwtPayload } from "../types";
import { Bindings } from "../models/db";
import {
  getStatusPageConfig,
  saveStatusPageConfig,
  getStatusPagePublicData,
  getPublicAgentMetrics,
  StatusPageConfigValidationError,
} from "../services/StatusService";
import { badRequest, statusPageConfigSchema } from "./schemas";
import { getEnvNumber } from "../utils/env";

// 创建API路由
const status = new Hono<{
  Bindings: Bindings;
  Variables: { jwtPayload: JwtPayload };
}>();
const STATUS_PAGE_CACHE_TTL_SECONDS = 30;
const PUBLIC_METRICS_CACHE_TTL_SECONDS = 120;

type WorkerCacheStorage = CacheStorage & {
  default: Cache;
};

function jsonWithEtag(data: unknown) {
  const body = JSON.stringify(data);
  let hash = 2166136261;
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return {
    body,
    etag: `W/"${(hash >>> 0).toString(36)}-${body.length}"`,
  };
}

function etagMatches(ifNoneMatch: string | undefined, etag: string | null) {
  if (!ifNoneMatch || !etag) {
    return false;
  }
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim())
    .includes(etag);
}

function notModifiedResponse(
  etag: string,
  cacheControl: string,
  cacheState: "HIT" | "MISS"
) {
  return new Response(null, {
    status: 304,
    headers: {
      ETag: etag,
      "Cache-Control": cacheControl,
      "X-Cache": cacheState,
    },
  });
}

// 获取状态页配置(管理员)
status.get("/config", async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;
  const userId = payload.id;

  try {
    const config = await getStatusPageConfig(userId);
    return c.json(config);
  } catch (error) {
    console.error("获取状态页配置失败:", error);
    return c.json({ error: "获取状态页配置失败" }, 500);
  }
});

// 保存状态页配置
status.post("/config", async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;
  const userId = payload.id;
  const parsed = statusPageConfigSchema.safeParse(await c.req.json());

  if (!parsed.success) {
    return c.json(badRequest("状态页配置参数无效"), 400);
  }

  try {
    const result = await saveStatusPageConfig(userId, parsed.data, c.env);
    return c.json(result);
  } catch (error) {
    if (error instanceof StatusPageConfigValidationError) {
      return c.json(badRequest(error.message), 400);
    }
    console.error("保存状态页配置失败:", error);
    return c.json({ error: "保存状态页配置失败" }, 500);
  }
});

status.get("/public/:userId/data", async (c) => {
  const userId = parseInt(c.req.param("userId"));
  if (isNaN(userId)) {
    return c.json({ error: "无效的用户ID" }, 400);
  }

  const cacheKey = new Request(c.req.url, c.req.raw);
  const cache = (caches as WorkerCacheStorage).default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    const cachedEtag = cachedResponse.headers.get("ETag");
    const cacheControl =
      cachedResponse.headers.get("Cache-Control") ?? "public, max-age=30";
    if (etagMatches(c.req.header("If-None-Match"), cachedEtag)) {
      return notModifiedResponse(cachedEtag as string, cacheControl, "HIT");
    }

    const response = new Response(cachedResponse.body, cachedResponse);
    response.headers.set("X-Cache", "HIT");
    return response;
  }

  const result = await getStatusPagePublicData(userId, c.env, (promise) =>
    c.executionCtx.waitUntil(promise)
  );
  const { body, etag } = jsonWithEtag(result);
  const cacheControl = `public, max-age=${getEnvNumber(
    c.env,
    "STATUS_PAGE_CACHE_TTL_SECONDS",
    STATUS_PAGE_CACHE_TTL_SECONDS,
    { min: 0, max: 3600 }
  )}`;

  if (etagMatches(c.req.header("If-None-Match"), etag)) {
    return notModifiedResponse(etag, cacheControl, "MISS");
  }

  const response = new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
      ETag: etag,
      "X-Cache": "MISS",
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
});

status.get("/public/:userId/agents/:agentId/metrics", async (c) => {
  const userId = parseInt(c.req.param("userId"));
  const agentId = parseInt(c.req.param("agentId"));
  if (isNaN(userId) || isNaN(agentId)) {
    return c.json({ error: "无效的ID" }, 400);
  }

  const cacheKey = new Request(c.req.url, c.req.raw);
  const cache = (caches as WorkerCacheStorage).default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    const cachedEtag = cachedResponse.headers.get("ETag");
    const cacheControl =
      cachedResponse.headers.get("Cache-Control") ?? "public, max-age=120";
    if (etagMatches(c.req.header("If-None-Match"), cachedEtag)) {
      return notModifiedResponse(cachedEtag as string, cacheControl, "HIT");
    }

    const response = new Response(cachedResponse.body, cachedResponse);
    response.headers.set("X-Cache", "HIT");
    return response;
  }

  const result = await getPublicAgentMetrics(userId, agentId);
  const payload = {
    success: result.success,
    agent: result.metrics,
    message: result.message,
  };
  const { body, etag } = jsonWithEtag(payload);
  const cacheControl = `public, max-age=${getEnvNumber(
    c.env,
    "PUBLIC_METRICS_CACHE_TTL_SECONDS",
    PUBLIC_METRICS_CACHE_TTL_SECONDS,
    { min: 0, max: 3600 }
  )}`;

  if (etagMatches(c.req.header("If-None-Match"), etag)) {
    return notModifiedResponse(etag, cacheControl, "MISS");
  }

  const response = new Response(body, {
    status: result.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
      ETag: etag,
      "X-Cache": "MISS",
    },
  });

  if (result.success) {
    await cache.put(cacheKey, response.clone());
  }

  return response;
});

export { status };
