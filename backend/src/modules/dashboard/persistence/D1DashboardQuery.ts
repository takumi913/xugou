import type { Bindings } from "../../../models/db";
import type { Metrics } from "../../../models/agent";
import { legacyMonitorModelCoverage } from "../../../platform/migrations/LegacyMonitorModelBackfill";
import { legacyAgentModelCoverage } from "../../../platform/migrations/LegacyAgentModelBackfill";
import { legacyAgentCurrentMetricsCoverage } from "../../../platform/migrations/LegacyAgentCurrentMetricsBackfill";
import { isContractMode } from "../../../platform/compatibility/CompatibilityMode";
import type { DashboardQueryPort } from "../application/DashboardUseCases";
import type {
  DashboardProjection,
  DashboardSummary,
} from "../domain/models";

// Dashboard 是概览而不是资源导出接口。稳定限制单次投影规模，完整资源继续由
// Monitor/Agent Cursor API 提供，避免大型单实例把一个 Worker 请求撑到内存上限。
export const DASHBOARD_PREVIEW_LIMIT = 200;

interface DashboardAgentRow {
  [key: string]: unknown;
  id: number;
  metrics_json: string | null;
  metrics_collected_at: string | null;
  metrics_reported_at: string | null;
}

interface MonitorSummaryRow {
  monitors_total: number;
  monitors_up: number;
  monitors_down: number;
  monitors_pending: number;
  monitors_avg_response_time_ms: number | null;
}

interface AgentSummaryRow {
  agents_total: number;
  agents_online: number;
  agents_offline: number;
  total_traffic_bytes: number | null;
  network_rx_speed_bps: number | null;
  network_tx_speed_bps: number | null;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJsonObject(value: unknown) {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export async function queryDashboard(env: Bindings): Promise<DashboardProjection> {
  const contractMode = isContractMode(env);
  const [monitorModelReady, agentModelReady, currentMetricsReady] = contractMode
    ? [true, true, true]
    : await Promise.all([
        legacyMonitorModelCoverage(env).then((coverage) => coverage.read_ready),
        legacyAgentModelCoverage(env).then((coverage) => coverage.read_ready),
        legacyAgentCurrentMetricsCoverage(env).then(
          (coverage) => coverage.read_ready
        ),
      ]);
  const latestMetricsJoin = currentMetricsReady
    ? `LEFT JOIN (
         SELECT agent_id, metrics_json,
                CASE WHEN collected_at_ms IS NULL THEN NULL
                     ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                                   collected_at_ms / 1000.0, 'unixepoch') END
                  AS collected_at,
                strftime('%Y-%m-%dT%H:%M:%fZ',
                         reported_at_ms / 1000.0, 'unixepoch') AS reported_at
         FROM agent_current_metrics
       ) lm`
    : `LEFT JOIN agent_latest_metrics lm`;
  const summaryMetricsJoin = currentMetricsReady
    ? "LEFT JOIN agent_current_metrics lm ON lm.agent_id = n.id"
    : "LEFT JOIN agent_latest_metrics lm ON lm.agent_id = n.id";
  const monitorQuery = monitorModelReady
    ? `SELECT d.id, d.name, d.url, d.method,
              CAST(d.interval_ms / 1000 AS INTEGER) AS interval,
              CAST((d.timeout_ms + 999) / 1000 AS INTEGER) AS timeout,
              d.timeout_ms, d.expected_status, d.headers_json AS headers,
              d.body, d.active, r.status, r.response_time_ms AS response_time,
              CASE WHEN r.last_checked_at_ms IS NULL THEN NULL
                   ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                                 r.last_checked_at_ms / 1000.0, 'unixepoch') END
                AS last_checked,
              CASE WHEN r.next_due_at_ms IS NULL THEN NULL
                   ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                                 r.next_due_at_ms / 1000.0, 'unixepoch') END
                AS next_check_at,
              strftime('%Y-%m-%dT%H:%M:%fZ',
                       d.created_at_ms / 1000.0, 'unixepoch') AS created_at,
              strftime('%Y-%m-%dT%H:%M:%fZ',
                       d.updated_at_ms / 1000.0, 'unixepoch') AS updated_at,
              d.sort_order
       FROM monitor_definitions d
       JOIN monitor_runtime r ON r.monitor_id = d.id
       WHERE d.deleted_at_ms IS NULL ORDER BY d.sort_order ASC, d.id ASC
       LIMIT ?`
    : `SELECT * FROM monitors
       WHERE deleted_at IS NULL ORDER BY sort_order ASC, id ASC
       LIMIT ?`;
  const agentQuery =
      agentModelReady
        ? `SELECT n.id, n.name, r.status, r.hostname,
                  r.ip_addresses_json AS ip_addresses, r.os,
                  r.agent_version AS version,
                  CAST(r.keepalive_seconds AS TEXT) AS keepalive,
                  CASE WHEN r.last_seen_at_ms IS NULL THEN NULL
                       ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                                     r.last_seen_at_ms / 1000.0, 'unixepoch') END
                    AS last_seen_at,
                  CASE WHEN r.last_state_changed_at_ms IS NULL THEN NULL
                       ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                                     r.last_state_changed_at_ms / 1000.0, 'unixepoch') END
                    AS last_state_changed_at,
                  CASE WHEN r.next_offline_at_ms IS NULL THEN NULL
                       ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                                     r.next_offline_at_ms / 1000.0, 'unixepoch') END
                    AS next_offline_at,
                  CAST(n.collect_interval_ms / 1000 AS INTEGER) AS collect_interval,
                  CAST(n.report_interval_ms / 1000 AS INTEGER) AS report_interval,
                  r.region, r.geo_latitude, r.geo_longitude, r.geo_city,
                  r.geo_region_name, r.boot_time, n.price, n.currency,
                  n.billing_cycle, n.expire_date, n.auto_renewal, n.is_hidden,
                  n.traffic_limit_gb, n.traffic_reset_day, n.traffic_calc_type,
                  n.auto_update, n.group_name,
                  (SELECT GROUP_CONCAT(value, ',') FROM json_each(n.tags_json)) AS tags,
                  n.sort_order,
                  strftime('%Y-%m-%dT%H:%M:%fZ',
                           n.created_at_ms / 1000.0, 'unixepoch') AS created_at,
                  strftime('%Y-%m-%dT%H:%M:%fZ',
                           n.updated_at_ms / 1000.0, 'unixepoch') AS updated_at,
                  lm.metrics_json, lm.collected_at AS metrics_collected_at,
                  lm.reported_at AS metrics_reported_at
           FROM agent_nodes n
           JOIN agent_runtime r ON r.agent_id = n.id
           ${latestMetricsJoin} ON lm.agent_id = n.id
           WHERE n.deleted_at_ms IS NULL
           ORDER BY n.sort_order ASC, n.id ASC
           LIMIT ?`
        : `SELECT a.*, lm.metrics_json, lm.collected_at AS metrics_collected_at,
                  lm.reported_at AS metrics_reported_at
           FROM agents a
           ${latestMetricsJoin} ON lm.agent_id = a.id
           WHERE a.deleted_at IS NULL
           ORDER BY a.sort_order ASC, a.id ASC
           LIMIT ?`;
  const monitorSummaryQuery = monitorModelReady
    ? `SELECT COUNT(*) AS monitors_total,
              COALESCE(SUM(CASE WHEN r.status = 'up' THEN 1 ELSE 0 END), 0)
                AS monitors_up,
              COALESCE(SUM(CASE WHEN r.status = 'down' THEN 1 ELSE 0 END), 0)
                AS monitors_down,
              COALESCE(SUM(CASE WHEN r.status NOT IN ('up', 'down') THEN 1 ELSE 0 END), 0)
                AS monitors_pending,
              ROUND(AVG(CASE WHEN r.status = 'up' THEN r.response_time_ms END))
                AS monitors_avg_response_time_ms
       FROM monitor_definitions d
       JOIN monitor_runtime r ON r.monitor_id = d.id
       WHERE d.deleted_at_ms IS NULL`
    : `SELECT COUNT(*) AS monitors_total,
              COALESCE(SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END), 0)
                AS monitors_up,
              COALESCE(SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END), 0)
                AS monitors_down,
              COALESCE(SUM(CASE WHEN status NOT IN ('up', 'down') THEN 1 ELSE 0 END), 0)
                AS monitors_pending,
              ROUND(AVG(CASE WHEN status = 'up' THEN response_time END))
                AS monitors_avg_response_time_ms
       FROM monitors WHERE deleted_at IS NULL`;
  const agentSummaryQuery = agentModelReady
    ? `SELECT COUNT(*) AS agents_total,
              COALESCE(SUM(CASE WHEN r.status = 'active' THEN 1 ELSE 0 END), 0)
                AS agents_online,
              COALESCE(SUM(CASE WHEN r.status <> 'active' THEN 1 ELSE 0 END), 0)
                AS agents_offline,
              SUM(CASE WHEN r.status = 'active' AND lm.agent_id IS NOT NULL THEN
                    CASE n.traffic_calc_type
                      WHEN 'rx' THEN COALESCE(lm.month_rx, 0)
                      WHEN 'tx' THEN COALESCE(lm.month_tx, 0)
                      ELSE COALESCE(lm.month_rx, 0) + COALESCE(lm.month_tx, 0)
                    END
                  END) AS total_traffic_bytes,
              SUM(CASE WHEN r.status = 'active' THEN lm.network_rx_speed END)
                AS network_rx_speed_bps,
              SUM(CASE WHEN r.status = 'active' THEN lm.network_tx_speed END)
                AS network_tx_speed_bps
       FROM agent_nodes n
       JOIN agent_runtime r ON r.agent_id = n.id
       ${summaryMetricsJoin}
       WHERE n.deleted_at_ms IS NULL`
    : `SELECT COUNT(*) AS agents_total,
              COALESCE(SUM(CASE WHEN a.status = 'active' THEN 1 ELSE 0 END), 0)
                AS agents_online,
              COALESCE(SUM(CASE WHEN a.status <> 'active' THEN 1 ELSE 0 END), 0)
                AS agents_offline,
              SUM(CASE WHEN a.status = 'active' AND lm.agent_id IS NOT NULL THEN
                    CASE a.traffic_calc_type
                      WHEN 'rx' THEN COALESCE(lm.month_rx, 0)
                      WHEN 'tx' THEN COALESCE(lm.month_tx, 0)
                      ELSE COALESCE(lm.month_rx, 0) + COALESCE(lm.month_tx, 0)
                    END
                  END) AS total_traffic_bytes,
              SUM(CASE WHEN a.status = 'active' THEN lm.network_rx_speed END)
                AS network_rx_speed_bps,
              SUM(CASE WHEN a.status = 'active' THEN lm.network_tx_speed END)
                AS network_tx_speed_bps
       FROM agents a
       ${currentMetricsReady
         ? "LEFT JOIN agent_current_metrics lm ON lm.agent_id = a.id"
         : "LEFT JOIN agent_latest_metrics lm ON lm.agent_id = a.id"}
       WHERE a.deleted_at IS NULL`;
  // D1 batch 保证四个读取在同一事务中顺序执行；LIMIT + 1 只用于判定截断。
  const [monitorsResult, agentsResult, monitorSummaryResult, agentSummaryResult] =
    await env.DB.batch([
      env.DB.prepare(monitorQuery).bind(DASHBOARD_PREVIEW_LIMIT + 1),
      env.DB.prepare(agentQuery).bind(DASHBOARD_PREVIEW_LIMIT + 1),
      env.DB.prepare(monitorSummaryQuery),
      env.DB.prepare(agentSummaryQuery),
    ]);
  const monitorRows = (monitorsResult.results ?? []) as Record<string, unknown>[];
  const agentRows = (agentsResult.results ?? []) as DashboardAgentRow[];
  const monitorSummary = (monitorSummaryResult.results?.[0] ?? {}) as Partial<MonitorSummaryRow>;
  const agentSummary = (agentSummaryResult.results?.[0] ?? {}) as Partial<AgentSummaryRow>;
  const monitorsHasMore = monitorRows.length > DASHBOARD_PREVIEW_LIMIT;
  const agentsHasMore = agentRows.length > DASHBOARD_PREVIEW_LIMIT;
  const monitors = monitorRows.slice(0, DASHBOARD_PREVIEW_LIMIT).map((monitor) => ({
    ...monitor,
    headers: parseJsonObject(monitor.headers),
  }));
  const agents = agentRows.slice(0, DASHBOARD_PREVIEW_LIMIT).map((row) => {
    const {
      token: _token,
      deleted_at: _deletedAt,
      metrics_json,
      metrics_collected_at,
      metrics_reported_at,
      ...agent
    } = row;
    let metrics: Metrics | null = null;
    if (metrics_json) {
      try {
        const parsed = JSON.parse(metrics_json) as Metrics;
        metrics = {
          ...parsed,
          agent_id: row.id,
          timestamp:
            parsed.timestamp ?? metrics_collected_at ?? metrics_reported_at ?? "",
        };
      } catch {
        metrics = null;
      }
    }
    return { ...agent, metrics };
  });
  const summary: DashboardSummary = {
    monitors_total: numeric(monitorSummary.monitors_total),
    monitors_up: numeric(monitorSummary.monitors_up),
    monitors_down: numeric(monitorSummary.monitors_down),
    monitors_pending: numeric(monitorSummary.monitors_pending),
    monitors_avg_response_time_ms: nullableNumeric(
      monitorSummary.monitors_avg_response_time_ms
    ),
    agents_total: numeric(agentSummary.agents_total),
    agents_online: numeric(agentSummary.agents_online),
    agents_offline: numeric(agentSummary.agents_offline),
    total_traffic_bytes: nullableNumeric(agentSummary.total_traffic_bytes),
    network_rx_speed_bps: nullableNumeric(agentSummary.network_rx_speed_bps),
    network_tx_speed_bps: nullableNumeric(agentSummary.network_tx_speed_bps),
  };
  return {
    monitors,
    agents,
    summary,
    monitors_has_more: monitorsHasMore,
    agents_has_more: agentsHasMore,
  };
}

export class D1DashboardQuery implements DashboardQueryPort {
  constructor(private readonly env: Bindings) {}

  getDashboard() {
    return queryDashboard(this.env);
  }
}
