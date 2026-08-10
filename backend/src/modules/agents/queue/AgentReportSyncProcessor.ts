const isContractMode = (env: any) => true;
const hasTableColumn = (env: any, table: string, column: string) => true;
import type { Bindings } from "../../../models/db";
import { writeStructuredLog } from "../../../platform/observability/StructuredLogger";
import type { AgentReportCommand } from "../domain/models";
import { publishLatestMetrics } from "../realtime/MetricsBroadcastPublisher";
import {
  computeTraffic,
  getTrafficPeriodStart,
  normalizeTrafficResetDay,
  sumNetworkTotals,
} from "../../../utils/traffic";
import {
  prepareAgentMetricRollupRebuild,
  uniqueAgentMetricBuckets,
} from "../persistence/D1AgentMetricRollup";
import { OutboxDispatcher } from "../../../platform/queues/OutboxDispatcher";

interface StoredAgentState {
  status: string | null;
  traffic_reset_day: number | null;
}

interface StoredTrafficState {
  month_rx: number | null;
  month_tx: number | null;
  last_total_rx: number | null;
  last_total_tx: number | null;
  month_reset_at: string | null;
  collected_at: string | null;
}

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

export class AgentReportSyncProcessor {
  constructor(
    private readonly env: Bindings
  ) {}

  async process(agentId: number, report: AgentReportCommand) {
    const now = new Date();
    const agentState = await this.env.DB.prepare(
      `SELECT runtime.status, node.traffic_reset_day
         FROM agent_nodes node
         JOIN agent_runtime runtime ON runtime.agent_id = node.id
         WHERE node.id = ? AND node.deleted_at_ms IS NULL LIMIT 1`
    )
      .bind(agentId)
      .first<StoredAgentState>();
      
    if (!agentState) {
      throw new Error(`Agent ${agentId} is missing or deleted`);
    }

    const storedTraffic = await this.env.DB.prepare(
      `SELECT month_rx, month_tx, last_total_rx, last_total_tx,
                traffic_period_start AS month_reset_at,
                CASE WHEN collected_at_ms IS NULL THEN NULL
                     ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                                   collected_at_ms / 1000.0, 'unixepoch') END
                  AS collected_at
         FROM agent_current_metrics WHERE agent_id = ? LIMIT 1`
    )
      .bind(agentId)
      .first<StoredTrafficState>();

    // Store canonical UTC timestamps so indexed range queries have the same
    // ordering semantics for Z and explicit-offset Agent payloads.
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
    };
    const reportInterval = Math.max(
      1,
      report.report_interval_seconds ?? report.keepalive_seconds ?? 300
    );
    const keepalive = Math.max(1, report.keepalive_seconds ?? reportInterval);
    const nextOfflineAt = new Date(
      now.getTime() + Math.max(keepalive, reportInterval) * 3 * 1000
    ).toISOString();
    const nowMs = now.getTime();
    const nextOfflineAtMs = Date.parse(nextOfflineAt);
    const reportProcessedEventId = `agent.report.processed:${report.report_id}`;
    const statusChangedEventId = `agent.status.changed:${report.report_id}`;
    const metricsObservedEventId = `agent.metrics.observed:${report.report_id}`;
    const observedMetrics = {
      cpu: maxFinite(normalizedSamples.map((sample) => sample.cpu?.usage)),
      memory: maxFinite(
        normalizedSamples.map((sample) => sample.memory?.usage_rate)
      ),
      disk: maxFinite(
        normalizedSamples.map((sample) => maxDiskUsage(sample.disks))
      ),
    };
    const statusChanged = agentState.status !== "active";
    const outboxEventIds = [reportProcessedEventId, metricsObservedEventId];
    if (statusChanged) outboxEventIds.push(statusChangedEventId);
    
    const statements = enrichedSamples.map((sample, index) =>
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO agent_report_samples
         (report_id, sample_index, agent_id, collected_at, metrics_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        report.report_id,
        index,
        agentId,
        sample.collected_at,
        JSON.stringify(sample),
        now.toISOString()
      )
    );
    statements.push(
      ...uniqueAgentMetricBuckets(enrichedSamples).map((bucket) =>
        prepareAgentMetricRollupRebuild(
          this.env.DB,
          agentId,
          bucket,
          now.toISOString()
        )
      )
    );
    statements.push(

      this.env.DB.prepare(
        `UPDATE agent_runtime SET
           status = 'active', hostname = COALESCE(?, hostname),
           ip_addresses_json = COALESCE(?, ip_addresses_json),
           os = COALESCE(?, os), agent_version = COALESCE(?, agent_version),
           boot_time = COALESCE(?, boot_time), keepalive_seconds = ?,
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
      ...(!true ? [
      this.env.DB.prepare(
        `INSERT INTO legacy_id_map
         (source_table, source_id, target_table, target_id, payload_checksum,
          created_at, updated_at)
         SELECT 'agent_latest_metrics', ?, 'agent_current_metrics', ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM agent_current_metrics WHERE agent_id = ?
         )
         ON CONFLICT(source_table, source_id) DO UPDATE SET
           target_table = excluded.target_table, target_id = excluded.target_id,
           payload_checksum = excluded.payload_checksum,
           updated_at = excluded.updated_at`
      ).bind(
        String(agentId),
        String(agentId),
        `report:${report.report_id}`,
        now.toISOString(),
        now.toISOString(),
        agentId
      )] : []),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO domain_outbox
         (event_id, event_type, aggregate_type, aggregate_id, payload_json,
          status, attempts, available_at, created_at, updated_at)
         VALUES (?, 'agent.report.processed', 'agent', ?, ?, 'pending', 0, ?, ?, ?)`
      ).bind(
        reportProcessedEventId,
        String(agentId),
        JSON.stringify({
          report_id: report.report_id,
          agent_id: agentId,
          sample_count: report.samples.length,
          latest_collected_at: latest.collected_at,
        }),
        now.toISOString(),
        now.toISOString(),
        now.toISOString()
      ),
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
        now.toISOString(),
        now.toISOString(),
        now.toISOString()
      )
    );

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
            changed_at: now.toISOString(),
          }),
          now.toISOString(),
          now.toISOString(),
          now.toISOString()
        )
      );
    }

    await this.env.DB.batch(statements);

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

    // Process outbox events synchronously to immediately rebuild status and send notifications
    const outboxDispatcher = new OutboxDispatcher(this.env);
    for (const outboxEventId of outboxEventIds) {
      try {
        await outboxDispatcher.process(outboxEventId);
      } catch (error) {
        writeStructuredLog(this.env, {
          service: "queue",
          operation: "publish_agent_report_outbox",
          result: "deferred",
          eventId: outboxEventId,
          reportId: report.report_id,
          entityType: "agent",
          entityId: agentId,
          errorCode: "AGENT_REPORT_OUTBOX_PUBLISH_DEFERRED",
          error,
        });
      }
    }
    
    return { outcome: "completed" };
  }
}
