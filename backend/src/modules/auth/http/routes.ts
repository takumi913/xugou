import { Hono } from "hono";
import { AuthVariables } from "../../../types";
import { createAuthUseCases } from "../composition";
import { Bindings } from "../../../models/db";
import { authCredentialsSchema, legacyBadRequest } from "./schemas";
import {
  createAdminSession,
  revokeAdminSession,
  SessionConfigurationError,
} from "../persistence/D1SessionStore";
import {
  clearAdminSessionCookies,
  getAdminSessionCookie,
  setAdminSessionCookies,
} from "../../../utils/session-cookie";
import {
  clearRateLimit,
  consumeRateLimit,
  getRequestClientIp,
  LOGIN_RATE_LIMIT_POLICY,
  writeSecurityAuditEvent,
} from "../../../platform/security/SecurityStore";
import {
  isV2ApiRequest,
  problemResponse,
} from "../../../platform/http/problem";


const auth = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();

function authProblem(
  c: Parameters<typeof problemResponse>[0],
  status: number,
  code: string,
  title: string,
  detail?: string
) {
  return problemResponse(c, { status, code, title, detail });
}

// 登录路由
auth.post("/login", async (c) => {
  try {
    const parsed = authCredentialsSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) {
      if (isV2ApiRequest(c)) {
        return authProblem(c, 400, "VALIDATION_ERROR", "Request validation failed");
      }
      return c.json(legacyBadRequest("登录参数无效"), 400);
    }

    const { username, password } = parsed.data;
    const rateLimit = await consumeRateLimit(
      c.env,
      "admin_login",
      `${getRequestClientIp(c.req.raw)}:${username.toLowerCase()}`,
      LOGIN_RATE_LIMIT_POLICY
    );
    if (!rateLimit.allowed) {
      c.header("Retry-After", String(rateLimit.retryAfterSeconds));
      await writeSecurityAuditEvent(c.env, {
        eventType: "admin.login",
        outcome: "denied",
        actorType: "anonymous",
        request: c.req.raw,
        metadata: {
          reason: "rate_limited",
          attempts: rateLimit.attempts,
          retry_after_seconds: rateLimit.retryAfterSeconds,
        },
      });
      if (isV2ApiRequest(c)) {
        return authProblem(
          c,
          429,
          "LOGIN_RATE_LIMITED",
          "Too many login attempts",
          "登录尝试过于频繁"
        );
      }
      return c.json({ success: false, message: "登录尝试过于频繁" }, 429);
    }

    const useCases = createAuthUseCases(c.env);
    const bootstrap = await useCases.bootstrapPrimaryAdmin(
      username,
      password,
      c.env.ADMIN_INITIAL_PASSWORD
    );
    if (bootstrap.status === "configuration_error") {
      if (isV2ApiRequest(c)) {
        return authProblem(
          c,
          503,
          "ADMIN_BOOTSTRAP_UNAVAILABLE",
          "Initial administrator is not configured"
        );
      }
      return c.json({ success: false, message: "初始管理员密钥尚未配置" }, 503);
    }
    if (bootstrap.status === "created") {
      await writeSecurityAuditEvent(c.env, {
        eventType: "admin.bootstrap",
        outcome: "success",
        actorType: "admin",
        actorId: 1,
        request: c.req.raw,
      });
    }

    const result = await useCases.login(username, password);

    if (!result.success || !result.user) {
      await writeSecurityAuditEvent(c.env, {
        eventType: "admin.login",
        outcome: "failure",
        actorType: "anonymous",
        request: c.req.raw,
        metadata: { reason: "invalid_credentials" },
      });
      if (isV2ApiRequest(c)) {
        return authProblem(
          c,
          401,
          "INVALID_CREDENTIALS",
          "Invalid credentials",
          result.message
        );
      }
      return c.json({ success: false, message: result.message }, 401);
    }

    const session = await createAdminSession(c.env, result.user.id);
    setAdminSessionCookies(c, session.token, session.expiresAt);
    await clearRateLimit(c.env, rateLimit.keyDigest);
    await writeSecurityAuditEvent(c.env, {
      eventType: "admin.login",
      outcome: "success",
      actorType: "admin",
      actorId: result.user.id,
      request: c.req.raw,
    });

    return c.json(
      {
        success: true,
        message: result.message,
        user: result.user,
      },
      200
    );
  } catch (error) {
    if (error instanceof SessionConfigurationError) {
      if (isV2ApiRequest(c)) {
        return authProblem(c, 503, "SESSION_UNAVAILABLE", "Session service unavailable");
      }
      return c.json({ success: false, message: "管理会话尚未配置" }, 503);
    }
    if (isV2ApiRequest(c)) {
      return authProblem(c, 500, "LOGIN_FAILED", "Login failed");
    }
    return c.json({ success: false, message: "登录失败" }, 500);
  }
});

auth.get("/me", async (c) => {
  try {
    const payload = c.get("admin");

    const result = await createAuthUseCases(c.env).getCurrentAdmin(payload.id);

    // Bearer 会话用于 CLI/运维调用；浏览器访问时补发 Cookie。
    const authSource = c.get("authSource");
    if (result.success && authSource !== "session-cookie") {
      const session = await createAdminSession(c.env, payload.id);
      setAdminSessionCookies(c, session.token, session.expiresAt);
      await writeSecurityAuditEvent(c.env, {
        eventType: "admin.session.upgrade",
        outcome: "success",
        actorType: "admin",
        actorId: payload.id,
        request: c.req.raw,
        metadata: { source: authSource },
      });
    }

    if (!result.success && isV2ApiRequest(c)) {
      return authProblem(c, 404, "ADMIN_NOT_FOUND", "Administrator not found");
    }
    return c.json(
      { success: result.success, message: result.message, user: result.user },
      result.success ? 200 : 404
    );
  } catch (error) {
    if (error instanceof SessionConfigurationError) {
      if (isV2ApiRequest(c)) {
        return authProblem(c, 503, "SESSION_UNAVAILABLE", "Session service unavailable");
      }
      return c.json({ success: false, message: "管理会话尚未配置" }, 503);
    }
    if (isV2ApiRequest(c)) {
      return authProblem(c, 500, "SESSION_LOOKUP_FAILED", "Session lookup failed");
    }
    return c.json({ success: false, message: "获取用户信息失败" }, 500);
  }
});

auth.post("/logout", async (c) => {
  try {
    const payload = c.get("admin");
    const token = getAdminSessionCookie(c) ?? c.get("authSessionToken") ?? null;
    if (token) {
      await revokeAdminSession(c.env, token);
    }
    clearAdminSessionCookies(c);
    await writeSecurityAuditEvent(c.env, {
      eventType: "admin.logout",
      outcome: "success",
      actorType: "admin",
      actorId: payload.id,
      request: c.req.raw,
    });
    return c.json({ success: true, message: "已退出登录" });
  } catch (error) {
    clearAdminSessionCookies(c);
    if (isV2ApiRequest(c)) {
      return authProblem(c, 500, "LOGOUT_FAILED", "Logout failed");
    }
    return c.json({ success: false, message: "退出登录失败" }, 500);
  }
});

export { auth };
