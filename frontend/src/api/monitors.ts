import type { components } from "./generated/v2-schema";
import {
  OpenApiRequestError,
  unwrapOpenApi,
  v2Client,
} from "./generated/v2-client";

export type MonitorV2 = components["schemas"]["Monitor"];
export type MonitorPage = components["schemas"]["MonitorPage"];
export type MonitorMutation = components["schemas"]["MonitorMutation"];
export type MonitorUpdate = components["schemas"]["MonitorUpdate"];
export type MonitorHistory = components["schemas"]["MonitorHistory"];
export type MonitorDailyStats = components["schemas"]["MonitorDailyStats"];
export type MonitorExportItem = components["schemas"]["MonitorExportItem"];
export type MonitorImportItem = components["schemas"]["MonitorImportItem"];
export type MonitorCheckAccepted = components["schemas"]["MonitorCheckAccepted"];

export async function getMonitorsPage(
  input: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<MonitorPage> {
  const result = await v2Client.GET("/api/v2/monitors", {
    params: { query: { cursor: input.cursor, limit: input.limit ?? 50 } },
    signal,
  });
  return unwrapOpenApi(result);
}

export async function getMonitor(
  id: number,
  signal?: AbortSignal
): Promise<MonitorV2> {
  const result = await v2Client.GET("/api/v2/monitors/{id}", {
    params: { path: { id } },
    signal,
  });
  return unwrapOpenApi(result).data;
}

export async function createMonitor(input: MonitorMutation): Promise<MonitorV2> {
  const result = await v2Client.POST("/api/v2/monitors", { body: input });
  return unwrapOpenApi(result).data;
}

export async function updateMonitor(
  id: number,
  input: MonitorUpdate
): Promise<MonitorV2> {
  const result = await v2Client.PATCH("/api/v2/monitors/{id}", {
    params: { path: { id } },
    body: input,
  });
  return unwrapOpenApi(result).data;
}

export async function deleteMonitor(id: number): Promise<void> {
  const result = await v2Client.DELETE("/api/v2/monitors/{id}", {
    params: { path: { id } },
  });
  if (!result.response.ok) {
    throw new OpenApiRequestError(result.response.status, result.error);
  }
}

export async function getMonitorHistory(
  monitorId: number,
  signal?: AbortSignal
): Promise<MonitorHistory[]> {
  const result = await v2Client.GET("/api/v2/monitors/history", {
    params: { query: { monitor_id: monitorId } },
    signal,
  });
  return unwrapOpenApi(result).data;
}

export async function getMonitorDailyStats(
  monitorId: number,
  signal?: AbortSignal
): Promise<MonitorDailyStats[]> {
  const result = await v2Client.GET("/api/v2/monitors/daily", {
    params: { query: { monitor_id: monitorId, days: 90 } },
    signal,
  });
  return unwrapOpenApi(result).data;
}

export async function updateMonitorsOrder(ids: number[]): Promise<{ ids: number[] }> {
  const result = await v2Client.PUT("/api/v2/monitors/order", {
    body: { ids },
  });
  return unwrapOpenApi(result).data;
}

export async function exportMonitors(): Promise<MonitorExportItem[]> {
  const result = await v2Client.GET("/api/v2/monitors/export");
  return unwrapOpenApi(result).data;
}

export async function importMonitors(
  items: unknown[]
): Promise<components["schemas"]["ImportResult"]> {
  const result = await v2Client.POST("/api/v2/monitors/import", {
    body: items as MonitorImportItem[],
  });
  return unwrapOpenApi(result).data;
}

export async function checkMonitor(id: number): Promise<MonitorCheckAccepted> {
  const result = await v2Client.POST("/api/v2/monitors/{id}/check", {
    params: { path: { id } },
  });
  return unwrapOpenApi(result).data;
}
