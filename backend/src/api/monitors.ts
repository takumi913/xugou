import { Hono } from "hono";
import type { Bindings } from "../models/db";
import type { AdminSessionPrincipal } from "../types";
import { createMonitorUseCases } from "../modules/monitors/composition";
import {
  importLegacyMonitors,
  listLegacyMonitors,
  queryMonitorDailyStats,
  queryMonitorHistory,
  toLegacyMonitor,
  toMonitorMutation,
  toMonitorUpdate,
  updateLegacyMonitorOrder,
} from "../modules/monitors/persistence/D1LegacyMonitorFacade";
import { scheduleMonitorCheckNow } from "../modules/monitors/queue/MonitorScheduler";
import { requestStatusRebuild } from "../modules/status/persistence/status-events";
import { ApplicationProblem } from "../shared/errors/ApplicationProblem";
import {
  badRequest,
  idParamSchema,
  monitorImportSchema,
  monitorSchema,
  monitorUpdateSchema,
  orderUpdateSchema,
} from "./schemas";
import { streamJsonArrayResponse } from "../platform/http/stream-json";

const monitors = new Hono<{
  Bindings: Bindings;
  Variables: { admin: AdminSessionPrincipal };
}>();

function legacyFailure(error: unknown, fallback: string) {
  if (error instanceof ApplicationProblem) {
    return {
      success: false,
      message: error.status === 404 ? "监控不存在或无权访问" : fallback,
      status: error.status,
    };
  }
  return { success: false, message: fallback, status: 500 };
}

monitors.get("/", async (c) =>
  c.json({ success: true, monitors: await listLegacyMonitors(c.env) })
);

monitors.get("/daily", async (c) =>
  c.json({
    success: true,
    dailyStats: await queryMonitorDailyStats(c.env),
    message: "获取所有监控的每日统计数据成功",
  })
);

monitors.post("/", async (c) => {
  const parsed = monitorSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json(badRequest("监控创建参数无效"), 400);
  try {
    const monitor = await createMonitorUseCases(c.env).create(
      toMonitorMutation(parsed.data)
    );
    await requestStatusRebuild(c.env, {
      reason: "monitor.created",
      aggregateType: "monitor",
      aggregateId: monitor.id,
    });
    return c.json({ success: true, monitor: toLegacyMonitor(monitor) }, 201);
  } catch (error) {
    const failure = legacyFailure(error, "创建监控失败");
    return c.json(failure, failure.status as 400 | 404 | 409 | 500);
  }
});

monitors.get("/history", async (c) =>
  c.json({ success: true, history: await queryMonitorHistory(c.env) })
);

monitors.put("/order", async (c) => {
  const parsed = orderUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json(badRequest("排序参数无效"), 400);
  const updated = await updateLegacyMonitorOrder(c.env, parsed.data.ids);
  return c.json(
    {
      success: updated,
      message: updated ? "排序已更新" : "监控不存在或无权访问",
    },
    updated ? 200 : 400
  );
});

monitors.get("/export", async (c) => {
  const useCases = createMonitorUseCases(c.env);
  return streamJsonArrayResponse({
    filename: "xugou-monitors.json",
    loadPage: (cursor?: string) => useCases.list({ cursor, limit: 100 }),
    map: (view) => {
      const monitor = toLegacyMonitor(view);
      return {
        name: monitor.name,
        url: monitor.url,
        method: monitor.method,
        interval: monitor.interval,
        timeout: monitor.timeout,
        expected_status: monitor.expected_status,
        headers: monitor.headers,
        body: monitor.body,
        active: Boolean(monitor.active),
        sort_order: monitor.sort_order,
      };
    },
  });
});

monitors.post("/import", async (c) => {
  const parsed = monitorImportSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json(badRequest("监控导入数据无效"), 400);
  const items = parsed.data.map((item) => ({
    ...toMonitorMutation(item),
    sort_order: item.sort_order,
  }));
  return c.json({ success: true, ...(await importLegacyMonitors(c.env, items)) });
});

monitors.get("/:id", async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  try {
    const monitor = await createMonitorUseCases(c.env).get(id);
    return c.json({
      success: true,
      monitor: {
        ...toLegacyMonitor(monitor),
        history: await queryMonitorHistory(c.env, id),
      },
    });
  } catch (error) {
    const failure = legacyFailure(error, "获取监控失败");
    return c.json(failure, failure.status as 404 | 409 | 500);
  }
});

monitors.put("/:id", async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const parsed = monitorUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json(badRequest("监控更新参数无效"), 400);
  try {
    const monitor = await createMonitorUseCases(c.env).update(
      id,
      toMonitorUpdate(parsed.data)
    );
    await requestStatusRebuild(c.env, {
      reason: "monitor.updated",
      aggregateType: "monitor",
      aggregateId: id,
    });
    return c.json({ success: true, monitor: toLegacyMonitor(monitor) });
  } catch (error) {
    const failure = legacyFailure(error, "更新监控失败");
    return c.json(failure, failure.status as 404 | 409 | 500);
  }
});

monitors.delete("/:id", async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  try {
    await createMonitorUseCases(c.env).delete(id);
    await requestStatusRebuild(c.env, {
      reason: "monitor.deleted",
      aggregateType: "monitor",
      aggregateId: id,
    });
    return c.json({ success: true, message: "监控已删除" });
  } catch (error) {
    const failure = legacyFailure(error, "删除监控失败");
    return c.json(failure, failure.status as 404 | 409 | 500);
  }
});

monitors.get("/:id/history", async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  try {
    await createMonitorUseCases(c.env).get(id);
    return c.json({ success: true, history: await queryMonitorHistory(c.env, id) });
  } catch (error) {
    const failure = legacyFailure(error, "获取监控历史失败");
    return c.json(failure, failure.status as 404 | 409 | 500);
  }
});

monitors.get("/:id/daily", async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  try {
    await createMonitorUseCases(c.env).get(id);
    return c.json({
      success: true,
      dailyStats: await queryMonitorDailyStats(c.env, id),
      message: "获取监控每日统计数据成功",
    });
  } catch (error) {
    const failure = legacyFailure(error, "获取监控每日统计数据失败");
    return c.json({ ...failure, dailyStats: [] }, failure.status as 404 | 409 | 500);
  }
});

monitors.post("/:id/check", async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const scheduled = await scheduleMonitorCheckNow(c.env, id);
  if (!scheduled) {
    return c.json({ success: false, message: "监控不存在或无权访问" }, 404);
  }
  return c.json({
    success: true,
    message: "监控检查已进入队列",
    result: { status: "pending" },
  });
});

export { monitors };
