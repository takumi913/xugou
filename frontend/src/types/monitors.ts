import type { components } from "../api/generated/v2-schema";

/** UI names retained as aliases; their field truth comes from OpenAPI. */
export type Monitor = components["schemas"]["DashboardMonitor"];
export type PublicMonitor = components["schemas"]["PublicMonitor"];
export type MonitorStatusHistory = components["schemas"]["MonitorHistory"];
export type DailyStats = components["schemas"]["MonitorDailyStats"];
