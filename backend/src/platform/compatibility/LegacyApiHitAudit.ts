import type { Bindings } from "../../models/db";
import { writeStructuredLog } from "../observability/StructuredLogger";

export type LegacyRouteGroup =
  | "monitor_management_v1"
  | "agent_management_v1"
  | "agent_registration_v1"
  | "agent_report_v1"
  | "notification_management_v1"
  | "status_v1";

function classify(path: string): LegacyRouteGroup | null {
  if (path === "/api/agents/status") return "agent_report_v1";
  if (path === "/api/agents/register") return "agent_registration_v1";
  if (path === "/api/agents" || path.startsWith("/api/agents/")) {
    return "agent_management_v1";
  }
  if (path === "/api/monitors" || path.startsWith("/api/monitors/")) {
    return "monitor_management_v1";
  }
  if (
    path === "/api/notifications" ||
    path.startsWith("/api/notifications/")
  ) {
    return "notification_management_v1";
  }
  if (path === "/api/status" || path.startsWith("/api/status/")) {
    return "status_v1";
  }
  return null;
}

function releaseVersion(env: Bindings) {
  return env.CF_VERSION_METADATA?.id ?? "local";
}

export async function recordLegacyApiHit(
  env: Bindings,
  request: Request,
  responseStatus: number
) {
  const path = new URL(request.url).pathname;
  const routeGroup = classify(path);
  if (!routeGroup) return;

  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const method = request.method.toUpperCase().slice(0, 16);
  const statusFamily = `${Math.floor(responseStatus / 100)}xx`;
  await env.DB.prepare(
    `INSERT INTO api_compatibility_hits
       (day, route_group, method, status_family, hit_count, first_seen_at,
        last_seen_at, last_release_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(day, route_group, method, status_family) DO UPDATE SET
       hit_count = api_compatibility_hits.hit_count + 1,
       last_seen_at = excluded.last_seen_at,
       last_release_version = excluded.last_release_version,
       updated_at = excluded.updated_at`
  )
    .bind(
      day,
      routeGroup,
      method,
      statusFamily,
      now,
      now,
      releaseVersion(env),
      now,
      now
    )
    .run();
}

export function auditLegacyApiHit(
  env: Bindings,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  request: Request,
  responseStatus: number
) {
  const path = new URL(request.url).pathname;
  const task = recordLegacyApiHit(env, request, responseStatus).catch((error) => {
    writeStructuredLog(env, {
      service: "http",
      operation: "record_legacy_api_hit",
      result: "failure",
      errorCode: "LEGACY_API_AUDIT_FAILED",
      error,
      fields: { method: request.method, path, response_status: responseStatus },
    });
  });
  ctx.waitUntil(task);
}
