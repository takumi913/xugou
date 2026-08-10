import type { Context } from "hono";
import type { ApiProblem } from "../../contracts/problem";
import { ApplicationProblem } from "../../shared/errors/ApplicationProblem";
import { createTraceId } from "../observability/StructuredLogger";

function traceId(c: Context) {
  return createTraceId(c.req.raw.headers);
}

export function isV2ApiRequest(c: Context) {
  return c.req.path.startsWith("/api/v2/");
}

export function problemResponse(
  c: Context,
  input: Omit<ApiProblem, "type" | "trace_id"> & { type?: string }
) {
  const body: ApiProblem = {
    type: input.type ?? `https://xugou.dev/problems/${input.code.toLowerCase().replaceAll("_", "-")}`,
    title: input.title,
    status: input.status,
    code: input.code,
    trace_id: traceId(c),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.errors ? { errors: input.errors } : {}),
  };
  return c.json(body, input.status as never, {
    "Content-Type": "application/problem+json; charset=utf-8",
  });
}

export function applicationProblemResponse(
  c: Context,
  error: ApplicationProblem
) {
  return problemResponse(c, {
    status: error.status,
    code: error.code,
    title: error.title,
    detail: error.message,
    errors: error.errors,
  });
}
