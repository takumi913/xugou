import { Hono } from "hono";
import type { Bindings } from "../../../models/db";
import type { AuthVariables } from "../../../types";
import {
  applicationProblemResponse,
  problemResponse,
} from "../../../platform/http/problem";
import { ApplicationProblem } from "../../../shared/errors/ApplicationProblem";
import { writeSecurityAuditEvent } from "../../../platform/security/SecurityStore";
import { createAgentUseCases } from "../composition";
import {
  agentCredentialListQuerySchema,
  agentV2ImportSchema,
  agentV2IdSchema,
  agentV2ListQuerySchema,
  agentV2MetricsQuerySchema,
  agentV2OrderSchema,
  agentV2RegistrationSchema,
  agentV2UpdateSchema,
  agentV5ReportSchema,
} from "./schemas";
import {
  importLegacyAgents,
  queryLatestAgentMetricsForIds,
  queryLatestLegacyAgentMetric,
  queryLegacyAgentMetrics,
  registerAgent,
  updateLegacyAgentOrder,
} from "../persistence/D1LegacyAgentFacade";
import {
  AgentCredentialConfigurationError,
  AgentCredentialLimitError,
  authenticateAgentToken,
  issueAgentEnrollmentToken,
  listAgentCredentialMetadata,
  listAgentEnrollments,
  revokeAgentCredential,
  revokeAgentEnrollment,
  rotateAgentCredential,
} from "../persistence/D1AgentCredentialStore";
import {
  consumeRateLimit,
  CONTROL_PLANE_RATE_LIMIT_POLICY,
} from "../../../platform/security/SecurityStore";
import { requestStatusRebuild } from "../../status/persistence/status-events";
import { streamJsonDataArrayResponse } from "../../../platform/http/stream-json";
import { agentReportSourceFromCf } from "../../../utils/geo";
import { realtimeRoomName } from "../realtime/RealtimeSharding";

const agentsV2 = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

type AppContext = Parameters<typeof problemResponse>[0];
const MAX_AGENT_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const MAX_AGENT_COMPRESSED_BODY_BYTES = 1024 * 1024;

function zodErrors(issues: Array<{ path: PropertyKey[]; message: string }>) {
  const errors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.join(".") || "request";
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
}

function validationProblem(c: AppContext, errors: Record<string, string[]>) {
  return problemResponse(c, {
    status: 400,
    code: "VALIDATION_ERROR",
    title: "Request validation failed",
    errors,
  });
}

async function readBodyWithLimit(
  stream: ReadableStream<Uint8Array>,
  limit: number
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel("request body limit exceeded");
        throw new Error("request body limit exceeded");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function parseAgentJsonRequest(request: Request) {
  try {
    if (!request.body) return { ok: false as const };
    const contentEncoding = (request.headers.get("Content-Encoding") ?? "identity")
      .trim()
      .toLowerCase();
    const contentLength = Number(request.headers.get("Content-Length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength >
        (contentEncoding === "gzip"
          ? MAX_AGENT_COMPRESSED_BODY_BYTES
          : MAX_AGENT_REQUEST_BODY_BYTES)
    ) {
      return { ok: false as const };
    }

    let bodyStream: ReadableStream<Uint8Array> = request.body;
    if (contentEncoding === "gzip") {
      const compressedStream: ReadableStream<BufferSource> = request.body;
      bodyStream = compressedStream.pipeThrough(new DecompressionStream("gzip"));
    } else if (contentEncoding !== "identity" && contentEncoding !== "") {
      return { ok: false as const };
    }
    const body = await readBodyWithLimit(bodyStream, MAX_AGENT_REQUEST_BODY_BYTES);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return { ok: true as const, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false as const };
  }
}

async function parseJson(c: AppContext) {
  return parseAgentJsonRequest(c.req.raw);
}

async function handle<T>(c: AppContext, operation: () => Promise<T>) {
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

function bearerToken(c: AppContext) {
  const authorization = c.req.header("Authorization")?.trim();
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 && token.length <= 512 ? token : null;
}

agentsV2.get("/", async (c) => {
  const parsed = agentV2ListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return validationProblem(c, zodErrors(parsed.error.issues));
  const result = await handle(c, () => createAgentUseCases(c.env).list(parsed.data));
  if (!(result instanceof Response) && parsed.data.include_latest_metrics) {
    const metrics = await queryLatestAgentMetricsForIds(
      c.env,
      result.data.map((agent) => agent.id)
    );
    return c.json({
      ...result,
      data: result.data.map((agent) => ({
        ...agent,
        metrics: metrics.get(agent.id) ?? null,
      })),
    });
  }
  return result instanceof Response ? result : c.json(result);
});

agentsV2.get("/export", async (c) => {
  const useCases = createAgentUseCases(c.env);
  return streamJsonDataArrayResponse({
    filename: "xugou-agents-v2.json",
    loadPage: (cursor?: string) => useCases.list({ cursor, limit: 100 }),
    map: ({ id: _id, status: _status, keepalive: _keepalive,
      boot_time: _bootTime, last_seen_at: _lastSeen, next_offline_at: _nextOffline,
      region: _region, geo_latitude: _latitude, geo_longitude: _longitude,
      geo_city: _city, geo_region_name: _regionName, created_at: _createdAt,
      updated_at: _updatedAt, ...configuration }) => configuration,
  });
});

agentsV2.post("/import", async (c) => {
  const body = await parseJson(c);
  if (!body.ok) return validationProblem(c, { body: ["请求体必须是 JSON"] });
  const parsed = agentV2ImportSchema.safeParse(body.value);
  if (!parsed.success) return validationProblem(c, zodErrors(parsed.error.issues));
  try {
    const result = await importLegacyAgents(c.env, parsed.data);
    if (result.created > 0) {
      await requestStatusRebuild(c.env, {
        reason: "agent.imported",
        aggregateType: "agent",
        aggregateId: 0,
      });
    }
    return c.json({ data: result });
  } catch (error) {
    if (error instanceof AgentCredentialConfigurationError) {
      return problemResponse(c, {
        status: 503,
        code: "AGENT_CREDENTIAL_NOT_CONFIGURED",
        title: "Agent credential is not configured",
      });
    }
    throw error;
  }
});

agentsV2.put("/order", async (c) => {
  const body = await parseJson(c);
  if (!body.ok) return validationProblem(c, { body: ["请求体必须是 JSON"] });
  const parsed = agentV2OrderSchema.safeParse(body.value);
  if (!parsed.success) return validationProblem(c, zodErrors(parsed.error.issues));
  if (!(await updateLegacyAgentOrder(c.env, parsed.data.ids))) {
    return problemResponse(c, {
      status: 409,
      code: "AGENT_ORDER_CONFLICT",
      title: "Agent order contains unknown IDs",
    });
  }
  return c.json({ data: { ids: parsed.data.ids } });
});

agentsV2.post("/enrollments", async (c) => {
  const payload = c.get("admin");
  const rateLimit = await consumeRateLimit(
    c.env,
    "agent_enrollment_issue",
    String(payload.id),
    CONTROL_PLANE_RATE_LIMIT_POLICY
  );
  if (!rateLimit.allowed) {
    c.header("Retry-After", String(rateLimit.retryAfterSeconds));
    return problemResponse(c, {
      status: 429,
      code: "RATE_LIMITED",
      title: "Enrollment issuance is rate limited",
    });
  }
  try {
    const enrollment = await issueAgentEnrollmentToken(c.env, payload.id);
    await writeSecurityAuditEvent(c.env, {
      eventType: "agent.enrollment.issue",
      outcome: "success",
      actorType: "admin",
      actorId: payload.id,
      subjectType: "agent_enrollment",
      request: c.req.raw,
      metadata: { expires_at: enrollment.expiresAt },
    });
    return c.json({
      data: { token: enrollment.token, expires_at: enrollment.expiresAt },
    }, 201);
  } catch (error) {
    if (error instanceof AgentCredentialConfigurationError) {
      return problemResponse(c, {
        status: 503,
        code: "AGENT_CREDENTIAL_NOT_CONFIGURED",
        title: "Agent credential is not configured",
      });
    }
    throw error;
  }
});

agentsV2.get("/enrollments", async (c) =>
  c.json({ data: await listAgentEnrollments(c.env, c.get("admin").id) })
);

agentsV2.delete("/enrollments/:id", async (c) => {
  const parsedId = agentV2IdSchema.safeParse(c.req.param("id"));
  if (!parsedId.success) return validationProblem(c, zodErrors(parsedId.error.issues));
  const payload = c.get("admin");
  const revoked = await revokeAgentEnrollment(c.env, payload.id, parsedId.data);
  await writeSecurityAuditEvent(c.env, {
    eventType: "agent.enrollment.revoke",
    outcome: revoked ? "success" : "failure",
    actorType: "admin",
    actorId: payload.id,
    subjectType: "agent_enrollment",
    subjectId: parsedId.data,
    request: c.req.raw,
  });
  if (!revoked) {
    return problemResponse(c, {
      status: 409,
      code: "AGENT_ENROLLMENT_REVOKE_CONFLICT",
      title: "Enrollment cannot be revoked",
    });
  }
  return c.body(null, 204);
});

// Agent 控制面注册使用 Enrollment/Credential Bearer，不把凭据复制进 JSON。
// 已注册 Agent 可在重启后用长期凭据幂等恢复身份。
agentsV2.post("/register", async (c) => {
  const token = bearerToken(c);
  if (!token) {
    return problemResponse(c, {
      status: 401,
      code: "AGENT_CREDENTIAL_REQUIRED",
      title: "Agent credential is required",
    });
  }
  const body = await parseJson(c);
  if (!body.ok) return validationProblem(c, { body: ["请求体必须是 JSON"] });
  const parsed = agentV2RegistrationSchema.safeParse(body.value);
  if (!parsed.success) return validationProblem(c, zodErrors(parsed.error.issues));

  try {
    const registered = await registerAgent(c.env, {
      token,
      ...parsed.data,
    });
    if (!registered) {
      await writeSecurityAuditEvent(c.env, {
        eventType: "agent.register.v2",
        outcome: "failure",
        actorType: "anonymous",
        subjectType: "agent",
        request: c.req.raw,
        metadata: { reason: "invalid_or_expired_credential" },
      });
      return problemResponse(c, {
        status: 401,
        code: "AGENT_ENROLLMENT_INVALID",
        title: "Agent enrollment is invalid or expired",
      });
    }
    await writeSecurityAuditEvent(c.env, {
      eventType: "agent.register.v2",
      outcome: "success",
      actorType: "agent",
      actorId: registered.id,
      subjectType: "agent",
      subjectId: registered.id,
      request: c.req.raw,
      metadata: { created: registered.created },
    });
    return c.json(
      { data: { agent_id: registered.id, created: registered.created } },
      registered.created ? 201 : 200
    );
  } catch (error) {
    if (error instanceof AgentCredentialConfigurationError) {
      return problemResponse(c, {
        status: 503,
        code: "AGENT_CREDENTIAL_NOT_CONFIGURED",
        title: "Agent credential is not configured",
      });
    }
    throw error;
  }
});

// Agent 数据面上行 WebSocket：Bearer 只在 Worker 握手时校验，DO 只接收已绑定
// 的数字 Agent ID。实时帧不写 D1，也不进入 Queue。
agentsV2.get("/live", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return problemResponse(c, {
      status: 426,
      code: "WEBSOCKET_UPGRADE_REQUIRED",
      title: "WebSocket upgrade is required",
    });
  }
  const token = bearerToken(c);
  if (!token) {
    return problemResponse(c, {
      status: 401,
      code: "AGENT_CREDENTIAL_REQUIRED",
      title: "Agent credential is required",
    });
  }
  let agent: Awaited<ReturnType<typeof authenticateAgentToken>>;
  try {
    agent = await authenticateAgentToken(c.env, token);
  } catch (error) {
    if (error instanceof AgentCredentialConfigurationError) {
      return problemResponse(c, {
        status: 503,
        code: "AGENT_CREDENTIAL_NOT_CONFIGURED",
        title: "Agent credential is not configured",
      });
    }
    throw error;
  }
  if (!agent) {
    return problemResponse(c, {
      status: 401,
      code: "AGENT_CREDENTIAL_INVALID",
      title: "Agent credential is invalid",
    });
  }

  const target = new URL("http://internal/agent-ws");
  target.searchParams.set("agentId", String(agent.id));
  const headers = new Headers(c.req.raw.headers);
  headers.delete("Authorization");
  headers.delete("Cookie");
  return c.env.AGENT_ROOM.getByName(realtimeRoomName(agent.id)).fetch(target, {
    method: "GET",
    headers,
  });
});

agentsV2.get("/:id/metrics", async (c) => {
  const parsedId = agentV2IdSchema.safeParse(c.req.param("id"));
  const parsedQuery = agentV2MetricsQuerySchema.safeParse(c.req.query());
  if (!parsedId.success) return validationProblem(c, zodErrors(parsedId.error.issues));
  if (!parsedQuery.success) return validationProblem(c, zodErrors(parsedQuery.error.issues));
  const result = await queryLegacyAgentMetrics(
    c.env,
    parsedId.data,
    Number(parsedQuery.data.hours)
  );
  if (result === null) {
    return problemResponse(c, { status: 404, code: "AGENT_NOT_FOUND", title: "Agent not found" });
  }
  return c.json({ data: result });
});

agentsV2.get("/:id/metrics/latest", async (c) => {
  const parsedId = agentV2IdSchema.safeParse(c.req.param("id"));
  if (!parsedId.success) return validationProblem(c, zodErrors(parsedId.error.issues));
  const result = await queryLatestLegacyAgentMetric(c.env, parsedId.data);
  if (result === null) {
    return problemResponse(c, { status: 404, code: "AGENT_NOT_FOUND", title: "Agent not found" });
  }
  return c.json({ data: result ?? null });
});

agentsV2.get("/:id/credentials", async (c) => {
  const parsedId = agentV2IdSchema.safeParse(c.req.param("id"));
  const parsedQuery = agentCredentialListQuerySchema.safeParse(c.req.query());
  if (!parsedId.success) return validationProblem(c, zodErrors(parsedId.error.issues));
  if (!parsedQuery.success) {
    return validationProblem(c, zodErrors(parsedQuery.error.issues));
  }
  const result = await listAgentCredentialMetadata(
    c.env,
    parsedId.data,
    parsedQuery.data
  );
  if (!result) {
    return problemResponse(c, { status: 404, code: "AGENT_NOT_FOUND", title: "Agent not found" });
  }
  return c.json(result);
});

agentsV2.post("/:id/credentials", async (c) => {
  const parsedId = agentV2IdSchema.safeParse(c.req.param("id"));
  if (!parsedId.success) return validationProblem(c, zodErrors(parsedId.error.issues));
  const payload = c.get("admin");
  const rateLimit = await consumeRateLimit(
    c.env,
    "agent_credential_rotate",
    `${payload.id}:${parsedId.data}`,
    CONTROL_PLANE_RATE_LIMIT_POLICY
  );
  if (!rateLimit.allowed) {
    c.header("Retry-After", String(rateLimit.retryAfterSeconds));
    return problemResponse(c, { status: 429, code: "RATE_LIMITED", title: "Credential rotation is rate limited" });
  }
  let rotated: Awaited<ReturnType<typeof rotateAgentCredential>>;
  try {
    rotated = await rotateAgentCredential(c.env, parsedId.data);
  } catch (error) {
    if (error instanceof AgentCredentialLimitError) {
      return problemResponse(c, {
        status: 409,
        code: "AGENT_CREDENTIAL_LIMIT_REACHED",
        title: "Agent credential limit reached",
      });
    }
    throw error;
  }
  if (!rotated) {
    return problemResponse(c, { status: 404, code: "AGENT_NOT_FOUND", title: "Agent not found" });
  }
  await writeSecurityAuditEvent(c.env, {
    eventType: "agent.credential.rotate",
    outcome: "success",
    actorType: "admin",
    actorId: payload.id,
    subjectType: "agent",
    subjectId: parsedId.data,
    request: c.req.raw,
  });
  return c.json({ data: { token: rotated.token } }, 201);
});

agentsV2.delete("/:id/credentials/:credentialId", async (c) => {
  const parsedId = agentV2IdSchema.safeParse(c.req.param("id"));
  const credentialId = agentV2IdSchema.safeParse(c.req.param("credentialId"));
  if (!parsedId.success) return validationProblem(c, zodErrors(parsedId.error.issues));
  if (!credentialId.success) return validationProblem(c, zodErrors(credentialId.error.issues));
  const result = await revokeAgentCredential(c.env, parsedId.data, credentialId.data);
  if (!result.success) {
    return problemResponse(c, {
      status: result.reason === "agent_not_found" ? 404 : 409,
      code: result.reason === "agent_not_found" ? "AGENT_NOT_FOUND" : "AGENT_CREDENTIAL_REVOKE_CONFLICT",
      title: result.reason === "agent_not_found" ? "Agent not found" : "Credential cannot be revoked",
    });
  }
  await writeSecurityAuditEvent(c.env, {
    eventType: "agent.credential.revoke",
    outcome: "success",
    actorType: "admin",
    actorId: c.get("admin").id,
    subjectType: "agent_credential",
    subjectId: credentialId.data,
    request: c.req.raw,
    metadata: { agent_id: parsedId.data },
  });
  return c.body(null, 204);
});

agentsV2.get("/:id", async (c) => {
  const parsedId = agentV2IdSchema.safeParse(c.req.param("id"));
  if (!parsedId.success) return validationProblem(c, zodErrors(parsedId.error.issues));
  const result = await handle(c, () => createAgentUseCases(c.env).get(parsedId.data));
  return result instanceof Response ? result : c.json({ data: result });
});

agentsV2.patch("/:id", async (c) => {
  const parsedId = agentV2IdSchema.safeParse(c.req.param("id"));
  if (!parsedId.success) return validationProblem(c, zodErrors(parsedId.error.issues));
  const body = await parseJson(c);
  if (!body.ok) return validationProblem(c, { body: ["请求体必须是 JSON"] });
  const parsed = agentV2UpdateSchema.safeParse(body.value);
  if (!parsed.success) return validationProblem(c, zodErrors(parsed.error.issues));
  const result = await handle(c, () =>
    createAgentUseCases(c.env).update(parsedId.data, parsed.data)
  );
  if (result instanceof Response) return result;
  await requestStatusRebuild(c.env, {
    reason: "agent.updated",
    aggregateType: "agent",
    aggregateId: parsedId.data,
  });
  await writeSecurityAuditEvent(c.env, {
    eventType: "agent.update",
    outcome: "success",
    actorType: "admin",
    actorId: c.get("admin").id,
    subjectType: "agent",
    subjectId: parsedId.data,
    request: c.req.raw,
  });
  return c.json({ data: result });
});

agentsV2.delete("/:id", async (c) => {
  const parsedId = agentV2IdSchema.safeParse(c.req.param("id"));
  if (!parsedId.success) return validationProblem(c, zodErrors(parsedId.error.issues));
  const result = await handle(c, async () => {
    await createAgentUseCases(c.env).delete(parsedId.data);
    return true;
  });
  if (result instanceof Response) return result;
  await requestStatusRebuild(c.env, {
    reason: "agent.deleted",
    aggregateType: "agent",
    aggregateId: parsedId.data,
  });
  await writeSecurityAuditEvent(c.env, {
    eventType: "agent.delete",
    outcome: "success",
    actorType: "admin",
    actorId: c.get("admin").id,
    subjectType: "agent",
    subjectId: parsedId.data,
    request: c.req.raw,
  });
  return c.body(null, 204);
});

// v5 数据面使用 Agent Bearer Credential，自身完成鉴权，不进入管理 Session 流程。
agentsV2.post("/reports", async (c) => {
  const token = bearerToken(c);
  if (!token) {
    return problemResponse(c, {
      status: 401,
      code: "AGENT_CREDENTIAL_REQUIRED",
      title: "Agent credential is required",
    });
  }
  const body = await parseJson(c);
  if (!body.ok) return validationProblem(c, { body: ["请求体必须是 JSON"] });
  const parsed = agentV5ReportSchema.safeParse(body.value);
  if (!parsed.success) return validationProblem(c, zodErrors(parsed.error.issues));
  const result = await handle(c, () =>
    createAgentUseCases(c.env).acceptReport(
      token,
      parsed.data,
      agentReportSourceFromCf(c.req.raw.cf)
    )
  );
  return result instanceof Response ? result : c.json(result, 202);
});

export { agentsV2 };
