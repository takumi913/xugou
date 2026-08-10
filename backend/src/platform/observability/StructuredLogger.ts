export const INTERNAL_TRACE_HEADER = "X-Xugou-Trace-ID";
export const RESPONSE_TRACE_HEADER = "X-Trace-ID";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogResult = "success" | "failure" | "deferred" | "rejected";

export interface StructuredLogInput {
  level?: LogLevel;
  service:
    | "http"
    | "cron"
    | "queue"
    | "migration"
    | "notification"
    | "realtime"
    | "archive"
    | "status";
  operation: string;
  result: LogResult;
  traceId?: string;
  eventId?: string;
  reportId?: string;
  jobId?: string;
  entityType?: string;
  entityId?: string | number;
  durationMs?: number;
  errorCode?: string;
  error?: unknown;
  fields?: Record<string, unknown>;
}

function validTraceCandidate(value: string | null) {
  const candidate = value?.trim();
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : null;
}

export function createTraceId(headers?: Headers) {
  return (
    validTraceCandidate(headers?.get(INTERNAL_TRACE_HEADER) ?? null) ??
    validTraceCandidate(headers?.get("CF-Ray") ?? null) ??
    validTraceCandidate(headers?.get("X-Request-ID") ?? null) ??
    crypto.randomUUID()
  );
}

function errorFields(error: unknown) {
  if (error instanceof Error) {
    return { error_name: error.name, error_message: error.message.slice(0, 2048) };
  }
  return error === undefined
    ? {}
    : { error_name: "UnknownError", error_message: String(error).slice(0, 2048) };
}

function releaseVersion(env: unknown) {
  if (!env || typeof env !== "object") return "local";
  const metadata = (env as { CF_VERSION_METADATA?: unknown }).CF_VERSION_METADATA;
  if (!metadata || typeof metadata !== "object") return "local";
  const id = (metadata as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : "local";
}

export function writeStructuredLog(
  env: unknown,
  input: StructuredLogInput
) {
  const level = input.level ?? (input.result === "failure" ? "error" : "info");
  const record = {
    timestamp: new Date().toISOString(),
    level,
    trace_id: input.traceId ?? crypto.randomUUID(),
    service: input.service,
    operation: input.operation,
    result: input.result,
    schema_version: "v2",
    release_version: releaseVersion(env),
    ...(input.eventId ? { event_id: input.eventId } : {}),
    ...(input.reportId ? { report_id: input.reportId } : {}),
    ...(input.jobId ? { job_id: input.jobId } : {}),
    ...(input.entityType ? { entity_type: input.entityType } : {}),
    ...(input.entityId !== undefined ? { entity_id: input.entityId } : {}),
    ...(input.durationMs !== undefined
      ? { duration_ms: Math.max(0, Math.round(input.durationMs * 100) / 100) }
      : {}),
    ...(input.errorCode ? { error_code: input.errorCode } : {}),
    ...errorFields(input.error),
    ...input.fields,
  };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "debug") console.debug(line);
  else console.log(line);
}
