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
  updateAgentsOrderService,
  exportAgentsService,
  importAgentsService,
  getAgentMetrics,
  getLatestAgentMetrics,
  normalizeAgentMetricsHours,
} from "../services/AgentService";
import type { WaitUntilContext } from "../services/BroadcastService";
import {
  AGENT_CONFIG_MD5_HEADER,
  AGENT_CONFIG_SCHEMA_HEADER,
  AGENT_CONFIG_SCHEMA_VERSION,
  AGENT_CONFIG_UPDATE_DIRECTIVE,
  AGENT_VERSION_HEADER,
  md5Hex,
  normalizeAgentConfigSchema,
  serializeAgentConfig,
  shouldTriggerAgentUpdate,
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

const agents = new Hono<{
  Bindings: Bindings;
  Variables: { agent: Agent; jwtPayload: JwtPayload };
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
  const payload = c.get("jwtPayload") as JwtPayload;
  const includeLatestMetrics =
    c.req.query("includeLatestMetrics") === "true";
  const result = includeLatestMetrics
    ? await getAgentsWithLatestMetrics(payload.id, c.env)
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

// 手动排序：按 body.ids 的数组顺序写 sort_order（须在 /:id 之前注册）
agents.put("/order", async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;
  const parsed = orderUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("排序参数无效"), 400);
  }

  const result = await updateAgentsOrderService(
    parsed.data.ids,
    payload.id,
    payload.role
  );
  return c.json(
    { success: result.success, message: result.message },
    result.status as any
  );
});

// 导出客户端配置（JSON 数组，含 token；须在 /:id 之前注册）
agents.get("/export", async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;
  const agentsData = await exportAgentsService(payload.id);
  return c.json(agentsData, 200, {
    "Content-Disposition": 'attachment; filename="xugou-agents.json"',
    "Cache-Control": "no-store",
  });
});

// 导入客户端配置：按 name 去重跳过，token 冲突时重新生成
agents.post("/import", async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;
  const parsed = agentImportSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(badRequest("客户端导入数据无效"), 400);
  }

  try {
    const result = await importAgentsService(c.env, parsed.data, payload.id);
    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    console.error("导入客户端错误:", error);
    return c.json({ success: false, message: "导入客户端失败" }, 500);
  }
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
    // executionCtx 在部分运行环境（如单元测试）不可用，取不到时降级为 undefined
    let executionCtx: WaitUntilContext | undefined;
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined;
    }

    // region 由服务端判定：优先 request.cf.country，回退 cf-ipcountry 头；
    // 城市级地理位置同样取自 request.cf（lat/lon 为字符串，规范化在服务层）
    const cfRequest = c.req.raw as Request & {
      cf?: {
        country?: string;
        latitude?: string;
        longitude?: string;
        city?: string;
        region?: string;
      };
    };
    const cf = cfRequest.cf;
    const region = cf?.country ?? c.req.header("cf-ipcountry") ?? null;
    const geo = {
      latitude: cf?.latitude ?? null,
      longitude: cf?.longitude ?? null,
      city: cf?.city ?? null,
      regionName: cf?.region ?? null,
    };

    const result = await updateAgentStatusService(
      parsed.data,
      c.env,
      executionCtx,
      region,
      geo
    );

    // 配置下发协商：仅当请求携带合法 schema 头（2/3）时启用新响应模式
    // （旧 agent 走原 JSON 响应）。schema_version 回填客户端声明的版本，
    // 保证两端对同一规范化串计算 MD5。
    const clientSchema = normalizeAgentConfigSchema(
      c.req.header(AGENT_CONFIG_SCHEMA_HEADER)
    );
    if (clientSchema !== null) {
      const descriptor = getAgentConfigDescriptor(
        result.agentIntervals,
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
        shouldTriggerAgentUpdate(
          result.agentAutoUpdate,
          c.env.LATEST_AGENT_VERSION,
          c.req.header(AGENT_VERSION_HEADER)
        );

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

// 获取单个客户端的指标（hours 白名单：1/6/12/24/168，默认 24）
agents.get("/:id/metrics", async (c) => {
  const agentId = idParamSchema.parse(c.req.param("id"));
  const payload = c.get("jwtPayload") as JwtPayload;
  const hours = normalizeAgentMetricsHours(c.req.query("hours"));
  if (hours === null) {
    return c.json(badRequest("hours 参数无效"), 400);
  }
  const result = await getAgentMetrics(agentId, payload.id, payload.role, hours);
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
