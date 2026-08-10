import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Bindings } from "../models/db";
import type { AdminSessionPrincipal } from "../types";
import { createNotificationUseCases } from "../modules/notifications/composition";
import { queryLegacyNotificationHistory } from "../modules/notifications/persistence/D1LegacyNotificationQuery";
import { writeSecurityAuditEvent } from "../platform/security/SecurityStore";
import { ApplicationProblem } from "../shared/errors/ApplicationProblem";
import {
  notificationHistoryQuerySchema,
  notificationSettingsSchema,
} from "./schemas";
import { validateNotificationChannelConfig } from "../modules/notifications/http/channel-config";
import {
  channelCreateSchema,
  channelUpdateSchema,
  templateCreateSchema,
  templateUpdateSchema,
} from "../modules/notifications/http/schemas";

const notifications = new Hono<{
  Bindings: Bindings;
  Variables: { admin: AdminSessionPrincipal };
}>();
type NotificationContext = Context<{
  Bindings: Bindings;
  Variables: { admin: AdminSessionPrincipal };
}>;

// v1 只做响应形状适配；写入 Contract 直接复用模块 Schema，防止兼容路由漂移。
const legacyTemplateCreateSchema = templateCreateSchema.extend({
  is_default: z.boolean().default(false),
});

function parseId(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function legacyError(error: unknown, fallback: string) {
  if (error instanceof ApplicationProblem) {
    return {
      status: error.status,
      body: { success: false, message: error.message },
    };
  }
  return { status: 500, body: { success: false, message: fallback } };
}

async function auditChannel(
  c: NotificationContext,
  eventType: string,
  subjectId: number | null,
  metadata?: Record<string, string | number | boolean | null | undefined>
) {
  await writeSecurityAuditEvent(c.env, {
    eventType,
    outcome: "success",
    actorType: "admin",
    actorId: c.get("admin").id,
    subjectType: "notification_channel",
    subjectId,
    request: c.req.raw,
    metadata,
  });
}

notifications.get("/", async (c) => {
  try {
    return c.json({
      success: true,
      data: await createNotificationUseCases(c.env).getConfig(),
    });
  } catch (error) {
    const failure = legacyError(error, "获取通知配置失败");
    return c.json(failure.body, failure.status as 404 | 500);
  }
});

notifications.get("/channels", async (c) =>
  c.json({
    success: true,
    data: await createNotificationUseCases(c.env).listChannels(),
  })
);

notifications.get("/channels/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ success: false, message: "无效的渠道ID" }, 400);
  try {
    return c.json({
      success: true,
      data: await createNotificationUseCases(c.env).getChannel(id),
    });
  } catch (error) {
    const failure = legacyError(error, "获取通知渠道失败");
    return c.json(failure.body, failure.status as 404 | 500);
  }
});

notifications.post("/channels", async (c) => {
  const parsed = channelCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, message: "渠道配置无效" }, 400);
  const config = validateNotificationChannelConfig(parsed.data.type, parsed.data.config);
  if (!config.success) {
    return c.json({ success: false, message: config.message ?? "渠道配置无效" }, 400);
  }
  try {
    const result = await createNotificationUseCases(c.env).createChannel({
      ...parsed.data,
      config: JSON.stringify(config.config),
    });
    await auditChannel(c, "notification.channel.create", result.id ?? null, {
      channel_type: parsed.data.type,
    });
    return c.json(
      { success: true, data: { id: result.id }, message: "通知渠道创建成功" },
      201
    );
  } catch (error) {
    const failure = legacyError(error, "创建通知渠道失败");
    return c.json(failure.body, failure.status as 404 | 500);
  }
});

notifications.put("/channels/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ success: false, message: "无效的渠道ID" }, 400);
  const parsed = channelUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, message: "渠道配置无效" }, 400);
  try {
    const useCases = createNotificationUseCases(c.env);
    const current = await useCases.getChannel(id);
    const mutation: { name?: string; type?: string; config?: string; enabled?: boolean } = {
      name: parsed.data.name,
      type: parsed.data.type,
      enabled: parsed.data.enabled,
    };
    if (parsed.data.config !== undefined) {
      const type = parsed.data.type ?? String(current.type);
      const prepared = await useCases.prepareChannelConfig(id, type, parsed.data.config);
      if (!prepared) return c.json({ success: false, message: "通知渠道不存在" }, 404);
      const config = validateNotificationChannelConfig(type, prepared);
      if (!config.success) {
        return c.json({ success: false, message: config.message ?? "渠道配置无效" }, 400);
      }
      mutation.config = JSON.stringify(config.config);
    }
    await useCases.updateChannel(id, mutation);
    await auditChannel(c, "notification.channel.update", id, {
      secret_changed: parsed.data.config !== undefined,
    });
    return c.json({ success: true, message: "通知渠道更新成功" });
  } catch (error) {
    const failure = legacyError(error, "更新通知渠道失败");
    return c.json(failure.body, failure.status as 404 | 500);
  }
});

notifications.delete("/channels/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ success: false, message: "无效的渠道ID" }, 400);
  try {
    await createNotificationUseCases(c.env).deleteChannel(id);
    await auditChannel(c, "notification.channel.delete", id);
    return c.json({ success: true, message: "通知渠道删除成功" });
  } catch (error) {
    const failure = legacyError(error, "删除通知渠道失败");
    return c.json(failure.body, failure.status as 404 | 500);
  }
});

notifications.post("/channels/:id/test", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ success: false, message: "无效的渠道ID" }, 400);
  try {
    await createNotificationUseCases(c.env).testChannel(id);
    return c.json({ success: true, message: "测试通知发送成功" });
  } catch (error) {
    const failure = legacyError(error, "测试通知发送失败");
    return c.json(failure.body, failure.status as 404 | 500);
  }
});

notifications.get("/templates", async (c) =>
  c.json({
    success: true,
    data: await createNotificationUseCases(c.env).listTemplates(),
  })
);

notifications.get("/templates/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ success: false, message: "无效的模板ID" }, 400);
  try {
    return c.json({
      success: true,
      data: await createNotificationUseCases(c.env).getTemplate(id),
    });
  } catch (error) {
    const failure = legacyError(error, "获取通知模板失败");
    return c.json(failure.body, failure.status as 404 | 500);
  }
});

notifications.post("/templates", async (c) => {
  const parsed = legacyTemplateCreateSchema.safeParse(
    await c.req.json().catch(() => null)
  );
  if (!parsed.success) return c.json({ success: false, message: "模板参数无效" }, 400);
  try {
    const result = await createNotificationUseCases(c.env).createTemplate(parsed.data);
    return c.json(
      { success: true, data: { id: result.id }, message: "通知模板创建成功" },
      201
    );
  } catch (error) {
    const failure = legacyError(error, "创建通知模板失败");
    return c.json(failure.body, failure.status as 404 | 500);
  }
});

notifications.put("/templates/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ success: false, message: "无效的模板ID" }, 400);
  const parsed = templateUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, message: "模板参数无效" }, 400);
  try {
    await createNotificationUseCases(c.env).updateTemplate(id, parsed.data);
    return c.json({ success: true, message: "通知模板更新成功" });
  } catch (error) {
    const failure = legacyError(error, "更新通知模板失败");
    return c.json(failure.body, failure.status as 404 | 500);
  }
});

notifications.delete("/templates/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ success: false, message: "无效的模板ID" }, 400);
  try {
    await createNotificationUseCases(c.env).deleteTemplate(id);
    return c.json({ success: true, message: "通知模板删除成功" });
  } catch (error) {
    const failure = legacyError(error, "删除通知模板失败");
    return c.json(failure.body, failure.status as 404 | 500);
  }
});

notifications.post("/settings", async (c) => {
  const parsed = notificationSettingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, message: "通知设置无效" }, 400);
  try {
    const result = await createNotificationUseCases(c.env).saveSetting({
      target_type: parsed.data.target_type,
      target_id: parsed.data.target_id ?? 0,
      enabled: parsed.data.enabled,
      on_down: parsed.data.on_down ?? false,
      on_recovery: parsed.data.on_recovery ?? false,
      on_offline: parsed.data.on_offline ?? false,
      on_cpu_threshold: parsed.data.on_cpu_threshold ?? false,
      cpu_threshold: parsed.data.cpu_threshold ?? 90,
      on_memory_threshold: parsed.data.on_memory_threshold ?? false,
      memory_threshold: parsed.data.memory_threshold ?? 90,
      on_disk_threshold: parsed.data.on_disk_threshold ?? false,
      disk_threshold: parsed.data.disk_threshold ?? 90,
      cooldown_minutes: parsed.data.cooldown_minutes ?? 30,
      channels:
        typeof parsed.data.channels === "string"
          ? parsed.data.channels
          : JSON.stringify(parsed.data.channels),
    });
    return c.json({
      success: true,
      message: "通知设置保存成功",
      data: { id: result.id },
    });
  } catch (error) {
    const failure = legacyError(error, "保存通知设置失败");
    return c.json(failure.body, failure.status as 404 | 500);
  }
});

notifications.get("/history", async (c) => {
  const parsed = notificationHistoryQuerySchema.safeParse({
    type: c.req.query("type") || undefined,
    target_id: c.req.query("target_id") || undefined,
    status: c.req.query("status") || undefined,
    limit: c.req.query("limit") || undefined,
    page: c.req.query("page") || undefined,
  });
  if (!parsed.success) {
    return c.json({ success: false, message: "通知历史分页参数无效" }, 400);
  }
  const { type, target_id, status, limit, page } = parsed.data;
  const result = await queryLegacyNotificationHistory(c.env, {
    type,
    targetId: target_id,
    status,
    limit,
    offset: (page - 1) * limit,
  });
  return c.json({ success: true, data: { ...result, page, limit } });
});

export { notifications };
