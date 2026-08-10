import { Hono, type Context } from "hono";
import type { Bindings } from "../../../models/db";
import type { AuthVariables } from "../../../types";
import {
  applicationProblemResponse,
  problemResponse,
} from "../../../platform/http/problem";
import { ApplicationProblem } from "../../../shared/errors/ApplicationProblem";
import { writeSecurityAuditEvent } from "../../../platform/security/SecurityStore";
import { validateNotificationChannelConfig } from "./channel-config";
import { sha256Hex } from "../../../utils/crypto";
import { createNotificationUseCases } from "../composition";
import {
  channelCreateSchema,
  channelUpdateSchema,
  historyQuerySchema,
  notificationIdSchema,
  notificationResourceListSchema,
  notificationSettingV2Schema,
  notificationSettingsBulkSchema,
  notificationIdempotencyKeySchema,
  templateCreateSchema,
  templateUpdateSchema,
} from "./schemas";

const notificationsV2 = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();
type AppContext = Context<{ Bindings: Bindings; Variables: AuthVariables }>;

function validation(c: AppContext, errors?: Record<string, string[]>) {
  return problemResponse(c, {
    status: 400,
    code: "VALIDATION_ERROR",
    title: "Request validation failed",
    errors,
  });
}

function zodErrors(
  issues: Array<{ path: PropertyKey[]; message: string }>,
  prefix?: string
) {
  const errors: Record<string, string[]> = {};
  for (const issue of issues) {
    const path = issue.path.join(".");
    const key = [prefix, path].filter(Boolean).join(".") || "request";
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
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

async function audit(
  c: AppContext,
  eventType: string,
  subjectId?: number,
  metadata?: Record<string, string | number | boolean | null | undefined>
) {
  await writeSecurityAuditEvent(c.env, {
    eventType,
    outcome: "success",
    actorType: "admin",
    actorId: c.get("admin").id,
    subjectType: subjectId === undefined ? undefined : "notification_channel",
    subjectId: subjectId ?? null,
    request: c.req.raw,
    metadata,
  });
}

notificationsV2.get("/", async (c) => {
  const result = await handle(c, () => createNotificationUseCases(c.env).getConfig());
  return result instanceof Response ? result : c.json({ data: result });
});

notificationsV2.get("/channels", async (c) => {
  const result = await handle(c, () => createNotificationUseCases(c.env).listChannels());
  return result instanceof Response ? result : c.json({ data: result });
});

notificationsV2.get("/channels/:id", async (c) => {
  const id = notificationIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return validation(c);
  const result = await handle(c, () => createNotificationUseCases(c.env).getChannel(id.data));
  return result instanceof Response ? result : c.json({ data: result });
});

notificationsV2.post("/channels", async (c) => {
  const parsed = channelCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validation(c);
  const config = validateNotificationChannelConfig(parsed.data.type, parsed.data.config);
  if (!config.success) return validation(c);
  const result = await handle(c, () =>
    createNotificationUseCases(c.env).createChannel({
      ...parsed.data,
      config: JSON.stringify(config.config),
    })
  );
  if (result instanceof Response) return result;
  await audit(c, "notification.channel.create", result.id, {
    channel_type: parsed.data.type,
  });
  return c.json({ data: { id: result.id } }, 201);
});

notificationsV2.patch("/channels/:id", async (c) => {
  const id = notificationIdSchema.safeParse(c.req.param("id"));
  const parsed = channelUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!id.success || !parsed.success) return validation(c);
  const useCases = createNotificationUseCases(c.env);
  const current = await handle(c, () => useCases.getChannel(id.data));
  if (current instanceof Response) return current;
  const mutation: {
    name?: string;
    type?: string;
    config?: string;
    enabled?: boolean;
  } = { ...parsed.data, config: undefined };
  if (parsed.data.config !== undefined) {
    const type = parsed.data.type ?? String(current.type);
    const prepared = await handle(c, () =>
      useCases.prepareChannelConfig(id.data, type, parsed.data.config)
    );
    if (prepared instanceof Response) return prepared;
    if (!prepared) {
      return problemResponse(c, {
        status: 404,
        code: "CHANNEL_NOT_FOUND",
        title: "Notification channel not found",
      });
    }
    const config = validateNotificationChannelConfig(type, prepared);
    if (!config.success) return validation(c);
    mutation.config = JSON.stringify(config.config);
  }
  const result = await handle(c, () => useCases.updateChannel(id.data, mutation));
  if (result instanceof Response) return result;
  await audit(c, "notification.channel.update", id.data, {
    secret_changed: parsed.data.config !== undefined,
  });
  return c.json({ data: { id: id.data } });
});

notificationsV2.delete("/channels/:id", async (c) => {
  const id = notificationIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return validation(c);
  const result = await handle(c, () => createNotificationUseCases(c.env).deleteChannel(id.data));
  if (result instanceof Response) return result;
  await audit(c, "notification.channel.delete", id.data);
  return c.body(null, 204);
});

notificationsV2.post("/channels/:id/test", async (c) => {
  const id = notificationIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return validation(c);
  const result = await handle(c, () => createNotificationUseCases(c.env).testChannel(id.data));
  return result instanceof Response ? result : c.json({ data: { delivered: true } });
});

notificationsV2.get("/templates", async (c) => {
  const result = await handle(c, () => createNotificationUseCases(c.env).listTemplates());
  return result instanceof Response ? result : c.json({ data: result });
});

notificationsV2.get("/templates/:id", async (c) => {
  const id = notificationIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return validation(c);
  const result = await handle(c, () => createNotificationUseCases(c.env).getTemplate(id.data));
  return result instanceof Response ? result : c.json({ data: result });
});

notificationsV2.get("/resource-settings", async (c) => {
  const parsed = notificationResourceListSchema.safeParse(c.req.query());
  if (!parsed.success) return validation(c);
  const result = await handle(c, () =>
    createNotificationUseCases(c.env).listResourceSettings(parsed.data)
  );
  return result instanceof Response ? result : c.json(result);
});

notificationsV2.post("/templates", async (c) => {
  const parsed = templateCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validation(c);
  const result = await handle(c, () => createNotificationUseCases(c.env).createTemplate(parsed.data));
  return result instanceof Response ? result : c.json({ data: { id: result.id } }, 201);
});

notificationsV2.patch("/templates/:id", async (c) => {
  const id = notificationIdSchema.safeParse(c.req.param("id"));
  const parsed = templateUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!id.success || !parsed.success) return validation(c);
  const result = await handle(c, () =>
    createNotificationUseCases(c.env).updateTemplate(id.data, parsed.data)
  );
  return result instanceof Response ? result : c.json({ data: { id: id.data } });
});

notificationsV2.delete("/templates/:id", async (c) => {
  const id = notificationIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return validation(c);
  const result = await handle(c, () => createNotificationUseCases(c.env).deleteTemplate(id.data));
  return result instanceof Response ? result : c.body(null, 204);
});

notificationsV2.put("/settings", async (c) => {
  const parsed = notificationSettingV2Schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validation(c);
  const result = await handle(c, () =>
    createNotificationUseCases(c.env).saveSetting({
      ...parsed.data,
      channels: JSON.stringify(parsed.data.channels),
    })
  );
  return result instanceof Response ? result : c.json({ data: { id: result.id } });
});

notificationsV2.put("/settings/bulk", async (c) => {
  const idempotencyKey = notificationIdempotencyKeySchema.safeParse(
    c.req.header("Idempotency-Key")
  );
  const parsed = notificationSettingsBulkSchema.safeParse(
    await c.req.json().catch(() => null)
  );
  if (!idempotencyKey.success || !parsed.success) {
    return validation(c, {
      ...(!idempotencyKey.success
        ? zodErrors(idempotencyKey.error.issues, "headers.Idempotency-Key")
        : {}),
      ...(!parsed.success ? zodErrors(parsed.error.issues) : {}),
    });
  }
  const requestHash = await sha256Hex(JSON.stringify(parsed.data.settings));
  const result = await handle(c, () =>
    createNotificationUseCases(c.env).saveSettingsBulk(
      parsed.data.settings.map((setting) => ({
        ...setting,
        channels: JSON.stringify(setting.channels),
      })),
      idempotencyKey.data,
      requestHash
    )
  );
  return result instanceof Response
    ? result
    : c.json({ data: { ids: result.ids ?? [], replayed: result.replayed ?? false } });
});

notificationsV2.get("/history", async (c) => {
  const parsed = historyQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return validation(c);
  const result = await handle(c, () => createNotificationUseCases(c.env).listHistory(parsed.data));
  return result instanceof Response ? result : c.json(result);
});

export { notificationsV2 };
