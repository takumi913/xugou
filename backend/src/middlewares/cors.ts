import type { Context, Next } from "hono";
import type { Bindings } from "../models/db";

const ALLOW_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOW_HEADERS =
  "Content-Type, Authorization, X-Requested-With, X-CSRF-Token";

function configuredOrigins(env?: Partial<Bindings>) {
  return (env?.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin !== "*")
    .flatMap((origin) => {
      try {
        return [new URL(origin).origin];
      } catch {
        return [];
      }
    });
}

/**
 * The frontend ships from the same Worker, so same-origin is the secure
 * default. Cross-origin management UIs must be explicitly listed; wildcard
 * origins are ignored because this API uses credentialed HttpOnly cookies.
 */
export function getAllowedOrigin(
  requestOrigin: string | null,
  requestUrl: string,
  env?: Partial<Bindings>
): string | null {
  if (!requestOrigin) return null;

  let normalizedRequestOrigin: string;
  try {
    normalizedRequestOrigin = new URL(requestOrigin).origin;
  } catch {
    return null;
  }
  if (normalizedRequestOrigin !== requestOrigin) return null;

  const sameOrigin = new URL(requestUrl).origin;
  return normalizedRequestOrigin === sameOrigin ||
    configuredOrigins(env).includes(normalizedRequestOrigin)
    ? normalizedRequestOrigin
    : null;
}

export const createCorsHeaders = (
  request: Request,
  env?: Partial<Bindings>
) => {
  const allowedOrigin = getAllowedOrigin(
    request.headers.get("Origin"),
    request.url,
    env
  );
  const headers = new Headers({ Vary: "Origin" });
  if (!allowedOrigin) return headers;

  headers.set("Access-Control-Allow-Origin", allowedOrigin);
  headers.set("Access-Control-Allow-Methods", ALLOW_METHODS);
  headers.set("Access-Control-Allow-Headers", ALLOW_HEADERS);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
};

/** Applies an exact allow-list CORS policy without reflecting unknown origins. */
export const corsMiddleware = async (c: Context, next: Next) => {
  // A WebSocket 101 response is immutable. Its route performs same-origin and
  // administrator-session checks before entering the Durable Object.
  if (c.req.header("Upgrade")?.toLowerCase() === "websocket") {
    return next();
  }

  const corsHeaders = createCorsHeaders(
    c.req.raw,
    c.env as Partial<Bindings>
  );
  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  await next();
  corsHeaders.forEach((value, key) => c.header(key, value));
};
