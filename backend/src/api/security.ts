import { Hono } from "hono";
import { Bindings } from "../models/db";
import { AuthVariables } from "../types";
import { listSecurityAuditEvents } from "../platform/security/SecurityStore";
import { getAgentCredentialBackfillCoverage } from "../modules/agents/persistence/D1AgentCredentialStore";
import { getNotificationSecretMigrationCoverage } from "../modules/notifications/persistence/NotificationSecretMaintenance";
import { securityAuditQuerySchema } from "./schemas";
import { normalizePageOffset, normalizePageSize } from "../utils/pagination";

const security = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

security.get("/audit", async (c) => {
  const parsed = securityAuditQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ success: false, message: "审计查询参数无效" }, 400);
  }
  const pageSize = normalizePageSize(parsed.data.pageSize);
  const offset = normalizePageOffset((parsed.data.page - 1) * pageSize);
  const result = await listSecurityAuditEvents(c.env, {
    eventType: parsed.data.eventType,
    outcome: parsed.data.outcome,
    limit: pageSize,
    offset,
  });
  return c.json({
    success: true,
    data: result.rows,
    pagination: {
      page: parsed.data.page,
      pageSize,
      total: result.total,
      totalPages: Math.ceil(result.total / pageSize),
    },
  });
});

security.get("/migration-coverage", async (c) => {
  const [agentCredentials, notificationSecrets] = await Promise.all([
    getAgentCredentialBackfillCoverage(c.env),
    getNotificationSecretMigrationCoverage(c.env),
  ]);
  const agentReady = agentCredentials.covered === agentCredentials.total;
  const notificationReady =
    notificationSecrets.endpointCovered === notificationSecrets.total &&
    notificationSecrets.currentKeyRows ===
      notificationSecrets.encryptedSecretRows;
  return c.json({
    success: true,
    data: {
      agentCredentials: { ...agentCredentials, ready: agentReady },
      notificationSecrets: {
        ...notificationSecrets,
        ready: notificationReady,
      },
      readyForCredentialContract: agentReady && notificationReady,
    },
  });
});

export { security };
