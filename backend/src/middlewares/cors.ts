import { Context, Next } from "hono";
import { cors as honoCors } from "hono/cors";
import { Bindings } from "../models/db";

const parseAllowedOrigins = (env?: Partial<Bindings>) =>
  (env?.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

export const getAllowedOrigin = (
  requestOrigin: string | null,
  env?: Partial<Bindings>
) => {
  const allowedOrigins = parseAllowedOrigins(env);

  if (allowedOrigins.includes("*")) {
    return "*";
  }

  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  return allowedOrigins[0] || "*";
};

export const createCorsHeaders = (request: Request, env?: Partial<Bindings>) => {
  const origin = getAllowedOrigin(request.headers.get("Origin"), env);
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
};

/**
 * CORS中间件
 * 处理跨域资源共享并设置必要的响应头
 */
export const corsMiddleware = async (c: Context, next: Next) => {
  // 如果是 OPTIONS 请求，直接返回成功响应
  if (c.req.method === "OPTIONS") {
    const headers = createCorsHeaders(c.req.raw, c.env as Partial<Bindings>);
    for (const [key, value] of Object.entries(headers)) {
      c.header(key, value);
    }
    return new Response(null, { status: 204 });
  }

  // 使用CORS中间件
  const corsHandler = honoCors({
    origin: (origin) =>
      getAllowedOrigin(origin, c.env as Partial<Bindings>),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    exposeHeaders: ["Content-Length", "Content-Type"],
    maxAge: 86400,
  });

  // 先执行CORS中间件
  await corsHandler(c, next);

  // 确保响应头设置正确
  c.header(
    "Access-Control-Allow-Origin",
    getAllowedOrigin(c.req.header("Origin") ?? null, c.env as Partial<Bindings>)
  );
  c.header("Vary", "Origin");
};
