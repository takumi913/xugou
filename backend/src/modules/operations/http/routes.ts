import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../../../models/db";
import type { AuthVariables } from "../../../types";
import { applicationProblemResponse, problemResponse } from "../../../platform/http/problem";
import { ApplicationProblem } from "../../../shared/errors/ApplicationProblem";
import {
  decodeSecurityAuditCursor,
  listSecurityAuditEventsPage,
  writeSecurityAuditEvent,
} from "../../../platform/security/SecurityStore";
import { createQueueFailureUseCases } from "../composition";
import { D1MigrationLedgerQuery } from "../persistence/D1MigrationLedgerQuery";
import { D1ReleaseReadinessQuery } from "../persistence/D1ReleaseReadinessQuery";
import { getAgentCredentialBackfillCoverage } from "../../agents/persistence/D1AgentCredentialStore";
import { getNotificationSecretMigrationCoverage } from "../../notifications/persistence/NotificationSecretMaintenance";

const operationsV2 = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
const listSchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    status: z.enum(["open", "replayed", "terminated"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const idSchema = z.string().min(1).max(512);
const anomalyListSchema = z
  .object({
    cursor: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    migration_key: z.string().trim().min(1).max(128).optional(),
    status: z
      .enum(["open", "retry_requested", "resolved", "ignored"])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const anomalyActionSchema = z
  .object({
    action: z.enum(["retry", "ignore"]),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
const compatibilityQuerySchema = z
  .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
  .strict();
const securityAuditListSchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    event_type: z.string().trim().min(1).max(128).optional(),
    outcome: z.enum(["success", "failure", "denied"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

function validation(c: Parameters<typeof problemResponse>[0]) {
  return problemResponse(c, {
    status: 400,
    code: "VALIDATION_ERROR",
    title: "Request validation failed",
  });
}

async function handle<T>(
  c: Parameters<typeof problemResponse>[0],
  operation: () => Promise<T>
) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApplicationProblem) return applicationProblemResponse(c, error);
    return problemResponse(c, { status: 500, code: "INTERNAL_ERROR", title: "Internal server error" });
  }
}

operationsV2.get("/queue-failures", async (c) => {
  const parsed = listSchema.safeParse(c.req.query());
  if (!parsed.success) return validation(c);
  const result = await handle(c, () => createQueueFailureUseCases(c.env).list(parsed.data));
  return result instanceof Response ? result : c.json(result);
});

operationsV2.get("/queue-health", async (c) => {
  const result = await handle(c, () => createQueueFailureUseCases(c.env).health());
  return result instanceof Response ? result : c.json({ data: result });
});

operationsV2.get("/release-readiness", async (c) => {
  const result = await handle(c, () => new D1ReleaseReadinessQuery(c.env).get());
  return result instanceof Response ? result : c.json({ data: result });
});

operationsV2.get("/compatibility-hits", async (c) => {
  const parsed = compatibilityQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return validation(c);
  const result = await handle(c, () =>
    new D1ReleaseReadinessQuery(c.env).listCompatibilityHits(parsed.data.days)
  );
  return result instanceof Response ? result : c.json({ data: result });
});

operationsV2.get("/security-audit", async (c) => {
  const parsed = securityAuditListSchema.safeParse(c.req.query());
  if (
    !parsed.success ||
    (parsed.data.cursor && !decodeSecurityAuditCursor(parsed.data.cursor))
  ) {
    return validation(c);
  }
  const result = await handle(c, () =>
    listSecurityAuditEventsPage(c.env, {
      cursor: parsed.data.cursor,
      eventType: parsed.data.event_type,
      outcome: parsed.data.outcome,
      limit: parsed.data.limit,
    })
  );
  if (result instanceof Response) return result;
  return c.json(result);
});

operationsV2.get("/credential-coverage", async (c) => {
  const result = await handle(c, async () => {
    const [agentCredentials, notificationSecrets] = await Promise.all([
      getAgentCredentialBackfillCoverage(c.env),
      getNotificationSecretMigrationCoverage(c.env),
    ]);
    const agentReady = agentCredentials.covered === agentCredentials.total;
    const notificationReady =
      notificationSecrets.endpointCovered === notificationSecrets.total &&
      notificationSecrets.currentKeyRows ===
        notificationSecrets.encryptedSecretRows;
    return {
      agent_credentials: { ...agentCredentials, ready: agentReady },
      notification_secrets: {
        ...notificationSecrets,
        ready: notificationReady,
      },
      ready_for_credential_contract: agentReady && notificationReady,
    };
  });
  return result instanceof Response ? result : c.json({ data: result });
});

operationsV2.get("/migrations/checkpoints", async (c) => {
  const result = await handle(c, () =>
    new D1MigrationLedgerQuery(c.env).listCheckpoints()
  );
  return result instanceof Response ? result : c.json({ data: result });
});

operationsV2.get("/migrations/anomalies", async (c) => {
  const parsed = anomalyListSchema.safeParse(c.req.query());
  if (!parsed.success) return validation(c);
  const result = await handle(c, () =>
    new D1MigrationLedgerQuery(c.env).listAnomalies({
      cursor: parsed.data.cursor,
      migrationKey: parsed.data.migration_key,
      status: parsed.data.status,
      limit: parsed.data.limit,
    })
  );
  return result instanceof Response ? result : c.json(result);
});

operationsV2.patch("/migrations/anomalies/:id", async (c) => {
  const id = z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .safeParse(c.req.param("id"));
  const body = anomalyActionSchema.safeParse(await c.req.json().catch(() => null));
  if (!id.success || !body.success) return validation(c);
  const updated = await new D1MigrationLedgerQuery(c.env).updateAnomaly(
    id.data,
    body.data.action,
    body.data.note ?? null
  );
  if (!updated) {
    return problemResponse(c, {
      status: 404,
      code: "MIGRATION_ANOMALY_NOT_FOUND",
      title: "Migration anomaly not found",
    });
  }
  await writeSecurityAuditEvent(c.env, {
    eventType: `migration.anomaly.${body.data.action}`,
    outcome: "success",
    actorType: "admin",
    actorId: c.get("admin").id,
    subjectType: "migration_anomaly",
    subjectId: id.data,
    request: c.req.raw,
  });
  return c.json({ data: { id: id.data, action: body.data.action } });
});

operationsV2.post("/queue-failures/:id/replay", async (c) => {
  const parsed = idSchema.safeParse(c.req.param("id"));
  if (!parsed.success) return validation(c);
  const result = await handle(c, () => createQueueFailureUseCases(c.env).replay(parsed.data));
  if (result instanceof Response) return result;
  await writeSecurityAuditEvent(c.env, {
    eventType: "queue.failure.replay",
    outcome: "success",
    actorType: "admin",
    actorId: c.get("admin").id,
    subjectType: "queue_failure",
    subjectId: parsed.data,
    request: c.req.raw,
  });
  return c.json({ data: result });
});

operationsV2.post("/queue-failures/:id/terminate", async (c) => {
  const parsed = idSchema.safeParse(c.req.param("id"));
  if (!parsed.success) return validation(c);
  const result = await handle(c, async () => {
    await createQueueFailureUseCases(c.env).terminate(parsed.data);
    return true;
  });
  if (result instanceof Response) return result;
  await writeSecurityAuditEvent(c.env, {
    eventType: "queue.failure.terminate",
    outcome: "success",
    actorType: "admin",
    actorId: c.get("admin").id,
    subjectType: "queue_failure",
    subjectId: parsed.data,
    request: c.req.raw,
  });
  return c.body(null, 204);
});

export { operationsV2 };
