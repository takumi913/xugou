import { Hono } from "hono";

import { Bindings } from "./models/db";
import * as middlewares from "./middlewares";
import * as jobs from "./jobs";
import * as api from "./api";
import { monitorsV2 } from "./modules/monitors";
import { agentsV2 } from "./modules/agents";
import { dispatchQueueBatch } from "./platform/queues/QueueDispatcher";
import { relayPendingQueueWork } from "./platform/queues/OutboxRelay";
import { scheduleDueMonitorChecks } from "./modules/monitors/queue/MonitorScheduler";
import { operationsV2 } from "./modules/operations";
import { statusV2 } from "./modules/status";
import { notificationsV2 } from "./modules/notifications";
import {
  ensureInitialStatusPublication,
  requestStatusRebuild,
} from "./modules/status/persistence/status-events";
import {
  createTraceId,
  INTERNAL_TRACE_HEADER,
  RESPONSE_TRACE_HEADER,
  writeStructuredLog,
} from "./platform/observability/StructuredLogger";
import { isV2ApiRequest, problemResponse } from "./platform/http/problem";

// 导出同一 Worker Bundle 内按 Agent 分片的 Durable Object。
export { AgentRoom } from "./durable/AgentRoom";

// 创建Hono应用
const app = new Hono<{ Bindings: Bindings }>();

app.onError((error, c) => {
  if (isV2ApiRequest(c)) {
    return problemResponse(c, {
      status: 500,
      code: "INTERNAL_ERROR",
      title: "Internal server error",
    });
  }
  return c.json({ success: false, message: "Internal Server Error" }, 500);
});

// 中间件
app.use("*", async (c, next) => {
  const startedAt = performance.now();
  const traceId = createTraceId(c.req.raw.headers);
  try {
    await next();
    c.header(RESPONSE_TRACE_HEADER, traceId);
    writeStructuredLog(c.env, {
      service: "http",
      operation: "http_request",
      result: c.res.status >= 500 ? "failure" : "success",
      traceId,
      durationMs: performance.now() - startedAt,
      errorCode: c.res.status >= 400 ? `HTTP_${c.res.status}` : undefined,
      fields: {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
      },
    });
  } catch (error) {
    writeStructuredLog(c.env, {
      service: "http",
      operation: "http_request",
      result: "failure",
      traceId,
      durationMs: performance.now() - startedAt,
      errorCode: "UNHANDLED_HTTP_ERROR",
      error,
      fields: {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
      },
    });
    throw error;
  }
});
app.use("*", middlewares.corsMiddleware);
app.use("/api/*", middlewares.apiBodyLimitMiddleware);

app.use("*", middlewares.adminSessionMiddleware);

// 公共路由
app.get("/", (c) => c.json({ message: "XUGOU API 服务正在运行" }));

// 路由注册
app.route("/api/ws", api.ws);
app.route("/api/v2/monitors", monitorsV2);
app.route("/api/v2/agents", agentsV2);
app.route("/api/v2/operations", operationsV2);
app.route("/api/v2/status", statusV2);
app.route("/api/v2/notifications", notificationsV2);
// Session/Profile/Dashboard 复用模块 Handler，避免复制领域逻辑。
app.route("/api/v2/session", api.auth);
app.route("/api/v2/profile", api.profile);
app.route("/api/v2/dashboard", api.dashboard);

// 静态文件路由 - 处理所有非 API 请求，返回前端应用
app.get("*", async (c) => {
  const url = new URL(c.req.url);

  // 如果是 API 路由，跳过静态文件处理
  if (url.pathname.startsWith("/api/")) {
    return c.notFound();
  }

  try {
    // 尝试获取请求的静态文件
    const asset = await c.env.ASSETS.fetch(c.req.url);

    // 如果文件存在，直接返回
    if (asset.status === 200) {
      return asset;
    }

    // 如果文件不存在，返回 index.html 以支持 React Router
    const indexUrl = new URL("/index.html", c.req.url);
    const indexAsset = await c.env.ASSETS.fetch(indexUrl.toString());

    if (indexAsset.status === 200) {
      // 设置正确的 Content-Type
      const response = new Response(indexAsset.body, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache"
        }
      });
      return response;
    }

    return c.notFound();
  } catch (error) {
    return c.text("Internal Server Error", 500);
  }
});
// 导出 fetch 函数供 Cloudflare Workers 使用
export default {
  // 处理 HTTP 请求
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    // 内部 Trace Header 在入口统一覆盖，避免客户端伪造关联标识。
    const headers = new Headers(request.headers);
    headers.set(INTERNAL_TRACE_HEADER, createTraceId(request.headers));
    return app.fetch(new Request(request, { headers }), env, ctx);
  },

  // 添加定时任务，每分钟执行一次监控检查和客户端状态检查
  async scheduled(
    event: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext
  ) {
    const startedAt = performance.now();
    const traceId = crypto.randomUUID();
    try {
      // 周期检查直接执行；Queue 只承载状态变化、通知和合并后的状态页重建事件。
      const scheduledAt = Number.isFinite(Number(event.scheduledTime))
        ? new Date(Number(event.scheduledTime))
        : new Date();
      await scheduleDueMonitorChecks(env, scheduledAt);
      await ensureInitialStatusPublication(env);
      if (scheduledAt.getUTCMinutes() % 5 === 0) {
        await requestStatusRebuild(env, {
          reason: "periodic.metrics",
          aggregateType: "status_page",
          aggregateId: 1,
          coalesceSeconds: 300,
        });
      }
      // Queue 投递失败后的持久化补偿只处理低频 Outbox。
      await relayPendingQueueWork(env);
      await jobs.runScheduledTasks(event, env, ctx);
      writeStructuredLog(env, {
        service: "cron",
        operation: "scheduled_tick",
        result: "success",
        traceId,
        durationMs: performance.now() - startedAt,
        fields: { cron: event.cron, scheduled_at: event.scheduledTime },
      });
    } catch (error) {
      writeStructuredLog(env, {
        service: "cron",
        operation: "scheduled_tick",
        result: "failure",
        traceId,
        durationMs: performance.now() - startedAt,
        errorCode: "SCHEDULED_TICK_FAILED",
        error,
        fields: { cron: event.cron, scheduled_at: event.scheduledTime },
      });
      // 将整个 Cron Tick 标记为失败，避免结构化日志记录了异常但平台仍显示成功。
      throw error;
    }
  },

  // 与 fetch/scheduled 共用同一 Worker Bundle 的唯一 Queue Consumer 入口。
  async queue(
    batch: MessageBatch<unknown>,
    env: Bindings,
    _ctx: ExecutionContext
  ) {
    const startedAt = performance.now();
    const traceId = crypto.randomUUID();
    try {
      await dispatchQueueBatch(batch, env, traceId);
      writeStructuredLog(env, {
        service: "queue",
        operation: "queue_batch",
        result: "success",
        traceId,
        durationMs: performance.now() - startedAt,
        fields: { queue: batch.queue, message_count: batch.messages.length },
      });
    } catch (error) {
      writeStructuredLog(env, {
        service: "queue",
        operation: "queue_batch",
        result: "failure",
        traceId,
        durationMs: performance.now() - startedAt,
        errorCode: "QUEUE_BATCH_FAILED",
        error,
        fields: { queue: batch.queue, message_count: batch.messages.length },
      });
      throw error;
    }
  },
};
