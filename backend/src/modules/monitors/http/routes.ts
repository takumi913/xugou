import { Hono } from "hono";
import type { Bindings } from "../../../models/db";
import type { AuthVariables } from "../../../types";
import { ApplicationProblem } from "../../../shared/errors/ApplicationProblem";
import {
  applicationProblemResponse,
  problemResponse,
} from "../../../platform/http/problem";
import { createMonitorUseCases } from "../composition";
import { writeSecurityAuditEvent } from "../../../platform/security/SecurityStore";
import { requestStatusRebuild } from "../../status/persistence/status-events";
import {
  monitorV2IdSchema,
  monitorV2DailyStatsQuerySchema,
  monitorV2ImportSchema,
  monitorV2ListQuerySchema,
  monitorV2MutationSchema,
  monitorV2OrderSchema,
  monitorV2RelatedDataQuerySchema,
  monitorV2UpdateSchema,
} from "./schemas";
import {
  importLegacyMonitors,
  queryMonitorDailyStats,
  queryMonitorHistory,
  updateLegacyMonitorOrder,
} from "../persistence/D1LegacyMonitorFacade";
import { scheduleMonitorCheckNow } from "../queue/MonitorScheduler";
import { streamJsonDataArrayResponse } from "../../../platform/http/stream-json";

const monitorsV2 = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

function validationProblem(c: Parameters<typeof problemResponse>[0], errors: Record<string, string[]>) {
  return problemResponse(c, {
    status: 400,
    code: "VALIDATION_ERROR",
    title: "Request validation failed",
    errors,
  });
}

function zodErrors(issues: Array<{ path: PropertyKey[]; message: string }>) {
  const errors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.join(".") || "request";
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
}

async function handle<T>(
  c: Parameters<typeof problemResponse>[0],
  operation: () => Promise<T>
): Promise<T | Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApplicationProblem) {
      return applicationProblemResponse(c, error);
    }
    return problemResponse(c, {
      status: 500,
      code: "INTERNAL_ERROR",
      title: "Internal server error",
    });
  }
}

monitorsV2.get("/", async (c) => {
  const parsed = monitorV2ListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return validationProblem(c, zodErrors(parsed.error.issues));
  const result = await handle(c, () =>
    createMonitorUseCases(c.env).list(parsed.data)
  );
  return result instanceof Response ? result : c.json(result);
});

monitorsV2.get("/history", async (c) => {
  const parsed = monitorV2RelatedDataQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return validationProblem(c, zodErrors(parsed.error.issues));
  const found = await handle(c, () =>
    createMonitorUseCases(c.env).get(parsed.data.monitor_id)
  );
  if (found instanceof Response) return found;
  return c.json({ data: await queryMonitorHistory(c.env, parsed.data.monitor_id) });
});

monitorsV2.get("/daily", async (c) => {
  const parsed = monitorV2DailyStatsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return validationProblem(c, zodErrors(parsed.error.issues));
  const found = await handle(c, () =>
    createMonitorUseCases(c.env).get(parsed.data.monitor_id)
  );
  if (found instanceof Response) return found;
  return c.json({
    data: await queryMonitorDailyStats(
      c.env,
      parsed.data.monitor_id,
      parsed.data.days
    ),
  });
});

monitorsV2.put("/order", async (c) => {
  const parsed = monitorV2OrderSchema.safeParse(await c.req.json());
  if (!parsed.success) return validationProblem(c, zodErrors(parsed.error.issues));
  const updated = await updateLegacyMonitorOrder(c.env, parsed.data.ids);
  if (!updated) {
    return problemResponse(c, {
      status: 409,
      code: "MONITOR_ORDER_CONFLICT",
      title: "Monitor order contains unknown IDs",
    });
  }
  await requestStatusRebuild(c.env, {
    reason: "monitor.order.updated",
    aggregateType: "monitor",
    aggregateId: 0,
  });
  return c.json({ data: { ids: parsed.data.ids } });
});

monitorsV2.get("/export", async (c) => {
  const useCases = createMonitorUseCases(c.env);
  return streamJsonDataArrayResponse({
    filename: "xugou-monitors-v2.json",
    loadPage: (cursor?: string) => useCases.list({ cursor, limit: 100 }),
    map: ({ id: _id, status: _status, response_time_ms: _response,
      last_checked_at: _lastChecked, next_check_at: _nextCheck,
      created_at: _createdAt, updated_at: _updatedAt, ...configuration }) =>
      configuration,
  });
});

monitorsV2.post("/import", async (c) => {
  const parsed = monitorV2ImportSchema.safeParse(await c.req.json());
  if (!parsed.success) return validationProblem(c, zodErrors(parsed.error.issues));
  const result = await importLegacyMonitors(c.env, parsed.data);
  if (result.created > 0) {
    await requestStatusRebuild(c.env, {
      reason: "monitor.imported",
      aggregateType: "monitor",
      aggregateId: 0,
    });
  }
  return c.json({ data: result });
});

monitorsV2.get("/:id", async (c) => {
  const parsedId = monitorV2IdSchema.safeParse(c.req.param("id"));
  if (!parsedId.success) return validationProblem(c, zodErrors(parsedId.error.issues));
  const result = await handle(c, () =>
    createMonitorUseCases(c.env).get(parsedId.data)
  );
  return result instanceof Response ? result : c.json({ data: result });
});

monitorsV2.post("/", async (c) => {
  const parsed = monitorV2MutationSchema.safeParse(await c.req.json());
  if (!parsed.success) return validationProblem(c, zodErrors(parsed.error.issues));
  const result = await handle(c, () =>
    createMonitorUseCases(c.env).create(parsed.data)
  );
  if (result instanceof Response) return result;
  await requestStatusRebuild(c.env, {
    reason: "monitor.created",
    aggregateType: "monitor",
    aggregateId: result.id,
  });
  await writeSecurityAuditEvent(c.env, {
    eventType: "monitor.create",
    outcome: "success",
    actorType: "admin",
    actorId: c.get("admin").id,
    subjectType: "monitor",
    subjectId: result.id,
    request: c.req.raw,
  });
  return c.json({ data: result }, 201);
});

monitorsV2.patch("/:id", async (c) => {
  const parsedId = monitorV2IdSchema.safeParse(c.req.param("id"));
  if (!parsedId.success) return validationProblem(c, zodErrors(parsedId.error.issues));
  const parsed = monitorV2UpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) return validationProblem(c, zodErrors(parsed.error.issues));
  const result = await handle(c, () =>
    createMonitorUseCases(c.env).update(parsedId.data, parsed.data)
  );
  if (result instanceof Response) return result;
  await requestStatusRebuild(c.env, {
    reason: "monitor.updated",
    aggregateType: "monitor",
    aggregateId: parsedId.data,
  });
  await writeSecurityAuditEvent(c.env, {
    eventType: "monitor.update",
    outcome: "success",
    actorType: "admin",
    actorId: c.get("admin").id,
    subjectType: "monitor",
    subjectId: parsedId.data,
    request: c.req.raw,
  });
  return c.json({ data: result });
});

monitorsV2.delete("/:id", async (c) => {
  const parsedId = monitorV2IdSchema.safeParse(c.req.param("id"));
  if (!parsedId.success) return validationProblem(c, zodErrors(parsedId.error.issues));
  const result = await handle(c, async () => {
    await createMonitorUseCases(c.env).delete(parsedId.data);
    return true;
  });
  if (result instanceof Response) return result;
  await requestStatusRebuild(c.env, {
    reason: "monitor.deleted",
    aggregateType: "monitor",
    aggregateId: parsedId.data,
  });
  await writeSecurityAuditEvent(c.env, {
    eventType: "monitor.delete",
    outcome: "success",
    actorType: "admin",
    actorId: c.get("admin").id,
    subjectType: "monitor",
    subjectId: parsedId.data,
    request: c.req.raw,
  });
  return c.body(null, 204);
});

monitorsV2.post("/:id/check", async (c) => {
  const parsedId = monitorV2IdSchema.safeParse(c.req.param("id"));
  if (!parsedId.success) return validationProblem(c, zodErrors(parsedId.error.issues));
  const scheduled = await scheduleMonitorCheckNow(c.env, parsedId.data);
  if (!scheduled) {
    return problemResponse(c, {
      status: 404,
      code: "MONITOR_NOT_FOUND",
      title: "Monitor not found",
    });
  }
  return c.json({ data: { job_id: scheduled.jobId, status: "pending" as const } }, 202);
});

export { monitorsV2 };
