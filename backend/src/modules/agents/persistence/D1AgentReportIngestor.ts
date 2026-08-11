import type { Bindings } from "../../../models/db";
import { writeStructuredLog } from "../../../platform/observability/StructuredLogger";
import {
  computeTraffic,
  getTrafficPeriodStart,
  normalizeTrafficResetDay,
  sumNetworkTotals,
} from "../../../utils/traffic";
import type { AgentReportCommand } from "../domain/models";
import { publishLatestMetrics } from "../realtime/MetricsBroadcastPublisher";
import {
  normalizeAgentCountry,
  normalizeAgentGeo,
  type AgentReportSourceLocation,
} from "../../../utils/geo";
import { requestStatusRebuild } from "../../status/persistence/status-events";

interface StoredReport {
  agent_id: number;
  payload_digest: string;
  status: string;
}

interface StoredAgentState {
  status: string | null;
  traffic_reset_day: number | null;
  region: string | null;
  geo_latitude: number | null;
  geo_longitude: number | null;
  geo_city: string | null;
  geo_region_name: string | null;
}

interface StoredTrafficState {
  metrics_json: string | null;
  cpu_usage: number | null;
  memory_usage_rate: number | null;
  disk_usage_rate: number | null;
  month_rx: number | null;
  month_tx: number | null;
  last_total_rx: number | null;
  last_total_tx: number | null;
  month_reset_at: string | null;
  collected_at: string | null;
}

interface AgentThresholdSetting {
  on_cpu_threshold: number;
  cpu_threshold: number;
  on_memory_threshold: number;
  memory_threshold: number;
  on_disk_threshold: number;
  disk_threshold: number;
}

interface ThresholdState {
  cpu: boolean;
  memory: boolean;
  disk: boolean;
}

export type AgentReportIngestResult = {
  outcome: "completed" | "duplicate" | "conflict";
};

function maxDiskUsage(disks: Array<Record<string, unknown>> | undefined) {
  let maximum: number | null = null;
  for (const disk of disks ?? []) {
    if (typeof disk.usage_rate !== "number") continue;
    maximum = maximum === null ? disk.usage_rate : Math.max(maximum, disk.usage_rate);
  }
  return maximum;
}

function latestSample<T extends { collected_at: string }>(samples: T[]) {
  return samples.reduce((latest, sample) =>
    Date.parse(sample.collected_at) > Date.parse(latest.collected_at) ? sample : latest
  );
}

function maxFinite(values: Array<number | null | undefined>) {
  const finite = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  );
  return finite.length > 0 ? Math.max(...finite) : null;
}

function previousThresholdState(
  stored: StoredTrafficState | null,
  setting: AgentThresholdSetting | null
): ThresholdState {
  if (!setting) return { cpu: false, memory: false, disk: false };
  try {
    const parsed = JSON.parse(stored?.metrics_json ?? "{}") as {
      threshold_state?: Partial<ThresholdState>;
    };
    const state = parsed.threshold_state;
    if (
      typeof state?.cpu === "boolean" &&
      typeof state.memory === "boolean" &&
      typeof state.disk === "boolean"
    ) {
      return { cpu: state.cpu, memory: state.memory, disk: state.disk };
    }
  } catch {
    // 升级前的 current metrics 没有阈值状态，下面根据现有数值恢复。
  }
  return {
    cpu:
      setting.on_cpu_threshold === 1 &&
      typeof stored?.cpu_usage === "number" &&
      stored.cpu_usage >= setting.cpu_threshold,
    memory:
      setting.on_memory_threshold === 1 &&
      typeof stored?.memory_usage_rate === "number" &&
      stored.memory_usage_rate >= setting.memory_threshold,
    disk:
      setting.on_disk_threshold === 1 &&
      typeof stored?.disk_usage_rate === "number" &&
      stored.disk_usage_rate >= setting.disk_threshold,
  };
}

function currentThresholdState(
  observed: { cpu: number | null; memory: number | null; disk: number | null },
  setting: AgentThresholdSetting | null
): ThresholdState {
  if (!setting) return { cpu: false, memory: false, disk: false };
  return {
    cpu:
      setting.on_cpu_threshold === 1 &&
      observed.cpu !== null &&
      observed.cpu >= setting.cpu_threshold,
    memory:
      setting.on_memory_threshold === 1 &&
      observed.memory !== null &&
      observed.memory >= setting.memory_threshold,
    disk:
      setting.on_disk_threshold === 1 &&
      observed.disk !== null &&
      observed.disk >= setting.disk_threshold,
  };
}

/**
 * Agent 高频上报直接落入 D1。Queue 只接收状态变化或阈值越界事件，
 * 原始样本通过 json_each 在 D1 内展开，避免为每个样本创建一条 JS statement。
 */
export class D1AgentReportIngestor {
  constructor(private readonly env: Bindings) {}

  private async thresholdSetting(agentId: number) {
    return this.env.DB.prepare(
      `SELECT on_cpu_threshold, cpu_threshold,
              on_memory_threshold, memory_threshold,
              on_disk_threshold, disk_threshold
       FROM notification_rules
       WHERE enabled = 1 AND (
         (target_type = 'agent' AND target_id = ?)
         OR target_type = 'global-agent'
       )
       ORDER BY CASE WHEN target_type = 'agent' THEN 0 ELSE 1 END, id
       LIMIT 1`
    )
      .bind(agentId)
      .first<AgentThresholdSetting>();
  }

  async process(
    agentId: number,
    report: AgentReportCommand,
    input: {
      payloadDigest: string;
      receivedAt: string;
      sourceLocation?: AgentReportSourceLocation;
    }
  ): Promise<AgentReportIngestResult> {
    const now = new Date(input.receivedAt);
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    const inserted = await this.env.DB.prepare(
      `INSERT OR IGNORE INTO agent_reports
       (report_id, agent_id, payload_digest, payload_json, sample_count, status,
        received_at, processed_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, '{}', ?, 'pending', ?, NULL, NULL, ?, ?)
       RETURNING report_id`
    )
      .bind(
        report.report_id,
        agentId,
        input.payloadDigest,
        report.samples.length,
        nowIso,
        nowIso,
        nowIso
      )
      .first<{ report_id: string }>();

    if (!inserted) {
      const existing = await this.env.DB.prepare(
        `SELECT agent_id, payload_digest, status
         FROM agent_reports WHERE report_id = ? LIMIT 1`
      )
        .bind(report.report_id)
        .first<StoredReport>();
      if (
        !existing ||
        existing.agent_id !== agentId ||
        existing.payload_digest !== input.payloadDigest
      ) {
        return { outcome: "conflict" };
      }
      if (existing.status === "processed") {
        return { outcome: "duplicate" };
      }
    }

    const [agentState, storedTraffic, thresholdSetting] = await Promise.all([
      this.env.DB.prepare(
        `SELECT runtime.status, node.traffic_reset_day, runtime.region,
                runtime.geo_latitude, runtime.geo_longitude, runtime.geo_city,
                runtime.geo_region_name
         FROM agent_nodes node
         JOIN agent_runtime runtime ON runtime.agent_id = node.id
         WHERE node.id = ? AND node.deleted_at_ms IS NULL LIMIT 1`
      )
        .bind(agentId)
        .first<StoredAgentState>(),
      this.env.DB.prepare(
        `SELECT metrics_json, cpu_usage, memory_usage_rate, disk_usage_rate,
                month_rx, month_tx, last_total_rx, last_total_tx,
                traffic_period_start AS month_reset_at,
                CASE WHEN collected_at_ms IS NULL THEN NULL
                     ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                                   collected_at_ms / 1000.0, 'unixepoch') END
                  AS collected_at
         FROM agent_current_metrics WHERE agent_id = ? LIMIT 1`
      )
        .bind(agentId)
        .first<StoredTrafficState>(),
      this.thresholdSetting(agentId),
    ]);

    if (!agentState) {
      await this.env.DB.prepare(
        `UPDATE agent_reports SET status = 'failed', last_error = ?, updated_at = ?
         WHERE report_id = ? AND status <> 'processed'`
      )
        .bind(`Agent ${agentId} is missing or deleted`, nowIso, report.report_id)
        .run();
      throw new Error(`Agent ${agentId} is missing or deleted`);
    }

    const sourceRegion = normalizeAgentCountry(input.sourceLocation?.country);
    const sourceGeo = normalizeAgentGeo(input.sourceLocation);
    const locationChanged =
      (sourceRegion !== null && sourceRegion !== agentState.region) ||
      (sourceGeo.latitude !== null && sourceGeo.latitude !== agentState.geo_latitude) ||
      (sourceGeo.longitude !== null && sourceGeo.longitude !== agentState.geo_longitude) ||
      (sourceGeo.city !== null && sourceGeo.city !== agentState.geo_city) ||
      (sourceGeo.region_name !== null &&
        sourceGeo.region_name !== agentState.geo_region_name);

    const normalizedSamples = report.samples.map((sample) => ({
      ...sample,
      collected_at: new Date(sample.collected_at).toISOString(),
    }));
    const latest = latestSample(normalizedSamples);
    const chronological = normalizedSamples
      .map((sample, index) => ({ sample, index }))
      .sort(
        (left, right) =>
          Date.parse(left.sample.collected_at) - Date.parse(right.sample.collected_at)
      );
    const traffic = computeTraffic(
      storedTraffic
        ? {
            month_rx: Number(storedTraffic.month_rx ?? 0),
            month_tx: Number(storedTraffic.month_tx ?? 0),
            last_total_rx: storedTraffic.last_total_rx,
            last_total_tx: storedTraffic.last_total_tx,
            month_reset_at: storedTraffic.month_reset_at,
            last_ts: storedTraffic.collected_at
              ? Date.parse(storedTraffic.collected_at)
              : null,
          }
        : null,
      chronological.map(({ sample }) => ({
        ts: Date.parse(sample.collected_at),
        totals: sumNetworkTotals(
          sample.network?.map((item) => ({
            interface:
              typeof item.interface === "string" ? item.interface : undefined,
            bytes_recv:
              typeof item.bytes_recv === "number" ? item.bytes_recv : undefined,
            bytes_sent:
              typeof item.bytes_sent === "number" ? item.bytes_sent : undefined,
          }))
        ),
      })),
      getTrafficPeriodStart(
        new Date(latest.collected_at),
        normalizeTrafficResetDay(agentState.traffic_reset_day)
      )
    );
    const speedsByIndex = new Map(
      chronological.map((item, index) => [item.index, traffic.speeds[index]])
    );
    const enrichedSamples = normalizedSamples.map((sample, index) => ({
      ...sample,
      network_rx_speed: speedsByIndex.get(index)?.rx ?? null,
      network_tx_speed: speedsByIndex.get(index)?.tx ?? null,
    }));
    const latestIndex = normalizedSamples.indexOf(latest);
    const latestEnriched = enrichedSamples[latestIndex];
    const observedMetrics = {
      cpu: maxFinite(normalizedSamples.map((sample) => sample.cpu?.usage)),
      memory: maxFinite(
        normalizedSamples.map((sample) => sample.memory?.usage_rate)
      ),
      disk: maxFinite(
        normalizedSamples.map((sample) => maxDiskUsage(sample.disks))
      ),
    };
    const previousThresholds = previousThresholdState(
      storedTraffic,
      thresholdSetting
    );
    const thresholdState = currentThresholdState(observedMetrics, thresholdSetting);
    const thresholdCrossed =
      (thresholdState.cpu && !previousThresholds.cpu) ||
      (thresholdState.memory && !previousThresholds.memory) ||
      (thresholdState.disk && !previousThresholds.disk);
    const latestMetrics = {
      agent_id: agentId,
      timestamp: latest.collected_at,
      cpu_usage: latest.cpu?.usage ?? null,
      cpu_cores: latest.cpu?.cores ?? null,
      cpu_model: latest.cpu?.model_name ?? null,
      memory_total: latest.memory?.total ?? null,
      memory_used: latest.memory?.used ?? null,
      memory_free: latest.memory?.free ?? null,
      memory_usage_rate: latest.memory?.usage_rate ?? null,
      load_1: latest.load?.load1 ?? null,
      load_5: latest.load?.load5 ?? null,
      load_15: latest.load?.load15 ?? null,
      disk_metrics: JSON.stringify(latest.disks ?? []),
      network_metrics: JSON.stringify(latest.network ?? []),
      swap_total: latest.swap?.total ?? null,
      swap_used: latest.swap?.used ?? null,
      process_count: latest.process_count ?? null,
      tcp_connections: latest.tcp_connections ?? null,
      udp_connections: latest.udp_connections ?? null,
      ping_json: latest.ping ? JSON.stringify(latest.ping) : null,
      ipv4_reachable:
        latest.ipv4_reachable == null ? null : latest.ipv4_reachable ? 1 : 0,
      ipv6_reachable:
        latest.ipv6_reachable == null ? null : latest.ipv6_reachable ? 1 : 0,
      network_rx_speed: latestEnriched.network_rx_speed,
      network_tx_speed: latestEnriched.network_tx_speed,
      month_rx: traffic.state.month_rx,
      month_tx: traffic.state.month_tx,
      threshold_state: thresholdState,
    };
    const reportInterval = Math.max(
      1,
      report.report_interval_seconds ?? report.keepalive_seconds ?? 60
    );
    const keepalive = Math.max(1, report.keepalive_seconds ?? reportInterval);
    const nextOfflineAtMs = nowMs + Math.max(keepalive, reportInterval) * 3 * 1000;
    const statusChanged = agentState.status !== "active";
    const statusChangedEventId = `agent.status.changed:${report.report_id}`;
    const metricsObservedEventId = `agent.metrics.observed:${report.report_id}`;

    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO agent_report_samples
         (report_id, sample_index, agent_id, collected_at, metrics_json, created_at)
         SELECT ?, CAST(key AS INTEGER), ?,
                json_extract(value, '$.collected_at'), json(value), ?
         FROM json_each(?)`
      ).bind(
        report.report_id,
        agentId,
        nowIso,
        JSON.stringify(enrichedSamples)
      ),
      this.env.DB.prepare(
        `UPDATE agent_runtime SET
           status = 'active', hostname = COALESCE(?, hostname),
           ip_addresses_json = COALESCE(?, ip_addresses_json),
           os = COALESCE(?, os), agent_version = COALESCE(?, agent_version),
           boot_time = COALESCE(?, boot_time), keepalive_seconds = ?,
           region = COALESCE(?, region),
           geo_latitude = COALESCE(?, geo_latitude),
           geo_longitude = COALESCE(?, geo_longitude),
           geo_city = COALESCE(?, geo_city),
           geo_region_name = COALESCE(?, geo_region_name),
           last_seen_at_ms = ?, next_offline_at_ms = ?,
           last_state_changed_at_ms = CASE
             WHEN status = 'active' THEN last_state_changed_at_ms ELSE ? END,
           version = version + 1, updated_at_ms = ?
         WHERE agent_id = ? AND EXISTS (
           SELECT 1 FROM agent_nodes node
           WHERE node.id = agent_runtime.agent_id AND node.deleted_at_ms IS NULL
         )`
      ).bind(
        report.hostname ?? null,
        report.ip_addresses ? JSON.stringify(report.ip_addresses) : null,
        report.os ?? null,
        report.agent_version ?? report.version ?? null,
        report.boot_time ?? null,
        keepalive,
        sourceRegion,
        sourceGeo.latitude,
        sourceGeo.longitude,
        sourceGeo.city,
        sourceGeo.region_name,
        nowMs,
        nextOfflineAtMs,
        nowMs,
        nowMs,
        agentId
      ),
      this.env.DB.prepare(
        `INSERT INTO agent_current_metrics
         (agent_id, metrics_json, collected_at_ms, reported_at_ms, cpu_usage,
          memory_usage_rate, disk_usage_rate, swap_total, swap_used,
          process_count, tcp_connections, udp_connections, ping_json,
          ipv4_reachable, ipv6_reachable, network_rx_speed, network_tx_speed,
          month_rx, month_tx, last_total_rx, last_total_tx,
          traffic_period_start, version, created_at_ms, updated_at_ms)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM agent_nodes WHERE id = ? AND deleted_at_ms IS NULL
         )
         ON CONFLICT(agent_id) DO UPDATE SET
           metrics_json = excluded.metrics_json,
           collected_at_ms = excluded.collected_at_ms,
           reported_at_ms = excluded.reported_at_ms,
           cpu_usage = excluded.cpu_usage,
           memory_usage_rate = excluded.memory_usage_rate,
           disk_usage_rate = excluded.disk_usage_rate,
           swap_total = excluded.swap_total, swap_used = excluded.swap_used,
           process_count = excluded.process_count,
           tcp_connections = excluded.tcp_connections,
           udp_connections = excluded.udp_connections,
           ping_json = excluded.ping_json,
           ipv4_reachable = excluded.ipv4_reachable,
           ipv6_reachable = excluded.ipv6_reachable,
           network_rx_speed = excluded.network_rx_speed,
           network_tx_speed = excluded.network_tx_speed,
           month_rx = excluded.month_rx, month_tx = excluded.month_tx,
           last_total_rx = excluded.last_total_rx,
           last_total_tx = excluded.last_total_tx,
           traffic_period_start = excluded.traffic_period_start,
           version = agent_current_metrics.version + 1,
           updated_at_ms = excluded.updated_at_ms
         WHERE excluded.collected_at_ms >=
               COALESCE(agent_current_metrics.collected_at_ms, -1)`
      ).bind(
        agentId,
        JSON.stringify(latestMetrics),
        Date.parse(latest.collected_at),
        nowMs,
        latestMetrics.cpu_usage,
        latestMetrics.memory_usage_rate,
        maxDiskUsage(latest.disks),
        latestMetrics.swap_total,
        latestMetrics.swap_used,
        latestMetrics.process_count,
        latestMetrics.tcp_connections,
        latestMetrics.udp_connections,
        latestMetrics.ping_json,
        latestMetrics.ipv4_reachable,
        latestMetrics.ipv6_reachable,
        latestMetrics.network_rx_speed,
        latestMetrics.network_tx_speed,
        traffic.state.month_rx,
        traffic.state.month_tx,
        traffic.state.last_total_rx,
        traffic.state.last_total_tx,
        traffic.state.month_reset_at,
        nowMs,
        nowMs,
        agentId
      ),
    ];

    if (statusChanged) {
      statements.push(
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO domain_outbox
           (event_id, event_type, aggregate_type, aggregate_id, payload_json,
            status, attempts, available_at, created_at, updated_at)
           VALUES (?, 'agent.status.changed', 'agent', ?, ?, 'pending', 0, ?, ?, ?)`
        ).bind(
          statusChangedEventId,
          String(agentId),
          JSON.stringify({
            report_id: report.report_id,
            agent_id: agentId,
            previous_status:
              agentState.status === "active" ? "online" : "offline",
            status: "online",
            changed_at: nowIso,
          }),
          nowIso,
          nowIso,
          nowIso
        )
      );
    }

    if (thresholdCrossed) {
      statements.push(
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO domain_outbox
           (event_id, event_type, aggregate_type, aggregate_id, payload_json,
            status, attempts, available_at, created_at, updated_at)
           VALUES (?, 'agent.metrics.observed', 'agent', ?, ?, 'pending', 0, ?, ?, ?)`
        ).bind(
          metricsObservedEventId,
          String(agentId),
          JSON.stringify({
            report_id: report.report_id,
            agent_id: agentId,
            observed_at: latest.collected_at,
            ...observedMetrics,
          }),
          nowIso,
          nowIso,
          nowIso
        )
      );
    }

    statements.push(
      this.env.DB.prepare(
        `UPDATE agent_reports
         SET status = 'processed', processed_at = COALESCE(processed_at, ?),
             payload_json = '{}', last_error = NULL, updated_at = ?
         WHERE report_id = ? AND agent_id = ? AND payload_digest = ?`
      ).bind(
        nowIso,
        nowIso,
        report.report_id,
        agentId,
        input.payloadDigest
      )
    );

    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      await this.env.DB.prepare(
        `UPDATE agent_reports SET status = 'failed', last_error = ?, updated_at = ?
         WHERE report_id = ? AND status <> 'processed'`
      )
        .bind(
          (error instanceof Error ? error.message : String(error)).slice(0, 2048),
          nowIso,
          report.report_id
        )
        .run();
      throw error;
    }

    try {
      await publishLatestMetrics(
        this.env,
        agentId,
        latest.collected_at,
        latestMetrics
      );
    } catch (error) {
      writeStructuredLog(this.env, {
        service: "realtime",
        operation: "publish_latest_agent_metrics",
        result: "deferred",
        reportId: report.report_id,
        entityType: "agent",
        entityId: agentId,
        errorCode: "AGENT_METRICS_BROADCAST_DEFERRED",
        error,
      });
    }


    if (locationChanged) {
      try {
        await requestStatusRebuild(this.env, {
          reason: "agent.location.changed",
          aggregateType: "agent",
          aggregateId: agentId,
          coalesceSeconds: 3600,
        });
      } catch (error) {
        writeStructuredLog(this.env, {
          service: "status",
          operation: "request_location_publication_rebuild",
          result: "deferred",
          reportId: report.report_id,
          entityType: "agent",
          entityId: agentId,
          errorCode: "STATUS_LOCATION_REBUILD_DEFERRED",
          error,
        });
      }
    }

    return { outcome: "completed" };
  }
}
