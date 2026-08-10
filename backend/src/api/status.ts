import { Hono } from "hono";
import { AdminSessionPrincipal } from "../types";
import { Bindings } from "../models/db";
import { badRequest, statusPageConfigSchema } from "./schemas";
import { getEnvNumber } from "../utils/env";
import { createStatusUseCases } from "../modules/status/composition";
import { ApplicationProblem } from "../shared/errors/ApplicationProblem";

// 创建API路由
const status = new Hono<{
  Bindings: Bindings;
  Variables: { admin: AdminSessionPrincipal };
}>();
const STATUS_PAGE_CACHE_TTL_SECONDS = 30;
const PUBLIC_METRICS_CACHE_TTL_SECONDS = 120;
const PUBLIC_STATUS_CACHE_SCHEMA_VERSION = "2";

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

function getPublicStatusCacheKey(request: Request) {
  const url = new URL(request.url);
  url.searchParams.set(
    "__xugou_public_schema",
    PUBLIC_STATUS_CACHE_SCHEMA_VERSION
  );
  return new Request(url.toString(), request);
}

// 获取状态页配置(管理员)
status.get("/config", async (c) => {
  try {
    const config = await createStatusUseCases(c.env).getConfig();
    return c.json(config);
  } catch (error) {
    return c.json({ error: "获取状态页配置失败" }, 500);
  }
});

// 保存状态页配置
status.post("/config", async (c) => {
  const parsed = statusPageConfigSchema.safeParse(await c.req.json());

  if (!parsed.success) {
    return c.json(badRequest("状态页配置参数无效"), 400);
  }

  try {
    const result = await createStatusUseCases(c.env).saveConfig(parsed.data);
    return c.json(result);
  } catch (error) {
    if (error instanceof ApplicationProblem && error.status === 400) {
      return c.json(badRequest(error.message), 400);
    }
    return c.json({ error: "保存状态页配置失败" }, 500);
  }
});

status.get("/public/data", async (c) => {
  // 使用版本化内部 Cache Key，部署白名单投影后不会命中旧版敏感快照。
  const cacheKey = getPublicStatusCacheKey(c.req.raw);
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

  let publication;
  try {
    publication = await createStatusUseCases(c.env).getPublicData();
  } catch (error) {
    if (error instanceof ApplicationProblem && error.code === "PUBLICATION_NOT_READY") {
      c.header("Retry-After", "30");
      return c.json(
        { success: false, code: error.code, message: error.message },
        503
      );
    }
    throw error;
  }
  const body = publication.payloadJson;
  const etag = publication.etag || jsonWithEtag(JSON.parse(body)).etag;
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

status.get("/public/agents/:agentId/metrics", async (c) => {
  const agentId = parseInt(c.req.param("agentId"));
  if (isNaN(agentId)) {
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

  let publication;
  try {
    publication = await createStatusUseCases(c.env).getPublicAgentMetrics(agentId);
  } catch (error) {
    if (error instanceof ApplicationProblem && error.status === 404) {
      return c.json({ success: false, agent: [], message: error.message }, 404);
    }
    throw error;
  }
  const body = publication.payloadJson;
  const etag = publication.etag;
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
    status: 200,
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

export { status };
