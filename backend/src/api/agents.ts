import { Hono } from "hono";
import { AdminSessionPrincipal } from "../types";
import { Bindings } from "../models/db";
import { Agent } from "../models/agent";
import {
  AgentCredentialConfigurationError,
  AgentCredentialLimitError,
} from "../modules/agents/persistence/D1AgentCredentialStore";
import {
  listAgentCredentialMetadata,
  listAgentEnrollments,
  issueAgentEnrollmentToken,
  revokeAgentCredential,
  revokeAgentEnrollment,
  rotateAgentCredential,
} from "../modules/agents/persistence/D1AgentCredentialStore";
import {
  getLegacyAgent,
  importLegacyAgents,
  listLegacyAgents,
  normalizeAgentMetricsHours,
  queryLatestLegacyAgentMetric,
  queryLegacyAgentMetrics,
  registerLegacyAgent,
  toAgentExportRecord,
  toAgentMutation,
  toLegacyAgent,
  updateLegacyAgentOrder,
} from "../modules/agents/persistence/D1LegacyAgentFacade";
import {
  consumeRateLimit,
  CONTROL_PLANE_RATE_LIMIT_POLICY,
  writeSecurityAuditEvent,
} from "../platform/security/SecurityStore";
import {
  AGENT_CONFIG_MD5_HEADER,
  AGENT_CONFIG_SCHEMA_HEADER,
  AGENT_CONFIG_SCHEMA_VERSION,
  AGENT_CONFIG_UPDATE_DIRECTIVE,
  AGENT_VERSION_HEADER,
  md5Hex,
  normalizeAgentConfigSchema,
  serializeAgentConfig,
  type AgentConfigDescriptor,
  type AgentIntervalConfig,
} from "../utils/agentConfig";
import {
  agentImportSchema,
  agentRegisterSchema,
  agentStatusSchema,
  agentUpdateSchema,
  badRequest,
  idParamSchema,
  orderUpdateSchema,
} from "./schemas";
import { createAgentUseCases } from "../modules/agents/composition";
import { adaptLegacyAgentReport } from "../modules/agents/http/LegacyAgentReportAdapter";
import { ApplicationProblem } from "../shared/errors/ApplicationProblem";
import { requestStatusRebuild } from "../modules/status/persistence/status-events";
import { streamJsonArrayResponse } from "../platform/http/stream-json";
import { agentReportSourceFromCf } from "../utils/geo";

const agents = new Hono<{
  Bindings: Bindings;
  Variables: { agent: Agent; admin: AdminSessionPrincipal };
}>();

// 配置描述符备忘：service 返回的 intervals 已规范化，同输入直接复用序列化串与 MD5。
// 规范化串中的 schema_version 回填客户端声明的版本，因此缓存键包含 schema。
const agentConfigDescriptorCache = new Map<string, AgentConfigDescriptor>();
const AGENT_CONFIG_DESCRIPTOR_CACHE_MAX = 1000;

function getAgentConfigDescriptor(
  config: AgentIntervalConfig,
  schemaVersion: number
): AgentConfigDescriptor {
  const key = `${config.collect_interval}|${config.report_interval}|${schemaVersion}`;
  let descriptor = agentConfigDescriptorCache.get(key);
  if (!descriptor) {
    const serialized = serializeAgentConfig(config, schemaVersion);
    descriptor = { config, serialized, md5: md5Hex(serialized) };
    if (agentConfigDescriptorCache.size >= AGENT_CONFIG_DESCRIPTOR_CACHE_MAX) {
      agentConfigDescriptorCache.clear();
    }
    agentConfigDescriptorCache.set(key, descriptor);
  }
  return descriptor;
}

// 获取所有客户端
agents.get("/", async (c) => {
  const includeLatestMetrics =
    c.req.query("includeLatestMetrics") === "true";
  return c.json({
    success: true,
    agents: await listLegacyAgents(c.env, includeLatestMetrics),
  });
});

// 手动排序：按 body.ids 的数组顺序写 sort_order（须在 /:id 之前注册）
agents.put("/order", async (c) => {
  const parsed = orderUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("排序参数无效"), 400);
  }

  const updated = await updateLegacyAgentOrder(c.env, parsed.data.ids);
  return c.json(
    {
      success: updated,
      message: updated ? "排序已更新" : "客户端不存在或无权访问",
    },
    updated ? 200 : 400
  );
});

// 导出客户端非敏感配置（凭据摘要不可逆，不导出 Token）
agents.get("/export", async (c) => {
  const useCases = createAgentUseCases(c.env);
  return streamJsonArrayResponse({
    filename: "xugou-agents.json",
    loadPage: (cursor?: string) => useCases.list({ cursor, limit: 100 }),
    map: (agent) => toAgentExportRecord(toLegacyAgent(agent)),
  });
});

// 导入客户端配置：按 name 去重跳过，token 冲突时重新生成
agents.post("/import", async (c) => {
  const parsed = agentImportSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("客户端导入数据无效"), 400);
  }

  try {
    const result = await importLegacyAgents(c.env, parsed.data);
    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    if (error instanceof AgentCredentialConfigurationError) {
      return c.json({ success: false, message: "Agent 凭据尚未配置" }, 503);
    }
    return c.json({ success: false, message: "导入客户端失败" }, 500);
  }
});

// 更新客户端信息
agents.put("/:id", async (c) => {
  const agentId = idParamSchema.parse(c.req.param("id"));
  const parsed = agentUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("客户端更新参数无效"), 400);
  }

  try {
    const agent = await createAgentUseCases(c.env).update(
      agentId,
      toAgentMutation(parsed.data)
    );
    await requestStatusRebuild(c.env, {
      reason: "agent.updated",
      aggregateType: "agent",
      aggregateId: agentId,
    });
    return c.json({
      success: true,
      message: "客户端信息已更新",
      agent: toLegacyAgent(agent),
    });
  } catch (error) {
    if (error instanceof ApplicationProblem) {
      return c.json({ success: false, message: error.message }, error.status as 400);
    }
    throw error;
  }
});

// 删除客户端
agents.delete("/:id", async (c) => {
  try {
    const agentId = idParamSchema.parse(c.req.param("id"));

    await createAgentUseCases(c.env).delete(agentId);
    await c.env.DB.prepare(
      `DELETE FROM notification_settings WHERE target_type = 'agent' AND target_id = ?`
    )
      .bind(agentId)
      .run();
    await requestStatusRebuild(c.env, {
      reason: "agent.deleted",
      aggregateType: "agent",
      aggregateId: agentId,
    });
    await writeSecurityAuditEvent(c.env, {
      eventType: "agent.delete",
      outcome: "success",
      actorType: "admin",
      actorId: c.get("admin").id,
      subjectType: "agent",
      subjectId: agentId,
      request: c.req.raw,
    });

    return c.json(
      {
        success: true,
        message: "客户端已删除",
      },
      200
    );
  } catch (error) {
    return c.json(
      {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

// 生成客户端Token
agents.post("/token/generate", async (c) => {
  try {
    const payload = c.get("admin");
    const rateLimit = await consumeRateLimit(
      c.env,
      "agent_enrollment_issue",
      String(payload.id),
      CONTROL_PLANE_RATE_LIMIT_POLICY
    );
    if (!rateLimit.allowed) {
      c.header("Retry-After", String(rateLimit.retryAfterSeconds));
      await writeSecurityAuditEvent(c.env, {
        eventType: "agent.enrollment.issue",
        outcome: "denied",
        actorType: "admin",
        actorId: payload.id,
        request: c.req.raw,
        metadata: { reason: "rate_limited" },
      });
      return c.json({ success: false, message: "注册令牌签发过于频繁" }, 429);
    }
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
      success: true,
      message: "已生成一次性客户端注册令牌",
      token: enrollment.token,
      expiresAt: enrollment.expiresAt,
    });
  } catch (error) {
    if (error instanceof AgentCredentialConfigurationError) {
      return c.json({ success: false, message: "Agent 凭据尚未配置" }, 503);
    }
    return c.json({ success: false, message: "生成客户端注册令牌失败" }, 500);
  }
});

agents.get("/enrollments", async (c) => {
  const payload = c.get("admin");
  const rows = await listAgentEnrollments(c.env, payload.id);
  return c.json({ success: true, data: rows });
});

agents.delete("/enrollments/:id", async (c) => {
  const payload = c.get("admin");
  const enrollmentId = idParamSchema.parse(c.req.param("id"));
  const revoked = await revokeAgentEnrollment(c.env, payload.id, enrollmentId);
  await writeSecurityAuditEvent(c.env, {
    eventType: "agent.enrollment.revoke",
    outcome: revoked ? "success" : "failure",
    actorType: "admin",
    actorId: payload.id,
    subjectType: "agent_enrollment",
    subjectId: enrollmentId,
    request: c.req.raw,
  });
  return c.json(
    {
      success: revoked,
      message: revoked ? "注册令牌已吊销" : "注册令牌不存在、已使用或已吊销",
    },
    revoked ? 200 : 409
  );
});

agents.get("/:id/credentials", async (c) => {
  const agentId = idParamSchema.parse(c.req.param("id"));
  const page = await listAgentCredentialMetadata(c.env, agentId, { limit: 100 });
  if (!page) {
    return c.json({ success: false, message: "客户端不存在" }, 404);
  }
  return c.json({ success: true, data: page.data });
});

agents.post("/:id/credentials/rotate", async (c) => {
  const payload = c.get("admin");
  const agentId = idParamSchema.parse(c.req.param("id"));
  const rateLimit = await consumeRateLimit(
    c.env,
    "agent_credential_rotate",
    `${payload.id}:${agentId}`,
    CONTROL_PLANE_RATE_LIMIT_POLICY
  );
  if (!rateLimit.allowed) {
    c.header("Retry-After", String(rateLimit.retryAfterSeconds));
    await writeSecurityAuditEvent(c.env, {
      eventType: "agent.credential.rotate",
      outcome: "denied",
      actorType: "admin",
      actorId: payload.id,
      subjectType: "agent",
      subjectId: agentId,
      request: c.req.raw,
      metadata: { reason: "rate_limited" },
    });
    return c.json({ success: false, message: "凭据轮换过于频繁" }, 429);
  }

  let rotated: Awaited<ReturnType<typeof rotateAgentCredential>>;
  try {
    rotated = await rotateAgentCredential(c.env, agentId);
  } catch (error) {
    if (error instanceof AgentCredentialLimitError) {
      return c.json({ success: false, message: error.message }, 409);
    }
    throw error;
  }
  if (!rotated) {
    return c.json({ success: false, message: "客户端不存在" }, 404);
  }
  await writeSecurityAuditEvent(c.env, {
    eventType: "agent.credential.rotate",
    outcome: "success",
    actorType: "admin",
    actorId: payload.id,
    subjectType: "agent",
    subjectId: agentId,
    request: c.req.raw,
  });
  return c.json({
    success: true,
    token: rotated.token,
    message: "新凭据已生成，请完成 Agent 切换后吊销旧凭据",
  });
});

agents.delete("/:id/credentials/:credentialId", async (c) => {
  const payload = c.get("admin");
  const agentId = idParamSchema.parse(c.req.param("id"));
  const credentialId = idParamSchema.parse(c.req.param("credentialId"));
  const result = await revokeAgentCredential(c.env, agentId, credentialId);
  await writeSecurityAuditEvent(c.env, {
    eventType: "agent.credential.revoke",
    outcome: result.success ? "success" : "failure",
    actorType: "admin",
    actorId: payload.id,
    subjectType: "agent_credential",
    subjectId: credentialId,
    request: c.req.raw,
    metadata: { agent_id: agentId, reason: result.reason ?? null },
  });
  if (!result.success) {
    return c.json(
      {
        success: false,
        message:
          result.reason === "agent_not_found"
            ? "客户端不存在"
            : "凭据不存在或这是最后一个有效凭据",
      },
      result.reason === "agent_not_found" ? 404 : 409
    );
  }
  return c.json({ success: true, message: "凭据已吊销" });
});

// 客户端自注册接口
agents.post("/register", async (c) => {
  const parsed = agentRegisterSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("客户端注册参数无效"), 400);
  }

  const { token, name, hostname, ip_addresses, os, version } = parsed.data;

  let result: {
    success: boolean;
    message: string;
    agent?: { id: number };
    status: number;
  };
  try {
    const registered = await registerLegacyAgent(c.env, {
      token,
      name: name || "New Agent",
      hostname,
      ip_addresses,
      os,
      version,
    });
    result = registered
      ? {
          success: true,
          message: registered.created ? "客户端注册成功" : "客户端已存在",
          agent: { id: registered.id },
          status: registered.created ? 201 : 200,
        }
      : { success: false, message: "注册令牌无效、已使用或已过期", status: 400 };
  } catch (error) {
    if (error instanceof AgentCredentialConfigurationError) {
      result = { success: false, message: "Agent 凭据尚未配置", status: 503 };
    } else {
      result = { success: false, message: "客户端注册失败", status: 500 };
    }
  }
  await writeSecurityAuditEvent(c.env, {
    eventType: "agent.register",
    outcome: result.success ? "success" : "failure",
    actorType: result.success ? "agent" : "anonymous",
    actorId: result.agent?.id ?? null,
    subjectType: "agent",
    subjectId: result.agent?.id ?? null,
    request: c.req.raw,
    metadata: { status_code: result.status },
  });

  const response = {
    success: result.success,
    message: result.message,
    agent: result.agent,
  };
  if (result.status === 201) return c.json(response, 201);
  if (result.status === 400) return c.json(response, 400);
  if (result.status === 503) return c.json(response, 503);
  if (result.status === 500) return c.json(response, 500);
  return c.json(response, 200);
});

// 通过令牌更新客户端状态
agents.post("/status", async (c) => {
  const parsed = agentStatusSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("客户端状态参数无效"), 400);
  }

  try {
    const { token, report } = await adaptLegacyAgentReport(
      parsed.data,
      c.req.header(AGENT_VERSION_HEADER)
    );
    const result = await createAgentUseCases(c.env).acceptReport(
      token,
      report,
      agentReportSourceFromCf(c.req.raw.cf)
    );
    const agentIntervals = {
      collect_interval: result.config.collect_interval_seconds,
      report_interval: result.config.report_interval_seconds,
    };

    // 配置下发协商：仅当请求携带合法 schema 头（2/3）时启用新响应模式
    // （旧 agent 走原 JSON 响应）。schema_version 回填客户端声明的版本，
    // 保证两端对同一规范化串计算 MD5。
    const clientSchema = normalizeAgentConfigSchema(
      c.req.header(AGENT_CONFIG_SCHEMA_HEADER)
    );
    if (clientSchema !== null) {
      const descriptor = getAgentConfigDescriptor(
        agentIntervals,
        clientSchema
      );
      const clientMd5 = (c.req.header(AGENT_CONFIG_MD5_HEADER) ?? "")
        .trim()
        .toLowerCase();
      const responseHeaders: Record<string, string> = {
        "Cache-Control": "no-store",
        [AGENT_CONFIG_SCHEMA_HEADER]: String(clientSchema),
        [AGENT_CONFIG_MD5_HEADER]: descriptor.md5,
      };

      // 自升级触发（仅 v3+ 客户端）：update=1 附加在响应串末尾作为指令通道，
      // 不参与 MD5（响应头仍是规范化三键串的 MD5，客户端本地 MD5 只覆盖三键串）
      const triggerUpdate =
        clientSchema >= AGENT_CONFIG_SCHEMA_VERSION &&
        result.config.update;

      if (triggerUpdate) {
        // 升级指令必须送达：即使 MD5 一致也返回 200 + 配置串 + update=1
        return c.body(
          `${descriptor.serialized}&${AGENT_CONFIG_UPDATE_DIRECTIVE}`,
          200,
          {
            ...responseHeaders,
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          }
        );
      }

      if (clientMd5 === descriptor.md5) {
        // MD5 一致：配置无变化
        return c.body(null, 204, responseHeaders);
      }
      // MD5 不一致：下发完整规范配置串
      return c.body(descriptor.serialized, 200, {
        ...responseHeaders,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      });
    }

    return c.json(
      {
        success: true,
        message: "客户端状态已接收",
        accepted: result.accepted,
        duplicate: result.duplicate,
        sampled: false,
        recommendedReportIntervalSeconds:
          result.config.report_interval_seconds,
      },
      200
    );
  } catch (error) {
    if (error instanceof AgentCredentialConfigurationError) {
      return c.json({ success: false, message: "Agent 凭据尚未配置" }, 503);
    }
    if (error instanceof ApplicationProblem) {
      return c.json(
        { success: false, message: error.message, code: error.code },
        error.status as 400
      );
    }
    return c.json(
      {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

// 获取单个客户端的指标（hours 白名单：1/6/12/24/168，默认 24）
agents.get("/:id/metrics", async (c) => {
  const agentId = idParamSchema.parse(c.req.param("id"));
  const hours = normalizeAgentMetricsHours(c.req.query("hours"));
  if (hours === null) {
    return c.json(badRequest("hours 参数无效"), 400);
  }
  const result = await queryLegacyAgentMetrics(c.env, agentId, hours);
  if (!result) {
    return c.json(
      {
        success: false,
        message: "客户端不存在或无权访问",
      },
      404
    );
  }
  return c.json(
    {
      success: true,
      agent: result,
      message: "获取客户端指标成功",
    },
    200
  );
});

// 获取单个客户端的最新指标
agents.get("/:id/metrics/latest", async (c) => {
  const agentId = idParamSchema.parse(c.req.param("id"));
  const result = await queryLatestLegacyAgentMetric(c.env, agentId);
  if (result === null) {
    return c.json(
      {
        success: false,
        message: "客户端不存在或无权访问",
      },
      404
    );
  }
  return c.json(
    {
      success: true,
      agent: result,
      message: "获取客户端最新指标成功",
    },
    200
  );
});

// 获取单个客户端
agents.get("/:id", async (c) => {
  const agentId = idParamSchema.parse(c.req.param("id"));

  const result = await getLegacyAgent(c.env, agentId);
  if (!result) {
    return c.json(
      {
        success: false,
        message: "客户端不存在或无权访问",
      },
      404
    );
  }

  return c.json(
    {
      success: true,
      agent: result,
    },
    200
  );
});

export { agents };
