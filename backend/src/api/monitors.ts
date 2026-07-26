import { Hono } from "hono";
import { JwtPayload } from "../types";
import { Bindings } from "../models/db";
import * as MonitorService from "../services/MonitorService";
import {
  badRequest,
  idParamSchema,
  monitorImportSchema,
  monitorSchema,
  monitorUpdateSchema,
  orderUpdateSchema,
} from "./schemas";

const monitors = new Hono<{ Bindings: Bindings; Variables: { jwtPayload: JwtPayload } }>();

// 获取所有监控
monitors.get("/", async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;

  // 调用服务层获取监控列表
  const result = await MonitorService.getAllMonitors(payload.id);

  return c.json(
    {
      success: result.success,
      monitors: result.monitors,
    },
    result.status as any
  );
});

// 获取所有监控的每日统计数据
monitors.get("/daily", async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;
  // 调用服务层获取所有监控的每日统计数据
  const result = await MonitorService.getAllMonitorDailyStats(payload.id);

  return c.json({
    success: result.success,
    dailyStats: result.dailyStats,
    message: result.message,
  });
});

// 创建监控
monitors.post("/", async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;
  const parsed = monitorSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("监控创建参数无效"), 400);
  }

  // 调用服务层创建监控
  const result = await MonitorService.createMonitor(parsed.data, payload.id, c.env);

  return c.json(
    {
      success: result.success,
      monitor: result.monitor,
      message: result.message,
    },
    result.status as any
  );
});

// 获取所有监控状态历史
monitors.get("/history", async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;
  // 调用服务层获取监控历史
  const result = await MonitorService.getAllMonitorStatusHistory(payload.id);

  return c.json(
    {
      success: result.success,
      history: result.history,
    },
    result.status as any
  );
});

// 手动排序：按 body.ids 的数组顺序写 sort_order（须在 /:id 之前注册）
monitors.put("/order", async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;
  const parsed = orderUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("排序参数无效"), 400);
  }

  const result = await MonitorService.updateMonitorsOrder(
    parsed.data.ids,
    payload.id,
    payload.role
  );
  return c.json(
    { success: result.success, message: result.message },
    result.status as any
  );
});

// 导出监控配置（JSON 数组；须在 /:id 之前注册）
monitors.get("/export", async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;
  const monitorsData = await MonitorService.exportMonitors(payload.id);
  return c.json(monitorsData, 200, {
    "Content-Disposition": 'attachment; filename="xugou-monitors.json"',
    "Cache-Control": "no-store",
  });
});

// 导入监控配置：按 name 去重跳过
monitors.post("/import", async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;
  const parsed = monitorImportSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("监控导入数据无效"), 400);
  }

  try {
    const result = await MonitorService.importMonitors(
      parsed.data,
      payload.id,
      c.env
    );
    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    console.error("导入监控错误:", error);
    return c.json({ success: false, message: "导入监控失败" }, 500);
  }
});

// 获取单个监控
monitors.get("/:id", async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const payload = c.get("jwtPayload") as JwtPayload;

  // 调用服务层获取监控详情
  const result = await MonitorService.getMonitorById(id, payload.id, payload.role);

  return c.json(
    {
      success: result.success,
      monitor: result.monitor,
      message: result.message,
    },
    result.status as any
  );
});

// 更新监控
monitors.put("/:id", async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const parsed = monitorUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("监控更新参数无效"), 400);
  }
  const payload = c.get("jwtPayload") as JwtPayload; // 获取用户信息

  // 调用服务层更新监控，并传入用户信息以进行权限验证
  const result = await MonitorService.updateMonitor(
    id,
    parsed.data,
    payload.id,
    payload.role,
    c.env
  );

  return c.json(
    {
      success: result.success,
      monitor: result.monitor,
      message: result.message,
    },
    result.status as any
  );
});

// 删除监控
monitors.delete("/:id", async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const payload = c.get("jwtPayload") as JwtPayload;

  // 调用服务层删除监控，并传入用户信息以进行权限验证
  const result = await MonitorService.deleteMonitor(id, payload.id, payload.role);

  return c.json(
    {
      success: result.success,
      message: result.message,
    },
    result.status as any
  );
});

// 获取单个监控状态历史
monitors.get("/:id/history", async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const payload = c.get("jwtPayload") as JwtPayload;

  // 调用服务层获取监控历史
  const result = await MonitorService.getMonitorStatusHistoryById(
    id,
    payload.id,
    payload.role
  );

  return c.json(
    {
      success: result.success,
      history: result.history,
      message: result.message,
    },
    result.status as any
  );
});

// 获取单个监控的每日统计数据
monitors.get("/:id/daily", async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const payload = c.get("jwtPayload") as JwtPayload;

  // 调用服务层获取每日统计数据
  const result = await MonitorService.getMonitorDailyStats(id, payload.id, payload.role);

  return c.json({
    success: result.success,
    dailyStats: result.dailyStats,
    message: result.message,
  });
});

// 手动检查单个监控
monitors.post("/:id/check", async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const payload = c.get("jwtPayload") as JwtPayload;

  // 调用服务层手动检查监控，并传入用户信息以进行权限验证
  const result = await MonitorService.manualCheckMonitor(id, payload.id, payload.role);

  return c.json(
    {
      success: result.success,
      message: result.message,
      result: result.result,
    },
    result.status as any
  );
});

export { monitors };
