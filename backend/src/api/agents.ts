import { Hono } from "hono";
import { JwtPayload } from "../types";
import { Bindings } from "../models/db";
import { Agent } from "../models/agent";
import {
  getAgents,
  getAgentsWithLatestMetrics,
  getAgentDetail,
  updateAgentService,
  deleteAgentService,
  generateAgentToken,
  registerAgentService,
  updateAgentStatusService,
  getAgentMetrics,
  getLatestAgentMetrics,
} from "../services/AgentService";
import {
  agentRegisterSchema,
  agentStatusSchema,
  agentUpdateSchema,
  badRequest,
  idParamSchema,
} from "./schemas";

const agents = new Hono<{
  Bindings: Bindings;
  Variables: { agent: Agent; jwtPayload: JwtPayload };
}>();

// 获取所有客户端
agents.get("/", async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;
  const includeLatestMetrics =
    c.req.query("includeLatestMetrics") === "true";
  const result = includeLatestMetrics
    ? await getAgentsWithLatestMetrics(payload.id)
    : await getAgents(payload.id);

  return c.json(
    {
      success: result.success,
      agents: result.agents,
      message: result.message,
    },
    result.status as any
  );
});

// 更新客户端信息
agents.put("/:id", async (c) => {
  const agentId = idParamSchema.parse(c.req.param("id"));
  const payload = c.get("jwtPayload") as JwtPayload;
  const parsed = agentUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("客户端更新参数无效"), 400);
  }

  const result = await updateAgentService(
    agentId,
    parsed.data,
    payload.id,
    payload.role
  );

  return c.json(
    {
      success: result.success,
      message: result.message,
      agent: result.agent,
    },
    result.status as any
  );
});

// 删除客户端
agents.delete("/:id", async (c) => {
  try {
    const agentId = idParamSchema.parse(c.req.param("id"));
    const payload = c.get("jwtPayload") as JwtPayload; // 获取用户信息

    const result = await deleteAgentService(
      agentId,
      payload.id,
      payload.role
    );

    return c.json(
      {
        success: result.success,
        message: result.message,
      },
      result.status as any
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
  // 生成新令牌
  const newToken = await generateAgentToken(c.env);

  // 可以选择将此token存储在临时表中，或者使用其他方式验证(例如，设置过期时间)
  // 这里为简化操作，只返回令牌

  return c.json({
    success: true,
    message: "已生成客户端注册令牌",
    token: newToken,
  });
});

// 客户端自注册接口
agents.post("/register", async (c) => {
  const parsed = agentRegisterSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("客户端注册参数无效"), 400);
  }

  const { token, name, hostname, ip_addresses, os, version } = parsed.data;

  const result = await registerAgentService(
    c.env,
    token,
    name || "New Agent",
    hostname,
    ip_addresses,
    os,
    version
  );

  return c.json(
    {
      success: result.success,
      message: result.message,
      agent: result.agent,
    },
    result.status as any
  );
});

// 通过令牌更新客户端状态
agents.post("/status", async (c) => {
  const parsed = agentStatusSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("客户端状态参数无效"), 400);
  }

  try {
    const result = await updateAgentStatusService(parsed.data, c.env);
    return c.json(
      {
        success: true,
        message: "客户端状态已更新",
        sampled: result.sampled,
        recommendedReportIntervalSeconds:
          result.recommendedReportIntervalSeconds,
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

// 获取单个客户端的指标
agents.get("/:id/metrics", async (c) => {
  const agentId = idParamSchema.parse(c.req.param("id"));
  const payload = c.get("jwtPayload") as JwtPayload;
  const result = await getAgentMetrics(agentId, payload.id, payload.role);
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
  const payload = c.get("jwtPayload") as JwtPayload;
  const result = await getLatestAgentMetrics(agentId, payload.id, payload.role);
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
      message: "获取客户端最新指标成功",
    },
    200
  );
});

// 获取单个客户端
agents.get("/:id", async (c) => {
  const agentId = idParamSchema.parse(c.req.param("id"));
  const payload = c.get("jwtPayload") as JwtPayload;

  const result = await getAgentDetail(agentId, payload.id, payload.role);
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
