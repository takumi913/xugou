import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../../../models/db";
import type { AuthVariables } from "../../../types";
import {
  applicationProblemResponse,
  problemResponse,
} from "../../../platform/http/problem";
import { ApplicationProblem } from "../../../shared/errors/ApplicationProblem";
import {
  decodeSecurityAuditCursor,
  listSecurityAuditEventsPage,
} from "../../../platform/security/SecurityStore";

const operationsV2 = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
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

export { operationsV2 };
