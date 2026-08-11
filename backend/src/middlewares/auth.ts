import { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { Bindings } from "../models/db";
import {
  authenticateAdminSession,
  SessionConfigurationError,
} from "../modules/auth/persistence/D1SessionStore";
import { AuthSource, AuthVariables } from "../types";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from "../utils/session-cookie";
import { isV2ApiRequest, problemResponse } from "../platform/http/problem";

function isPublicStatusRoute(path: string) {
  return (
    path === "/api/status/public/data" ||
    /^\/api\/status\/public\/agents\/\d+\/metrics$/.test(path) ||
    path === "/api/v2/status/public" ||
    path === "/api/v2/status/public/ws" ||
    /^\/api\/v2\/status\/public\/agents\/\d+\/metrics$/.test(path)
  );
}

function getBearerToken(c: Context): string | null {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length).trim() || null;
}

function isUnsafeMethod(method: string) {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

type AppContext = Context<{ Bindings: Bindings; Variables: AuthVariables }>;

function isTrustedWriteOrigin(c: AppContext) {
  const origin = c.req.header("Origin");
  if (!origin) {
    return false;
  }

  if (origin === new URL(c.req.url).origin) {
    return true;
  }

  return (c.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && value !== "*")
    .includes(origin);
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function hasValidCsrfProof(c: AppContext) {
  const cookieToken = getCookie(c, CSRF_COOKIE_NAME);
  const headerToken = c.req.header(CSRF_HEADER_NAME);
  return Boolean(
    cookieToken &&
      headerToken &&
      constantTimeEqual(cookieToken, headerToken)
  );
}

async function authenticateRequest(c: AppContext) {
  const cookieToken = getCookie(c, SESSION_COOKIE_NAME) ?? null;
  const bearerToken = getBearerToken(c);

  const sessionCandidates: Array<{
    token: string;
    source: Extract<AuthSource, "session-cookie" | "session-bearer">;
  }> = [];
  if (cookieToken) {
    sessionCandidates.push({ token: cookieToken, source: "session-cookie" });
  }
  if (bearerToken?.startsWith("xgs_") && bearerToken !== cookieToken) {
    sessionCandidates.push({ token: bearerToken, source: "session-bearer" });
  }

  for (const candidate of sessionCandidates) {
    const authenticated = await authenticateAdminSession(c.env, candidate.token);
    if (authenticated) {
      return {
        payload: authenticated.payload,
        source: candidate.source,
        sessionToken: candidate.token,
      };
    }
  }

  return null;
}

/**
 * 管理端认证中间件：只校验 D1 中的不透明会话摘要。
 */
export const adminSessionMiddleware = async (
  c: AppContext,
  next: Next
) => {
  if (!c.req.path.startsWith("/api/")) {
    return next();
  }

  if (
    (c.req.path === "/api/agents/status" ||
      c.req.path === "/api/agents/register" ||
      c.req.path === "/api/v2/agents/register" ||
      c.req.path === "/api/v2/agents/reports" ||
      c.req.path === "/api/auth/login" ||
      c.req.path === "/api/v2/session/login") &&
    c.req.method === "POST"
  ) {
    return next();
  }

  // WebSocket 在升级路由中独立校验 HttpOnly Cookie 会话。
  if (c.req.path === "/api/ws" && c.req.method === "GET") {
    return next();
  }

  if (isPublicStatusRoute(c.req.path) && c.req.method === "GET") {
    return next();
  }



  try {
    const authenticated = await authenticateRequest(c);
    if (!authenticated) {
      if (isV2ApiRequest(c)) {
        return problemResponse(c, {
          status: 401,
          code: "UNAUTHORIZED",
          title: "Authentication required",
        });
      }
      return c.json({ success: false, message: "Unauthorized" }, 401);
    }

    if (
      authenticated.source === "session-cookie" &&
      isUnsafeMethod(c.req.method) &&
      (!isTrustedWriteOrigin(c) || !hasValidCsrfProof(c))
    ) {
      if (isV2ApiRequest(c)) {
        return problemResponse(c, {
          status: 403,
          code: "CSRF_VALIDATION_FAILED",
          title: "CSRF validation failed",
        });
      }
      return c.json({ success: false, message: "CSRF validation failed" }, 403);
    }

    c.set("admin", authenticated.payload);
    c.set("authSource", authenticated.source);
    if (authenticated.sessionToken) {
      c.set("authSessionToken", authenticated.sessionToken);
    }
    await next();
  } catch (error) {
    if (error instanceof SessionConfigurationError) {
      if (isV2ApiRequest(c)) {
        return problemResponse(c, {
          status: 503,
          code: "SESSION_UNAVAILABLE",
          title: "Session service unavailable",
        });
      }
      return c.json({ success: false, message: "Session unavailable" }, 503);
    }
    if (isV2ApiRequest(c)) {
      return problemResponse(c, {
        status: 401,
        code: "UNAUTHORIZED",
        title: "Authentication required",
      });
    }
    return c.json({ success: false, message: "Unauthorized" }, 401);
  }
};
