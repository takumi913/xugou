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





export { operationsV2 };
