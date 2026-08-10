import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputPath = path.join(backendDir, "openapi/v2.json");

type Method = "get" | "post" | "put" | "patch" | "delete";
type Schema = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema) => ({
  content: { "application/json": { schema } },
});
const ok = (schema: Schema) => ({ description: "Success", ...json(schema) });
const noContent = { description: "No content" };
const problem = { description: "Problem Details", ...json(ref("ApiProblem")) };
const data = (schema: Schema) => ({
  type: "object",
  required: ["data"],
  properties: { data: schema },
});
const pathId = (name = "id", type: "integer" | "string" = "integer") => ({
  name,
  in: "path",
  required: true,
  schema:
    type === "integer"
      ? { type, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
      : { type, minLength: 1, maxLength: 256 },
});

const paths: Record<string, Partial<Record<Method, Record<string, unknown>>>> = {};
function add(
  route: string,
  method: Method,
  operationId: string,
  options: Record<string, unknown> = {}
) {
  const operation: Record<string, unknown> = {
    operationId,
    tags: [route.split("/")[3] || "v2"],
    responses: { 200: ok({ type: "object", additionalProperties: true }), 400: problem, 401: problem, 500: problem },
    ...options,
  };
  if (method !== "get" && !("security" in options)) {
    operation.responses = {
      ...(operation.responses as Record<number, unknown>),
      403: problem,
    };
  }
  (paths[route] ??= {})[method] = operation;
}

add("/api/v2/session/login", "post", "loginSessionV2", {
  security: [],
  requestBody: { required: true, ...json(ref("LoginCommand")) },
  responses: { 200: ok(ref("SessionResult")), 400: problem, 401: problem, 429: problem, 503: problem },
});
add("/api/v2/session/me", "get", "getCurrentSessionV2", {
  responses: { 200: ok(ref("SessionResult")), 401: problem, 404: problem, 503: problem },
});
add("/api/v2/session/logout", "post", "logoutSessionV2", {
  responses: { 200: ok(ref("SessionResult")), 401: problem, 500: problem },
});
add("/api/v2/profile", "put", "updateAdminProfileV2", {
  requestBody: { required: true, ...json(ref("AdminProfileUpdate")) },
  responses: { 200: ok(ref("SessionResult")), 400: problem, 401: problem, 404: problem, 500: problem },
});
add("/api/v2/profile/change-password", "post", "changeAdminPasswordV2", {
  requestBody: { required: true, ...json(ref("AdminPasswordChange")) },
  responses: { 200: ok(ref("SessionResult")), 400: problem, 401: problem, 404: problem, 500: problem },
});
add("/api/v2/dashboard", "get", "getDashboardV2", {
  responses: { 200: ok(ref("DashboardData")), 401: problem, 500: problem },
});

add("/api/v2/monitors", "get", "listMonitorsV2", {
  parameters: [
    { name: "cursor", in: "query", schema: { type: "string", pattern: "^-?\\d+:\\d+$", maxLength: 64 } },
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
  ],
  responses: { 200: ok(ref("MonitorPage")), 400: problem, 401: problem, 500: problem },
});
add("/api/v2/monitors/history", "get", "listMonitorHistoryV2", {
  parameters: [{ name: "monitor_id", in: "query", required: true, schema: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }],
  responses: { 200: ok(data({ type: "array", maxItems: 1440, items: ref("MonitorHistory") })), 400: problem, 401: problem, 404: problem, 500: problem },
});
add("/api/v2/monitors/daily", "get", "listMonitorDailyStatsV2", {
  parameters: [
    { name: "monitor_id", in: "query", required: true, schema: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
    { name: "days", in: "query", schema: { type: "integer", minimum: 1, maximum: 366, default: 90 } },
  ],
  responses: { 200: ok(data({ type: "array", maxItems: 366, items: ref("MonitorDailyStats") })), 400: problem, 401: problem, 404: problem, 500: problem },
});
add("/api/v2/monitors/order", "put", "updateMonitorOrderV2", {
  requestBody: { required: true, ...json(ref("MonitorOrderCommand")) },
  responses: { 200: ok(data(ref("MonitorOrderCommand"))), 400: problem, 401: problem, 409: problem, 500: problem },
});
add("/api/v2/monitors/export", "get", "exportMonitorsV2", {
  responses: { 200: ok(data({ type: "array", items: ref("MonitorExportItem") })), 401: problem, 500: problem },
});
add("/api/v2/monitors/import", "post", "importMonitorsV2", {
  requestBody: { required: true, ...json({ type: "array", minItems: 1, maxItems: 1000, items: ref("MonitorImportItem") }) },
  responses: { 200: ok(data(ref("ImportResult"))), 400: problem, 401: problem, 500: problem },
});
add("/api/v2/monitors/{id}", "get", "getMonitorV2", { parameters: [pathId()], responses: { 200: ok(data(ref("Monitor"))), 400: problem, 401: problem, 404: problem, 500: problem } });
add("/api/v2/monitors", "post", "createMonitorV2", { requestBody: { required: true, ...json(ref("MonitorMutation")) }, responses: { 201: ok(data(ref("Monitor"))), 400: problem, 401: problem, 500: problem } });
add("/api/v2/monitors/{id}", "patch", "updateMonitorV2", { parameters: [pathId()], requestBody: { required: true, ...json(ref("MonitorUpdate")) }, responses: { 200: ok(data(ref("Monitor"))), 400: problem, 401: problem, 404: problem, 409: problem, 500: problem } });
add("/api/v2/monitors/{id}", "delete", "deleteMonitorV2", { parameters: [pathId()], responses: { 204: noContent, 400: problem, 401: problem, 500: problem } });
add("/api/v2/monitors/{id}/check", "post", "checkMonitorV2", { parameters: [pathId()], responses: { 202: ok(data(ref("MonitorCheckAccepted"))), 400: problem, 401: problem, 404: problem, 500: problem } });

add("/api/v2/agents", "get", "listAgentsV2", {
  parameters: [
    { name: "cursor", in: "query", schema: { type: "string", pattern: "^-?\\d+:\\d+$", maxLength: 64 } },
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
    { name: "include_latest_metrics", in: "query", schema: { type: "string", enum: ["true", "false"], default: "false" } },
  ],
  responses: { 200: ok(ref("AgentPage")), 400: problem, 401: problem, 500: problem },
});
add("/api/v2/agents/export", "get", "exportAgentsV2", { responses: { 200: ok(data({ type: "array", items: ref("AgentExportItem") })), 401: problem, 500: problem } });
add("/api/v2/agents/import", "post", "importAgentsV2", { requestBody: { required: true, ...json({ type: "array", minItems: 1, maxItems: 500, items: ref("AgentImportItem") }) }, responses: { 200: ok(data(ref("AgentImportResult"))), 400: problem, 401: problem, 503: problem } });
add("/api/v2/agents/order", "put", "updateAgentOrderV2", { requestBody: { required: true, ...json(ref("AgentOrderCommand")) }, responses: { 200: ok(data(ref("AgentOrderCommand"))), 400: problem, 401: problem, 409: problem, 500: problem } });
add("/api/v2/agents/enrollments", "post", "issueAgentEnrollmentV2", { responses: { 201: ok(data(ref("AgentEnrollmentIssued"))), 401: problem, 429: problem, 503: problem } });
add("/api/v2/agents/enrollments", "get", "listAgentEnrollmentsV2", { responses: { 200: ok(data({ type: "array", items: ref("AgentEnrollment") })), 401: problem, 500: problem } });
add("/api/v2/agents/enrollments/{id}", "delete", "revokeAgentEnrollmentV2", { parameters: [pathId()], responses: { 204: noContent, 400: problem, 401: problem, 409: problem, 500: problem } });
add("/api/v2/agents/register", "post", "registerAgentV2", {
  security: [{ agentBearer: [] }],
  requestBody: { required: true, ...json(ref("AgentRegistrationCommand")) },
  responses: { 200: ok(data(ref("AgentRegistrationResult"))), 201: ok(data(ref("AgentRegistrationResult"))), 400: problem, 401: problem, 503: problem },
});
add("/api/v2/agents/{id}/metrics", "get", "listAgentMetricsV2", { parameters: [pathId(), { name: "hours", in: "query", schema: { type: "string", enum: ["1", "6", "12", "24", "168"], default: "24" } }], responses: { 200: ok(data({ type: "array", items: ref("AgentMetric") })), 400: problem, 401: problem, 404: problem, 500: problem } });
add("/api/v2/agents/{id}/metrics/latest", "get", "getLatestAgentMetricV2", { parameters: [pathId()], responses: { 200: ok(data({ oneOf: [ref("AgentMetric"), { type: "null" }] })), 400: problem, 401: problem, 404: problem, 500: problem } });
add("/api/v2/agents/{id}/credentials", "get", "listAgentCredentialsV2", {
  parameters: [
    pathId(),
    { name: "cursor", in: "query", schema: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
  ],
  responses: { 200: ok(ref("AgentCredentialPage")), 400: problem, 401: problem, 404: problem, 500: problem },
});
add("/api/v2/agents/{id}/credentials", "post", "rotateAgentCredentialV2", { parameters: [pathId()], responses: { 201: ok(data(ref("AgentCredentialIssued"))), 400: problem, 401: problem, 404: problem, 409: problem, 429: problem, 500: problem } });
add("/api/v2/agents/{id}/credentials/{credentialId}", "delete", "revokeAgentCredentialV2", { parameters: [pathId(), { name: "credentialId", in: "path", required: true, schema: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }], responses: { 204: noContent, 400: problem, 401: problem, 404: problem, 409: problem, 500: problem } });
add("/api/v2/agents/{id}", "get", "getAgentV2", { parameters: [pathId()], responses: { 200: ok(data(ref("Agent"))), 400: problem, 401: problem, 404: problem, 500: problem } });
add("/api/v2/agents/{id}", "patch", "updateAgentV2", { parameters: [pathId()], requestBody: { required: true, ...json(ref("AgentUpdate")) }, responses: { 200: ok(data(ref("Agent"))), 400: problem, 401: problem, 404: problem, 409: problem, 500: problem } });
add("/api/v2/agents/{id}", "delete", "deleteAgentV2", { parameters: [pathId()], responses: { 204: noContent, 400: problem, 401: problem, 500: problem } });
add("/api/v2/agents/reports", "post", "acceptAgentReportV4", {
  security: [{ agentBearer: [] }],
  requestBody: { required: true, ...json(ref("AgentReportV4")) },
  responses: { 202: ok(ref("AgentReportAccepted")), 400: problem, 401: problem, 409: problem, 503: problem },
});


add("/api/v2/operations/security-audit", "get", "listSecurityAuditEventsV2", {
  parameters: [
    { name: "cursor", in: "query", schema: { type: "string", maxLength: 512 } },
    { name: "event_type", in: "query", schema: { type: "string", maxLength: 128 } },
    { name: "outcome", in: "query", schema: { type: "string", enum: ["success", "failure", "denied"] } },
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
  ],
  responses: { 200: ok(ref("SecurityAuditPage")), 400: problem, 401: problem, 500: problem },
});
add("/api/v2/operations/credential-coverage", "get", "getCredentialCoverageV2", {
  responses: { 200: ok(data(ref("CredentialCoverage"))), 401: problem, 500: problem },
});

add("/api/v2/status/config", "get", "getStatusConfigV2", { responses: { 200: ok(data(ref("StatusConfigView"))), 401: problem, 500: problem } });
add("/api/v2/status/config", "put", "saveStatusConfigV2", { requestBody: { required: true, ...json(ref("StatusConfigCommand")) }, responses: { 200: ok(data(ref("StatusConfigView"))), 400: problem, 401: problem, 500: problem } });
add("/api/v2/status/public", "get", "getPublicStatusV2", { security: [], responses: { 200: ok(ref("PublicStatus")), 304: noContent, 503: problem, 500: problem } });
add("/api/v2/status/public/agents/{agentId}/metrics", "get", "getPublicAgentMetricsV2", { security: [], parameters: [pathId("agentId")], responses: { 200: ok(ref("PublicAgentMetricsResult")), 304: noContent, 400: problem, 404: problem, 500: problem } });

add("/api/v2/notifications", "get", "getNotificationConfigV2", {
  responses: { 200: ok(data(ref("NotificationConfig"))), 401: problem, 500: problem },
});
add("/api/v2/notifications/channels", "get", "listNotificationChannelsV2", {
  responses: { 200: ok(data({ type: "array", maxItems: 100, items: ref("NotificationChannel") })), 401: problem, 500: problem },
});
add("/api/v2/notifications/channels/{id}", "get", "getNotificationChannelV2", {
  parameters: [pathId()],
  responses: { 200: ok(data(ref("NotificationChannel"))), 400: problem, 401: problem, 404: problem, 500: problem },
});
add("/api/v2/notifications/channels", "post", "createNotificationChannelV2", { requestBody: { required: true, ...json(ref("NotificationChannelCommand")) }, responses: { 201: ok(data(ref("CreatedId"))), 400: problem, 401: problem, 409: problem, 500: problem } });
add("/api/v2/notifications/channels/{id}", "patch", "updateNotificationChannelV2", { parameters: [pathId()], requestBody: { required: true, ...json(ref("NotificationChannelMutation")) }, responses: { 200: ok(data(ref("CreatedId"))), 400: problem, 401: problem, 404: problem, 500: problem } });
add("/api/v2/notifications/channels/{id}", "delete", "deleteNotificationChannelV2", { parameters: [pathId()], responses: { 204: noContent, 400: problem, 401: problem, 500: problem } });
add("/api/v2/notifications/channels/{id}/test", "post", "testNotificationChannelV2", { parameters: [pathId()], responses: { 200: ok(data({ type: "object", required: ["delivered"], properties: { delivered: { type: "boolean" } } })), 400: problem, 401: problem, 404: problem, 500: problem } });
add("/api/v2/notifications/templates", "get", "listNotificationTemplatesV2", { responses: { 200: ok(data({ type: "array", maxItems: 100, items: ref("NotificationTemplate") })), 401: problem, 500: problem } });
add("/api/v2/notifications/templates/{id}", "get", "getNotificationTemplateV2", { parameters: [pathId()], responses: { 200: ok(data(ref("NotificationTemplate"))), 400: problem, 401: problem, 404: problem, 500: problem } });
add("/api/v2/notifications/templates", "post", "createNotificationTemplateV2", { requestBody: { required: true, ...json(ref("NotificationTemplateCommand")) }, responses: { 201: ok(data(ref("CreatedId"))), 400: problem, 401: problem, 409: problem, 500: problem } });
add("/api/v2/notifications/templates/{id}", "patch", "updateNotificationTemplateV2", { parameters: [pathId()], requestBody: { required: true, ...json(ref("NotificationTemplateMutation")) }, responses: { 200: ok(data(ref("CreatedId"))), 400: problem, 401: problem, 404: problem, 500: problem } });
add("/api/v2/notifications/templates/{id}", "delete", "deleteNotificationTemplateV2", { parameters: [pathId()], responses: { 204: noContent, 400: problem, 401: problem, 500: problem } });
add("/api/v2/notifications/resource-settings", "get", "listNotificationResourceSettingsV2", {
  parameters: [
    { name: "target_type", in: "query", required: true, schema: { type: "string", enum: ["monitor", "agent"] } },
    { name: "cursor", in: "query", schema: { type: "string", pattern: "^-?\\d+:\\d+$", maxLength: 64 } },
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 25 } },
  ],
  responses: { 200: ok(ref("NotificationResourceSettingPage")), 400: problem, 401: problem, 500: problem },
});
add("/api/v2/notifications/settings", "put", "saveNotificationSettingV2", { requestBody: { required: true, ...json(ref("NotificationSettingCommand")) }, responses: { 200: ok(data(ref("CreatedId"))), 400: problem, 401: problem, 404: problem, 500: problem } });
add("/api/v2/notifications/settings/bulk", "put", "saveNotificationSettingsBulkV2", {
  parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" } }],
  requestBody: { required: true, ...json(ref("NotificationSettingsBulkCommand")) },
  responses: { 200: ok(data(ref("NotificationSettingsBulkResult"))), 400: problem, 401: problem, 404: problem, 409: problem, 500: problem },
});
add("/api/v2/notifications/history", "get", "listNotificationHistoryV2", {
  parameters: [
    { name: "cursor", in: "query", schema: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
    { name: "type", in: "query", schema: { type: "string", enum: ["monitor", "agent"] } },
    { name: "target_id", in: "query", schema: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
    { name: "status", in: "query", schema: { type: "string", enum: ["success", "failed"] } },
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
  ],
  responses: { 200: ok(ref("NotificationHistoryPage")), 400: problem, 401: problem, 500: problem },
});

const monitorMutationProperties = {
  name: { type: "string", maxLength: 128 },
  url: { type: "string", format: "uri", maxLength: 2048 },
  method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] },
  interval_seconds: { type: "integer", minimum: 1, maximum: 86400 },
  timeout_ms: { type: "integer", minimum: 100, maximum: 300000 },
  expected_status: { type: "integer", minimum: 100, maximum: 599 },
  headers: {
    type: "object",
    maxProperties: 50,
    propertyNames: { type: "string", minLength: 1, maxLength: 128 },
    additionalProperties: { type: "string", maxLength: 8192 },
  },
  body: { type: ["string", "null"], maxLength: 1048576 },
  active: { type: "boolean" },
};
const requiredMonitorMutationFields = [
  "name", "url", "method", "interval_seconds", "timeout_ms",
  "expected_status", "headers",
];
const agentUpdateProperties = {
  name: { type: "string", maxLength: 128 },
  hostname: { type: ["string", "null"], maxLength: 255 },
  ip_addresses: { type: "array", maxItems: 64, items: { type: "string" } },
  os: { type: ["string", "null"], maxLength: 128 },
  version: { type: ["string", "null"], maxLength: 128 },
  status: { type: ["string", "null"], enum: ["active", "inactive", null] },
  collect_interval_seconds: { type: "integer", minimum: 1, maximum: 86400 },
  report_interval_seconds: { type: "integer", minimum: 1, maximum: 86400 },
  group_name: { type: ["string", "null"], maxLength: 64 },
  tags: { type: "array", maxItems: 50, items: { type: "string", maxLength: 64 } },
  auto_update: { type: "boolean" },
  is_hidden: { type: "boolean" },
  price: { type: ["number", "null"], minimum: 0 },
  currency: { type: ["string", "null"], maxLength: 16 },
  billing_cycle: { type: ["string", "null"], enum: ["monthly", "quarterly", "yearly", "once", null] },
  expire_date: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  auto_renewal: { type: "boolean" },
  traffic_limit_gb: { type: ["number", "null"], minimum: 0 },
  traffic_reset_day: { type: "integer", minimum: 1, maximum: 28 },
  traffic_calc_type: { type: "string", enum: ["sum", "rx", "tx"] },
};
const agentMetricProperties = {
  id: { type: "integer" },
  agent_id: { type: "integer" },
  timestamp: { type: "string" },
  cpu_usage: { type: "number" },
  cpu_cores: { type: "integer" },
  cpu_model: { type: "string" },
  memory_total: { type: "number" },
  memory_used: { type: "number" },
  memory_free: { type: "number" },
  memory_usage_rate: { type: "number" },
  load_1: { type: "number" },
  load_5: { type: "number" },
  load_15: { type: "number" },
  disk_metrics: { type: "string" },
  network_metrics: { type: "string" },
  swap_total: { type: ["number", "null"] },
  swap_used: { type: ["number", "null"] },
  process_count: { type: ["integer", "null"] },
  tcp_connections: { type: ["integer", "null"] },
  udp_connections: { type: ["integer", "null"] },
  ping_json: { type: ["string", "null"] },
  ipv4_reachable: { type: ["integer", "null"] },
  ipv6_reachable: { type: ["integer", "null"] },
  network_rx_speed: { type: ["number", "null"] },
  network_tx_speed: { type: ["number", "null"] },
  month_rx: { type: ["number", "null"] },
  month_tx: { type: ["number", "null"] },
};
const publicDiskMetric = {
  type: "object",
  additionalProperties: false,
  required: ["device", "mount_point", "total", "used", "free", "usage_rate", "fs_type"],
  properties: {
    device: { type: "string", maxLength: 512 },
    mount_point: { type: "string", maxLength: 512 },
    total: { type: "number", minimum: 0 },
    used: { type: "number", minimum: 0 },
    free: { type: "number", minimum: 0 },
    usage_rate: { type: "number", minimum: 0, maximum: 100 },
    fs_type: { type: "string", maxLength: 128 },
  },
};
const publicNetworkMetric = {
  type: "object",
  additionalProperties: false,
  required: ["interface", "bytes_sent", "bytes_recv", "packets_sent", "packets_recv"],
  properties: {
    interface: { type: "string", maxLength: 512 },
    bytes_sent: { type: "number", minimum: 0 },
    bytes_recv: { type: "number", minimum: 0 },
    packets_sent: { type: "number", minimum: 0 },
    packets_recv: { type: "number", minimum: 0 },
  },
};
const publicAgentMetricProperties = {
  ...agentMetricProperties,
  id: { oneOf: [{ type: "integer" }, { type: "string" }] },
  disk_metrics: { type: "array", maxItems: 128, items: publicDiskMetric },
  network_metrics: { type: "array", maxItems: 128, items: publicNetworkMetric },
};
const reportDiskMetric = { ...publicDiskMetric, required: [] };
const reportNetworkMetric = { ...publicNetworkMetric, required: [] };
const reportPingMap = {
  type: "object",
  maxProperties: 128,
  additionalProperties: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      target: { type: "string", maxLength: 512 },
      latency_ms: { type: "number", minimum: -1, maximum: Number.MAX_SAFE_INTEGER },
      loss: { type: "boolean" },
    },
  },
};
const agentReportSampleProperties = {
  collected_at: { type: "string", format: "date-time" },
  cpu: {
    type: "object",
    additionalProperties: false,
    properties: {
      usage: { type: "number", minimum: 0, maximum: 100 },
      cores: { type: "integer", minimum: 1, maximum: 4096 },
      model_name: { type: "string", maxLength: 512 },
    },
  },
  memory: {
    type: "object",
    additionalProperties: false,
    properties: {
      total: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      used: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      free: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      usage_rate: { type: "number", minimum: 0, maximum: 100 },
    },
  },
  load: {
    type: "object",
    additionalProperties: false,
    properties: {
      load1: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      load5: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      load15: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    },
  },
  disks: { type: "array", maxItems: 128, items: reportDiskMetric },
  network: { type: "array", maxItems: 128, items: reportNetworkMetric },
  swap: {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          total: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          used: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          usage_rate: { type: "number", minimum: 0, maximum: 100 },
        },
      },
      { type: "null" },
    ],
  },
  process_count: { type: "integer", minimum: 0, maximum: 10000000 },
  tcp_connections: { type: "integer", minimum: 0, maximum: 10000000 },
  udp_connections: { type: "integer", minimum: 0, maximum: 10000000 },
  ping: reportPingMap,
  ipv4_reachable: { type: ["boolean", "null"] },
  ipv6_reachable: { type: ["boolean", "null"] },
};

const schemas: Record<string, Schema> = {
  ApiProblem: {
    type: "object",
    required: ["type", "title", "status", "code", "trace_id"],
    properties: {
      type: { type: "string", format: "uri" }, title: { type: "string" }, status: { type: "integer" },
      code: { type: "string" }, trace_id: { type: "string" }, detail: { type: "string" },
      errors: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
    },
  },
  LoginCommand: { type: "object", additionalProperties: false, required: ["username", "password"], properties: { username: { type: "string", minLength: 1, maxLength: 64 }, password: { type: "string", minLength: 1, maxLength: 256 } } },
  AdminProfile: { type: "object", required: ["id", "username"], properties: { id: { type: "integer" }, username: { type: "string" }, email: { type: ["string", "null"] }, created_at: { type: "string" }, updated_at: { type: "string" } } },
  SessionResult: { type: "object", required: ["success", "message"], properties: { success: { type: "boolean" }, message: { type: "string" }, user: ref("AdminProfile") } },
  AdminProfileUpdate: { type: "object", additionalProperties: false, minProperties: 1, properties: { username: { type: "string", minLength: 1, maxLength: 64 }, email: { type: ["string", "null"], maxLength: 254 } } },
  AdminPasswordChange: { type: "object", additionalProperties: false, required: ["currentPassword", "newPassword"], properties: { currentPassword: { type: "string", minLength: 1, maxLength: 256 }, newPassword: { type: "string", minLength: 6, maxLength: 256 } } },
  DashboardData: {
    type: "object",
    required: [
      "monitors",
      "agents",
      "summary",
      "monitors_has_more",
      "agents_has_more",
    ],
    properties: {
      monitors: { type: "array", maxItems: 200, items: ref("DashboardMonitor") },
      agents: { type: "array", maxItems: 200, items: ref("DashboardAgent") },
      summary: ref("DashboardSummary"),
      monitors_has_more: { type: "boolean" },
      agents_has_more: { type: "boolean" },
    },
  },
  DashboardSummary: {
    type: "object",
    required: [
      "monitors_total",
      "monitors_up",
      "monitors_down",
      "monitors_pending",
      "monitors_avg_response_time_ms",
      "agents_total",
      "agents_online",
      "agents_offline",
      "total_traffic_bytes",
      "network_rx_speed_bps",
      "network_tx_speed_bps",
    ],
    properties: {
      monitors_total: { type: "integer", minimum: 0 },
      monitors_up: { type: "integer", minimum: 0 },
      monitors_down: { type: "integer", minimum: 0 },
      monitors_pending: { type: "integer", minimum: 0 },
      monitors_avg_response_time_ms: { type: ["number", "null"], minimum: 0 },
      agents_total: { type: "integer", minimum: 0 },
      agents_online: { type: "integer", minimum: 0 },
      agents_offline: { type: "integer", minimum: 0 },
      total_traffic_bytes: { type: ["number", "null"], minimum: 0 },
      network_rx_speed_bps: { type: ["number", "null"], minimum: 0 },
      network_tx_speed_bps: { type: ["number", "null"], minimum: 0 },
    },
  },
  DashboardMonitor: { type: "object", required: ["id", "name", "url", "method", "interval", "timeout", "status", "created_at", "updated_at"], properties: { id: { type: "integer" }, name: { type: "string" }, url: { type: "string" }, method: { type: "string" }, interval: { type: "integer" }, timeout: { type: "integer" }, timeout_ms: { type: "integer" }, expected_status: { type: "integer" }, headers: { oneOf: [{ type: "object", additionalProperties: { type: "string" } }, { type: "string" }, { type: "null" }] }, body: { type: ["string", "null"] }, active: { type: "integer" }, status: { type: "string", enum: ["up", "down", "pending", "unknown", "error"] }, response_time: { type: ["number", "null"] }, last_checked: { type: ["string", "null"] }, next_check_at: { type: ["string", "null"] }, created_at: { type: "string" }, updated_at: { type: "string" } } },
  DashboardAgent: { type: "object", required: ["id", "name", "status", "created_at", "updated_at"], properties: { id: { type: "integer" }, name: { type: "string" }, status: { type: "string", enum: ["active", "inactive", "connecting", "unknown"] }, hostname: { type: ["string", "null"] }, ip_addresses: { type: ["string", "null"] }, os: { type: ["string", "null"] }, version: { type: ["string", "null"] }, created_at: { type: "string" }, updated_at: { type: "string" }, last_seen_at: { type: ["string", "null"] }, last_state_changed_at: { type: ["string", "null"] }, next_offline_at: { type: ["string", "null"] }, collect_interval: { type: ["integer", "null"] }, report_interval: { type: ["integer", "null"] }, region: { type: ["string", "null"] }, geo_latitude: { type: ["number", "null"] }, geo_longitude: { type: ["number", "null"] }, geo_city: { type: ["string", "null"] }, geo_region_name: { type: ["string", "null"] }, boot_time: { type: ["integer", "null"] }, price: { type: ["number", "null"] }, currency: { type: ["string", "null"] }, billing_cycle: { type: ["string", "null"], enum: ["monthly", "quarterly", "yearly", "once", null] }, expire_date: { type: ["string", "null"] }, auto_renewal: { type: ["integer", "null"] }, is_hidden: { type: ["integer", "null"] }, traffic_limit_gb: { type: ["number", "null"] }, traffic_reset_day: { type: ["integer", "null"] }, traffic_calc_type: { type: ["string", "null"], enum: ["sum", "rx", "tx", null] }, auto_update: { type: ["integer", "null"] }, group_name: { type: ["string", "null"] }, tags: { type: ["string", "null"] }, sort_order: { type: ["integer", "null"] }, metrics: { oneOf: [ref("AgentMetric"), { type: "null" }] } } },
  PublicAgentMetricsResult: { type: "object", required: ["success", "agent"], properties: { success: { type: "boolean" }, agent: { type: "array", items: ref("PublicAgentMetric") }, message: { type: "string" } } },
  CreatedId: { type: "object", properties: { id: { type: "integer" } } },
  MonitorMutation: { type: "object", additionalProperties: false, required: requiredMonitorMutationFields, properties: monitorMutationProperties },
  MonitorUpdate: { type: "object", additionalProperties: false, minProperties: 1, properties: monitorMutationProperties },
  Monitor: { type: "object", required: ["id", "name", "url", "method", "interval_seconds", "timeout_ms", "expected_status", "headers", "body", "active", "status", "response_time_ms", "last_checked_at", "next_check_at", "sort_order", "created_at", "updated_at"], properties: { id: { type: "integer" }, name: { type: "string" }, url: { type: "string", format: "uri" }, method: { type: "string" }, interval_seconds: { type: "integer" }, timeout_ms: { type: "integer" }, expected_status: { type: "integer" }, headers: { type: "object", additionalProperties: { type: "string" } }, body: { type: ["string", "null"] }, active: { type: "boolean" }, status: { type: ["string", "null"] }, response_time_ms: { type: ["integer", "null"] }, last_checked_at: { type: ["string", "null"] }, next_check_at: { type: ["string", "null"] }, sort_order: { type: "integer" }, created_at: { type: "string" }, updated_at: { type: "string" } } },
  MonitorPage: { type: "object", required: ["data", "next_cursor", "has_more"], properties: { data: { type: "array", items: ref("Monitor") }, next_cursor: { type: ["string", "null"] }, has_more: { type: "boolean" } } },
  MonitorHistory: { type: "object", required: ["id", "monitor_id", "status"], properties: { id: { type: ["integer", "string"] }, monitor_id: { type: "integer" }, status: { type: "string" }, response_time: { type: ["number", "null"] }, timestamp: { type: ["string", "null"] }, status_code: { type: ["integer", "null"] }, error: { type: ["string", "null"] } } },
  MonitorDailyStats: { type: "object", required: ["monitor_id", "date", "total_checks", "up_checks", "down_checks", "avg_response_time", "min_response_time", "max_response_time", "availability", "created_at"], properties: { monitor_id: { type: "integer" }, date: { type: "string" }, total_checks: { type: "integer" }, up_checks: { type: "integer" }, down_checks: { type: "integer" }, avg_response_time: { type: "number" }, min_response_time: { type: "number" }, max_response_time: { type: "number" }, availability: { type: "number" }, created_at: { type: "string" } } },
  MonitorOrderCommand: { type: "object", additionalProperties: false, required: ["ids"], properties: { ids: { type: "array", minItems: 1, maxItems: 1000, items: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } } },
  MonitorExportItem: { type: "object", additionalProperties: false, required: [...requiredMonitorMutationFields, "sort_order"], properties: { ...monitorMutationProperties, sort_order: { type: "integer", minimum: 0 } } },
  MonitorImportItem: { type: "object", additionalProperties: false, required: requiredMonitorMutationFields, properties: { ...monitorMutationProperties, sort_order: { type: "integer", minimum: 0 } } },
  ImportResult: { type: "object", required: ["created", "skipped"], properties: { created: { type: "integer" }, skipped: { type: "integer" } } },
  MonitorCheckAccepted: { type: "object", required: ["job_id", "status"], properties: { job_id: { type: "string" }, status: { const: "pending" } } },
  AgentUpdate: { type: "object", additionalProperties: false, minProperties: 1, properties: agentUpdateProperties },
  Agent: { type: "object", required: ["id", "name", "status", "hostname", "ip_addresses", "os", "version", "keepalive", "boot_time", "collect_interval_seconds", "report_interval_seconds", "last_seen_at", "next_offline_at", "group_name", "tags", "price", "currency", "billing_cycle", "expire_date", "auto_renewal", "is_hidden", "traffic_limit_gb", "traffic_reset_day", "traffic_calc_type", "auto_update", "region", "geo_latitude", "geo_longitude", "geo_city", "geo_region_name", "sort_order", "created_at", "updated_at"], properties: { id: { type: "integer" }, ...agentUpdateProperties, name: { type: "string" }, status: { type: "string" }, hostname: { type: ["string", "null"] }, ip_addresses: { type: "array", items: { type: "string" } }, os: { type: ["string", "null"] }, version: { type: ["string", "null"] }, keepalive: { type: ["string", "null"] }, boot_time: { type: ["integer", "null"] }, collect_interval_seconds: { type: "integer" }, report_interval_seconds: { type: "integer" }, last_seen_at: { type: ["string", "null"] }, next_offline_at: { type: ["string", "null"] }, group_name: { type: ["string", "null"] }, tags: { type: "array", items: { type: "string" } }, price: { type: ["number", "null"] }, currency: { type: ["string", "null"] }, billing_cycle: { type: ["string", "null"] }, expire_date: { type: ["string", "null"] }, auto_renewal: { type: "boolean" }, is_hidden: { type: "boolean" }, traffic_limit_gb: { type: ["number", "null"] }, traffic_reset_day: { type: "integer" }, traffic_calc_type: { type: "string" }, auto_update: { type: "boolean" }, region: { type: ["string", "null"] }, geo_latitude: { type: ["number", "null"] }, geo_longitude: { type: ["number", "null"] }, geo_city: { type: ["string", "null"] }, geo_region_name: { type: ["string", "null"] }, sort_order: { type: "integer" }, created_at: { type: "string" }, updated_at: { type: "string" }, metrics: { oneOf: [ref("AgentMetric"), { type: "null" }] } } },
  AgentPage: { type: "object", required: ["data", "next_cursor", "has_more"], properties: { data: { type: "array", items: ref("Agent") }, next_cursor: { type: ["string", "null"] }, has_more: { type: "boolean" } } },
  AgentMetric: { type: "object", required: ["agent_id", "timestamp"], properties: agentMetricProperties },
  PublicAgentMetric: { type: "object", required: ["id", "agent_id", "timestamp", "disk_metrics", "network_metrics"], properties: publicAgentMetricProperties },
  AgentOrderCommand: { type: "object", additionalProperties: false, required: ["ids"], properties: { ids: { type: "array", minItems: 1, maxItems: 1000, items: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } } },
  AgentExportItem: { type: "object", additionalProperties: false, required: ["name"], properties: { ...agentUpdateProperties, name: { type: "string" }, sort_order: { type: "integer", minimum: 0 } } },
  AgentImportItem: { type: "object", additionalProperties: false, required: ["name"], properties: { ...agentUpdateProperties, name: { type: "string" }, sort_order: { type: "integer", minimum: 0 } } },
  IssuedAgentCredential: { type: "object", required: ["name", "token"], properties: { name: { type: "string" }, token: { type: "string" } } },
  AgentImportResult: { type: "object", required: ["created", "skipped", "issuedCredentials"], properties: { created: { type: "integer" }, skipped: { type: "integer" }, issuedCredentials: { type: "array", items: ref("IssuedAgentCredential") } } },
  AgentEnrollmentIssued: { type: "object", required: ["token", "expires_at"], properties: { token: { type: "string" }, expires_at: { type: "string" } } },
  AgentEnrollment: { type: "object", required: ["id", "agent_id", "expires_at", "used_at", "revoked_at", "created_at"], properties: { id: { type: "integer" }, agent_id: { type: ["integer", "null"] }, expires_at: { type: "string" }, used_at: { type: ["string", "null"] }, revoked_at: { type: ["string", "null"] }, created_at: { type: "string" } } },
  AgentCredential: { type: "object", required: ["id", "agent_id", "token_hint", "last_used_at", "revoked_at", "created_at"], properties: { id: { type: "integer" }, agent_id: { type: "integer" }, token_hint: { type: "string" }, last_used_at: { type: ["string", "null"] }, revoked_at: { type: ["string", "null"] }, created_at: { type: "string" } } },
  AgentCredentialPage: { type: "object", required: ["data", "next_cursor", "has_more"], properties: { data: { type: "array", maxItems: 100, items: ref("AgentCredential") }, next_cursor: { type: ["string", "null"] }, has_more: { type: "boolean" } } },
  AgentCredentialIssued: { type: "object", required: ["token"], properties: { token: { type: "string" } } },
  AgentRegistrationCommand: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, hostname: { type: ["string", "null"], maxLength: 255 }, ip_addresses: { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 128 } }, os: { type: ["string", "null"], maxLength: 128 }, version: { type: ["string", "null"], maxLength: 128 } } },
  AgentRegistrationResult: { type: "object", required: ["agent_id", "created"], properties: { agent_id: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, created: { type: "boolean" } } },
  AgentReportSample: {
    type: "object",
    additionalProperties: false,
    required: ["collected_at"],
    properties: agentReportSampleProperties,
  },
  AgentReportV4: {
    type: "object",
    additionalProperties: false,
    required: ["protocol_version", "report_id", "samples"],
    properties: {
      protocol_version: { const: 4 },
      agent_version: { type: "string", minLength: 1, maxLength: 128 },
      report_id: { type: "string", format: "uuid" },
      hostname: { type: ["string", "null"], maxLength: 255 },
      ip_addresses: {
        type: "array",
        maxItems: 64,
        items: { type: "string", minLength: 1, maxLength: 128 },
      },
      os: { type: ["string", "null"], maxLength: 128 },
      version: { type: ["string", "null"], maxLength: 128 },
      boot_time: { type: ["integer", "null"], minimum: 0 },
      keepalive_seconds: { type: "integer", minimum: 1, maximum: 86400 },
      report_interval_seconds: { type: "integer", minimum: 1, maximum: 86400 },
      samples: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: ref("AgentReportSample"),
      },
    },
  },
  AgentReportAccepted: { type: "object", required: ["report_id", "accepted", "duplicate", "config"], properties: { report_id: { type: "string", format: "uuid" }, accepted: { type: "boolean" }, duplicate: { type: "boolean" }, config: { type: "object", required: ["collect_interval_seconds", "report_interval_seconds", "update"], properties: { collect_interval_seconds: { type: "integer" }, report_interval_seconds: { type: "integer" }, update: { type: "boolean" } } } } },
  QueueFailure: { type: "object", required: ["failure_id", "queue_name", "message_id", "delivery_attempts", "status", "replay_count", "created_at", "updated_at"], properties: { failure_id: { type: "string" }, queue_name: { type: "string" }, message_id: { type: "string" }, source_kind: { type: ["string", "null"] }, source_id: { type: ["string", "null"] }, delivery_attempts: { type: "integer" }, last_error: { type: ["string", "null"] }, status: { type: "string", enum: ["open", "replayed", "terminated"] }, replay_count: { type: "integer" }, replayed_at: { type: ["string", "null"], format: "date-time" }, terminated_at: { type: ["string", "null"], format: "date-time" }, created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" } } },
  QueueFailurePage: { type: "object", required: ["data", "next_cursor", "has_more"], properties: { data: { type: "array", items: ref("QueueFailure") }, next_cursor: { type: ["string", "null"] }, has_more: { type: "boolean" } } },
  QueueReplayResult: { type: "object", required: ["failure_id", "status"], properties: { failure_id: { type: "string" }, status: { const: "replayed" } } },
  QueueLedgerHealth: { type: "object", required: ["generated_at", "jobs", "outbox", "notifications", "open_failures", "oldest_job_available_at", "oldest_outbox_available_at", "job_lag_seconds", "outbox_lag_seconds"], properties: { generated_at: { type: "string", format: "date-time" }, jobs: { type: "object", additionalProperties: { type: "integer" } }, outbox: { type: "object", additionalProperties: { type: "integer" } }, notifications: { type: "object", additionalProperties: { type: "integer" } }, open_failures: { type: "integer" }, oldest_job_available_at: { type: ["string", "null"] }, oldest_outbox_available_at: { type: ["string", "null"] }, job_lag_seconds: { type: "integer" }, outbox_lag_seconds: { type: "integer" } } },

  SecurityAuditEvent: { type: "object", required: ["id", "event_type", "outcome", "actor_type", "metadata_json", "created_at", "updated_at"], properties: { id: { type: "string" }, event_type: { type: "string" }, outcome: { type: "string", enum: ["success", "failure", "denied"] }, actor_type: { type: "string" }, actor_id: { type: ["string", "null"] }, subject_type: { type: ["string", "null"] }, subject_id: { type: ["string", "null"] }, request_id: { type: ["string", "null"] }, ip_digest: { type: ["string", "null"] }, metadata_json: { type: "string" }, created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" } } },
  SecurityAuditPage: { type: "object", required: ["data", "next_cursor", "has_more"], properties: { data: { type: "array", items: ref("SecurityAuditEvent") }, next_cursor: { type: ["string", "null"] }, has_more: { type: "boolean" } } },
  AgentCredentialCoverage: {
    type: "object",
    additionalProperties: false,
    required: ["total", "covered", "ready"],
    properties: {
      total: { type: "integer", minimum: 0 },
      covered: { type: "integer", minimum: 0 },
      ready: { type: "boolean" },
    },
  },
  NotificationSecretCoverage: {
    type: "object",
    additionalProperties: false,
    required: [
      "total",
      "endpointCovered",
      "encryptedSecretRows",
      "currentKeyRows",
      "ready",
    ],
    properties: {
      total: { type: "integer", minimum: 0 },
      endpointCovered: { type: "integer", minimum: 0 },
      encryptedSecretRows: { type: "integer", minimum: 0 },
      currentKeyRows: { type: "integer", minimum: 0 },
      ready: { type: "boolean" },
    },
  },
  CredentialCoverage: {
    type: "object",
    additionalProperties: false,
    required: [
      "agent_credentials",
      "notification_secrets",
      "ready_for_credential_contract",
    ],
    properties: {
      agent_credentials: ref("AgentCredentialCoverage"),
      notification_secrets: ref("NotificationSecretCoverage"),
      ready_for_credential_contract: { type: "boolean" },
    },
  },
  MigrationCheckpoint: { type: "object", required: ["migration_key", "phase", "status", "rows_read", "rows_written", "rows_skipped", "anomaly_rows", "created_at", "updated_at"], properties: { migration_key: { type: "string" }, phase: { type: "string" }, status: { type: "string", enum: ["pending", "running", "completed", "completed_with_anomalies", "failed"] }, last_pk: { type: ["string", "null"] }, rows_read: { type: "integer" }, rows_written: { type: "integer" }, rows_skipped: { type: "integer" }, anomaly_rows: { type: "integer" }, checksum: { type: ["string", "null"] }, last_error: { type: ["string", "null"] }, started_at: { type: ["string", "null"] }, lease_expires_at: { type: ["string", "null"] }, completed_at: { type: ["string", "null"] }, created_at: { type: "string" }, updated_at: { type: "string" } } },
  MigrationAnomaly: { type: "object", required: ["id", "migration_key", "source_table", "source_pk", "error_code", "raw_value_json", "status", "first_seen_at", "created_at", "updated_at"], properties: { id: { type: "integer" }, migration_key: { type: "string" }, source_table: { type: "string" }, source_pk: { type: "string" }, error_code: { type: "string" }, raw_value_json: { type: "string" }, status: { type: "string", enum: ["open", "retry_requested", "resolved", "ignored"] }, resolution_note: { type: ["string", "null"] }, first_seen_at: { type: "string" }, resolved_at: { type: ["string", "null"] }, created_at: { type: "string" }, updated_at: { type: "string" } } },
  MigrationAnomalyPage: { type: "object", required: ["data", "next_cursor", "has_more"], properties: { data: { type: "array", items: ref("MigrationAnomaly") }, next_cursor: { type: ["integer", "null"] }, has_more: { type: "boolean" } } },
  MigrationAnomalyAction: { type: "object", additionalProperties: false, required: ["action"], properties: { action: { type: "string", enum: ["retry", "ignore"] }, note: { type: ["string", "null"], maxLength: 1000 } } },
  MigrationAnomalyActionResult: { type: "object", required: ["id", "action"], properties: { id: { type: "integer" }, action: { type: "string", enum: ["retry", "ignore"] } } },
  StatusConfigCommand: { type: "object", additionalProperties: false, required: ["title", "description", "logoUrl", "customCss", "theme", "monitors", "agents"], properties: { title: { type: "string", maxLength: 120 }, description: { type: "string", maxLength: 500 }, logoUrl: { type: "string", maxLength: 2048 }, customCss: { type: "string", maxLength: 20000 }, theme: { type: "string" }, monitors: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "integer" } }, agents: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "integer" } } } },
  StatusConfigView: { type: "object", required: ["title", "description", "logoUrl", "customCss", "theme", "monitors", "agents", "monitors_has_more", "agents_has_more"], properties: { title: { type: "string" }, description: { type: "string" }, logoUrl: { type: "string" }, customCss: { type: "string" }, theme: { type: "string" }, monitors: { type: "array", maxItems: 500, items: { type: "object", required: ["id", "name", "selected"], properties: { id: { type: "integer" }, name: { type: "string" }, selected: { type: "boolean" } } } }, agents: { type: "array", maxItems: 500, items: { type: "object", required: ["id", "name", "selected"], properties: { id: { type: "integer" }, name: { type: "string" }, selected: { type: "boolean" } } } }, monitors_has_more: { type: "boolean" }, agents_has_more: { type: "boolean" } } },
  PublicMonitor: { type: "object", required: ["id", "name", "status", "response_time", "last_checked", "created_at", "updated_at", "dailyStats", "history"], properties: { id: { type: "integer" }, name: { type: "string" }, status: { type: "string", enum: ["up", "down", "pending", "unknown", "error"] }, response_time: { type: "number" }, last_checked: { type: ["string", "null"] }, created_at: { type: "string" }, updated_at: { type: "string" }, dailyStats: { type: "array", items: ref("MonitorDailyStats") }, history: { type: "array", items: ref("MonitorHistory") } } },
  PublicAgent: { type: "object", required: ["id", "name", "status", "created_at", "updated_at", "metrics"], properties: { id: { type: "integer" }, name: { type: "string" }, status: { type: "string", enum: ["active", "inactive", "connecting", "unknown"] }, hostname: { type: ["string", "null"] }, os: { type: ["string", "null"] }, version: { type: ["string", "null"] }, region: { type: ["string", "null"] }, created_at: { type: "string" }, updated_at: { type: "string" }, traffic_limit_gb: { type: ["number", "null"] }, traffic_reset_day: { type: ["integer", "null"] }, traffic_calc_type: { type: ["string", "null"], enum: ["sum", "rx", "tx", null] }, metrics: { oneOf: [ref("PublicAgentMetric"), { type: "null" }] } } },
  PublicStatus: { type: "object", required: ["title", "description", "logoUrl", "customCss", "theme", "monitors", "agents"], properties: { title: { type: "string" }, description: { type: "string" }, logoUrl: { type: "string" }, customCss: { type: "string" }, theme: { type: "string" }, monitors: { type: "array", items: ref("PublicMonitor") }, agents: { type: "array", items: ref("PublicAgent") } } },
  NotificationChannelCommand: { type: "object", additionalProperties: false, required: ["name", "type", "config", "enabled"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, type: { type: "string", enum: ["telegram", "resend", "feishu", "wecom", "dingtalk", "bark", "serverchan", "wxpusher", "gotify", "onebot"] }, config: { type: "object", additionalProperties: true }, enabled: { type: "boolean" } } },
  NotificationChannelMutation: { type: "object", additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 128 }, type: { type: "string", enum: ["telegram", "resend", "feishu", "wecom", "dingtalk", "bark", "serverchan", "wxpusher", "gotify", "onebot"] }, config: { type: "object", additionalProperties: true }, enabled: { type: "boolean" } } },
  NotificationChannel: { type: "object", required: ["id", "name", "type", "config", "enabled"], properties: { id: { type: "integer" }, name: { type: "string" }, type: { type: "string" }, config: { type: "string" }, enabled: { type: "boolean" }, created_at: { type: ["string", "null"] }, updated_at: { type: ["string", "null"] } } },
  NotificationTemplateCommand: { type: "object", additionalProperties: false, required: ["name", "type", "subject", "content", "is_default"], properties: { name: { type: "string" }, type: { type: "string", enum: ["monitor", "agent"] }, subject: { type: "string" }, content: { type: "string" }, is_default: { type: "boolean" } } },
  NotificationTemplateMutation: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, type: { type: "string", enum: ["monitor", "agent"] }, subject: { type: "string" }, content: { type: "string" }, is_default: { type: "boolean" } } },
  NotificationTemplate: { type: "object", required: ["id", "name", "type", "subject", "content", "is_default"], properties: { id: { type: "integer" }, name: { type: "string" }, type: { type: "string", enum: ["monitor", "agent"] }, subject: { type: "string" }, content: { type: "string" }, is_default: { type: "boolean" }, created_at: { type: ["string", "null"] }, updated_at: { type: ["string", "null"] } } },
  NotificationSettingCommand: { type: "object", additionalProperties: false, required: ["target_type", "enabled", "channels"], properties: { target_type: { type: "string", enum: ["global-monitor", "global-agent", "monitor", "agent"] }, target_id: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, enabled: { type: "boolean" }, on_down: { type: "boolean" }, on_recovery: { type: "boolean" }, on_offline: { type: "boolean" }, on_cpu_threshold: { type: "boolean" }, cpu_threshold: { type: "number", minimum: 0, maximum: 100 }, on_memory_threshold: { type: "boolean" }, memory_threshold: { type: "number", minimum: 0, maximum: 100 }, on_disk_threshold: { type: "boolean" }, disk_threshold: { type: "number", minimum: 0, maximum: 100 }, cooldown_minutes: { type: "integer", minimum: 0, maximum: 1440 }, channels: { type: "array", maxItems: 100, items: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } } },
  NotificationSettingsBulkCommand: { type: "object", additionalProperties: false, required: ["settings"], properties: { settings: { type: "array", minItems: 1, maxItems: 100, items: ref("NotificationSettingCommand") } } },
  NotificationSettingsBulkResult: { type: "object", additionalProperties: false, required: ["ids", "replayed"], properties: { ids: { type: "array", maxItems: 100, items: { type: "integer" } }, replayed: { type: "boolean" } } },
  NotificationMonitorSetting: { type: "object", required: ["enabled", "onDown", "onRecovery", "cooldownMinutes", "channels"], properties: { enabled: { type: "boolean" }, onDown: { type: "boolean" }, onRecovery: { type: "boolean" }, cooldownMinutes: { type: "integer" }, channels: { type: "array", items: { type: "integer" } } } },
  NotificationAgentSetting: { type: "object", required: ["enabled", "onOffline", "onRecovery", "onCpuThreshold", "cpuThreshold", "onMemoryThreshold", "memoryThreshold", "onDiskThreshold", "diskThreshold", "cooldownMinutes", "channels"], properties: { enabled: { type: "boolean" }, onOffline: { type: "boolean" }, onRecovery: { type: "boolean" }, onCpuThreshold: { type: "boolean" }, cpuThreshold: { type: "number" }, onMemoryThreshold: { type: "boolean" }, memoryThreshold: { type: "number" }, onDiskThreshold: { type: "boolean" }, diskThreshold: { type: "number" }, cooldownMinutes: { type: "integer" }, channels: { type: "array", items: { type: "integer" } } } },
  NotificationResourceSetting: { type: "object", additionalProperties: false, required: ["target_type", "id", "name", "description", "sort_order", "setting"], properties: { target_type: { type: "string", enum: ["monitor", "agent"] }, id: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, name: { type: "string" }, description: { type: ["string", "null"] }, sort_order: { type: "integer" }, setting: { oneOf: [ref("NotificationMonitorSetting"), ref("NotificationAgentSetting"), { type: "null" }] } } },
  NotificationResourceSettingPage: { type: "object", required: ["data", "next_cursor", "has_more"], properties: { data: { type: "array", maxItems: 50, items: ref("NotificationResourceSetting") }, next_cursor: { type: ["string", "null"] }, has_more: { type: "boolean" } } },
  NotificationConfig: { type: "object", required: ["channels", "templates", "channels_has_more", "templates_has_more", "settings"], properties: { channels: { type: "array", maxItems: 100, items: ref("NotificationChannel") }, templates: { type: "array", maxItems: 100, items: ref("NotificationTemplate") }, channels_has_more: { type: "boolean" }, templates_has_more: { type: "boolean" }, settings: { type: "object", required: ["monitors", "agents", "specificMonitors", "specificAgents"], properties: { monitors: ref("NotificationMonitorSetting"), agents: ref("NotificationAgentSetting"), specificMonitors: { type: "object", additionalProperties: ref("NotificationMonitorSetting") }, specificAgents: { type: "object", additionalProperties: ref("NotificationAgentSetting") } } } } },
  NotificationHistory: { type: "object", required: ["id", "type", "channel_id", "template_id", "status", "content"], properties: { id: { type: "integer" }, type: { type: "string" }, target_id: { type: ["integer", "null"] }, channel_id: { type: "integer" }, template_id: { type: "integer" }, status: { type: "string" }, content: { type: "string" }, error: { type: ["string", "null"] }, sent_at: { type: ["string", "null"] } } },
  NotificationHistoryPage: { type: "object", required: ["data", "next_cursor", "has_more"], properties: { data: { type: "array", items: ref("NotificationHistory") }, next_cursor: { type: ["integer", "null"] }, has_more: { type: "boolean" } } },
};

const spec = {
  openapi: "3.1.0",
  info: { title: "XUGOU v2 API", version: "2.0.0", description: "Single-Worker modular-monolith API contract." },
  servers: [{ url: "/" }],
  security: [{ sessionCookie: [] }],
  paths,
  components: {
    securitySchemes: {
      sessionCookie: { type: "apiKey", in: "cookie", name: "xugou_session" },
      releaseToken: { type: "http", scheme: "bearer", bearerFormat: "opaque release credential" },
      agentBearer: { type: "http", scheme: "bearer" },
    },
    schemas,
  },
};

const routeFiles = [
  ["monitors", "monitorsV2"], ["agents", "agentsV2"],
  ["operations", "operationsV2"], ["status", "statusV2"],
  ["notifications", "notificationsV2"],
] as const;
const implemented = new Set<string>();
for (const [moduleName, variable] of routeFiles) {
  const source = await readFile(path.join(backendDir, `src/modules/${moduleName}/http/routes.ts`), "utf8");
  const expression = new RegExp(`${variable}\\.(get|post|put|patch|delete)\\(\"([^\"]+)\"`, "g");
  for (const match of source.matchAll(expression)) {
    const suffix = match[2] === "/" ? "" : match[2];
    const route = `/api/v2/${moduleName}${suffix}`.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    implemented.add(`${match[1]} ${route}`);
  }
}
for (const route of [
  "post /api/v2/session/login",
  "get /api/v2/session/me",
  "post /api/v2/session/logout",
  "put /api/v2/profile",
  "post /api/v2/profile/change-password",
  "get /api/v2/dashboard",
]) {
  implemented.add(route);
}
const documented = new Set(
  Object.entries(paths).flatMap(([route, operations]) =>
    Object.keys(operations).map((method) => `${method} ${route}`)
  )
);
const missing = [...implemented].filter((route) => !documented.has(route));
const stale = [...documented].filter((route) => !implemented.has(route));
if (missing.length > 0 || stale.length > 0) {
  throw new Error(`OpenAPI route inventory mismatch\nmissing=${missing.join(",")}\nstale=${stale.join(",")}`);
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
console.log(`Generated ${path.relative(process.cwd(), outputPath)} (${implemented.size} operations)`);
