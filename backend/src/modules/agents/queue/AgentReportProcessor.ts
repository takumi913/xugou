import type { Bindings } from "../../../models/db";
import { writeStructuredLog } from "../../../platform/observability/StructuredLogger";
import { QueueJobPublisher } from "../../../platform/queues/QueuePublisher";
import type { XugouQueueMessage } from "../../../platform/queues/messages";
import { agentV4ReportSchema } from "../http/schemas";
import { publishLatestMetrics } from "../realtime/MetricsBroadcastPublisher";
import {
  computeTraffic,
  getTrafficPeriodStart,
  normalizeTrafficResetDay,
  sumNetworkTotals,
} from "../../../utils/traffic";
import { legacyAgentModelCoverage } from "../../../platform/migrations/LegacyAgentModelBackfill";
import { legacyAgentCurrentMetricsCoverage } from "../../../platform/migrations/LegacyAgentCurrentMetricsBackfill";
import { isContractMode } from "../../../platform/compatibility/CompatibilityMode";
import {
  prepareAgentMetricRollupRebuild,
  uniqueAgentMetricBuckets,
} from "../persistence/D1AgentMetricRollup";

interface ClaimedJob {
  id: string;
  aggregate_id: string;
  attempts: number;
  max_attempts: number;
  lease_token: string;
}

interface StoredReport {
  report_id: string;
  agent_id: number;
  payload_json: string;
  status: string;
}

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

export type JobProcessResult =
  | { outcome: "completed" | "ignored" }
  | { outcome: "retry"; delaySeconds: number };

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2048);
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

export class AgentReportProcessor {
  private readonly queue: QueueJobPublisher;

  constructor(
    private readonly env: Pick<
      Bindings,
      "DB" | "XUGOU_JOBS" | "AGENT_ROOM" | "DATA_COMPATIBILITY_MODE"
    >
  ) {
    this.queue = new QueueJobPublisher(env.XUGOU_JOBS);
  }

  private async claim(jobId: string, now: Date) {
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + 60_000).toISOString();
    return this.env.DB.prepare(
      `UPDATE async_jobs
       SET status = 'processing', attempts = attempts + 1,
           lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ?
         AND kind = 'agent.report.process'
         AND attempts < max_attempts
         AND available_at <= ?
         AND (
           status IN ('pending', 'retry')
           OR (status = 'processing' AND lease_expires_at <= ?)
         )
       RETURNING id, aggregate_id, attempts, max_attempts, lease_token`
    )
      .bind(
        leaseToken,
        leaseExpiresAt,
        now.toISOString(),
        jobId,
        now.toISOString(),
        now.toISOString()
      )
      .first<ClaimedJob>();
  }

  private async finishFailure(job: ClaimedJob, error: unknown, permanent = false) {
    const now = new Date();
    const exhausted = permanent || job.attempts >= job.max_attempts;
    const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
    const availableAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
    await this.env.DB.prepare(
      `UPDATE async_jobs
       SET status = ?, available_at = ?, lease_token = NULL,
           lease_expires_at = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND lease_token = ? AND status = 'processing'`
    )
      .bind(
        exhausted ? "failed" : "retry",
        availableAt,
        errorMessage(error),
        now.toISOString(),
        job.id,
        job.lease_token
      )
      .run();
    return exhausted
      ? ({ outcome: "ignored" } as const)
      : ({ outcome: "retry", delaySeconds } as const);
  }

  async process(jobId: string): Promise<JobProcessResult> {
    const now = new Date();
    const job = await this.claim(jobId, now);
    if (!job) return { outcome: "ignored" };

    const stored = await this.env.DB.prepare(
      `SELECT report_id, agent_id, payload_json, status
       FROM agent_reports WHERE report_id = ? LIMIT 1`
    )
      .bind(job.aggregate_id)
      .first<StoredReport>();
    if (!stored) {
      return this.finishFailure(job, "Agent report row is missing", true);
    }
    if (stored.status === "processed") {
      await this.env.DB.prepare(
        `UPDATE async_jobs SET status = 'completed', completed_at = ?,
           lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND lease_token = ?`
      )
        .bind(now.toISOString(), now.toISOString(), job.id, job.lease_token)
        .run();
      return { outcome: "completed" };
    }

    const contractMode = isContractMode(this.env);
    const targetReady =
      contractMode || (await legacyAgentModelCoverage(this.env)).read_ready;
    const agentState = await this.env.DB.prepare(
      targetReady
        ? `SELECT runtime.status, node.traffic_reset_day
           FROM agent_nodes node
           JOIN agent_runtime runtime ON runtime.agent_id = node.id
           WHERE node.id = ? AND node.deleted_at_ms IS NULL LIMIT 1`
        : `SELECT status, traffic_reset_day FROM agents
           WHERE id = ? AND deleted_at IS NULL LIMIT 1`
    )
      .bind(stored.agent_id)
      .first<StoredAgentState>();
    if (!agentState) {
      return this.finishFailure(job, "Agent is missing or deleted", true);
    }
    const currentMetricsReady =
      contractMode ||
      (await legacyAgentCurrentMetricsCoverage(this.env)).read_ready;
    const storedTraffic = await this.env.DB.prepare(
      currentMetricsReady
        ? `SELECT month_rx, month_tx, last_total_rx, last_total_tx,
                  traffic_period_start AS month_reset_at,
                  CASE WHEN collected_at_ms IS NULL THEN NULL
                       ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                                     collected_at_ms / 1000.0, 'unixepoch') END
                    AS collected_at
           FROM agent_current_metrics WHERE agent_id = ? LIMIT 1`
        : `SELECT month_rx, month_tx, last_total_rx, last_total_tx,
                  month_reset_at, collected_at
           FROM agent_latest_metrics WHERE agent_id = ? LIMIT 1`
    )
      .bind(stored.agent_id)
      .first<StoredTrafficState>();

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stored.payload_json);
    } catch (error) {
      return this.finishFailure(job, error, true);
    }
    const parsed = agentV4ReportSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return this.finishFailure(job, parsed.error.message, true);
    }

    try {
      const report = parsed.data;
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
        agent_id: stored.agent_id,
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
      const reportProcessedEventId = `agent.report.processed:${stored.report_id}`;
      const statusChangedEventId = `agent.status.changed:${stored.report_id}`;
      const metricsObservedEventId = `agent.metrics.observed:${stored.report_id}`;
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
          stored.report_id,
          index,
          stored.agent_id,
          sample.collected_at,
          JSON.stringify(sample),
          now.toISOString()
        )
      );
      statements.push(
        ...uniqueAgentMetricBuckets(enrichedSamples).map((bucket) =>
          prepareAgentMetricRollupRebuild(
            this.env.DB,
            stored.agent_id,
            bucket,
            now.toISOString()
          )
        )
      );
      statements.push(
        ...(!contractMode ? [
        this.env.DB.prepare(
          `UPDATE agents SET
             status = 'active', hostname = COALESCE(?, hostname),
             ip_addresses = COALESCE(?, ip_addresses), os = COALESCE(?, os),
             version = COALESCE(?, version), boot_time = COALESCE(?, boot_time),
             keepalive = ?, last_seen_at = ?, next_offline_at = ?,
             last_state_changed_at = CASE WHEN status = 'active' THEN last_state_changed_at ELSE ? END
           WHERE id = ? AND deleted_at IS NULL`
        ).bind(
          report.hostname ?? null,
          report.ip_addresses ? JSON.stringify(report.ip_addresses) : null,
          report.os ?? null,
          report.agent_version ?? report.version ?? null,
          report.boot_time ?? null,
          String(keepalive),
          now.toISOString(),
          nextOfflineAt,
          now.toISOString(),
          stored.agent_id
        )] : []),
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
          stored.agent_id
        ),
        ...(!contractMode ? [
        this.env.DB.prepare(
          `INSERT INTO agent_latest_metrics
           (agent_id, metrics_json, collected_at, reported_at, cpu_usage,
            memory_usage_rate, disk_usage_rate, swap_total, swap_used,
            process_count, tcp_connections, udp_connections, ping_json,
            ipv4_reachable, ipv6_reachable, network_rx_speed, network_tx_speed,
            month_rx, month_tx, last_total_rx, last_total_tx, month_reset_at,
            updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             metrics_json = excluded.metrics_json,
             collected_at = excluded.collected_at,
             reported_at = excluded.reported_at,
             cpu_usage = excluded.cpu_usage,
             memory_usage_rate = excluded.memory_usage_rate,
             disk_usage_rate = excluded.disk_usage_rate,
             swap_total = excluded.swap_total,
             swap_used = excluded.swap_used,
             process_count = excluded.process_count,
             tcp_connections = excluded.tcp_connections,
             udp_connections = excluded.udp_connections,
             ping_json = excluded.ping_json,
             ipv4_reachable = excluded.ipv4_reachable,
             ipv6_reachable = excluded.ipv6_reachable,
             network_rx_speed = excluded.network_rx_speed,
             network_tx_speed = excluded.network_tx_speed,
             month_rx = excluded.month_rx,
             month_tx = excluded.month_tx,
             last_total_rx = excluded.last_total_rx,
             last_total_tx = excluded.last_total_tx,
             month_reset_at = excluded.month_reset_at,
             updated_at = excluded.updated_at
           WHERE excluded.collected_at >= COALESCE(agent_latest_metrics.collected_at, '')`
        ).bind(
          stored.agent_id,
          JSON.stringify(latestMetrics),
          latest.collected_at,
          now.toISOString(),
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
          now.toISOString()
        )] : []),
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
          stored.agent_id,
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
          stored.agent_id
        ),
        ...(!contractMode ? [
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
          String(stored.agent_id),
          String(stored.agent_id),
          `report:${stored.report_id}`,
          now.toISOString(),
          now.toISOString(),
          stored.agent_id
        )] : []),
        this.env.DB.prepare(
          `UPDATE agent_reports SET status = 'processed', processed_at = ?,
             last_error = NULL, updated_at = ?
           WHERE report_id = ? AND status != 'processed'`
        ).bind(now.toISOString(), now.toISOString(), stored.report_id),
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO domain_outbox
           (event_id, event_type, aggregate_type, aggregate_id, payload_json,
            status, attempts, available_at, created_at, updated_at)
           VALUES (?, 'agent.report.processed', 'agent', ?, ?, 'pending', 0, ?, ?, ?)`
        ).bind(
          reportProcessedEventId,
          String(stored.agent_id),
          JSON.stringify({
            report_id: stored.report_id,
            agent_id: stored.agent_id,
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
          String(stored.agent_id),
          JSON.stringify({
            report_id: stored.report_id,
            agent_id: stored.agent_id,
            observed_at: latest.collected_at,
            ...observedMetrics,
          }),
          now.toISOString(),
          now.toISOString(),
          now.toISOString()
        ),
        this.env.DB.prepare(
          `UPDATE async_jobs SET status = 'completed', completed_at = ?,
             lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
           WHERE id = ? AND lease_token = ? AND status = 'processing'`
        ).bind(now.toISOString(), now.toISOString(), job.id, job.lease_token)
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
            String(stored.agent_id),
            JSON.stringify({
              report_id: stored.report_id,
              agent_id: stored.agent_id,
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
          stored.agent_id,
          latest.collected_at,
          latestMetrics
        );
      } catch (error) {
        writeStructuredLog(this.env, {
          service: "realtime",
          operation: "publish_latest_agent_metrics",
          result: "deferred",
          reportId: stored.report_id,
          jobId: job.id,
          entityType: "agent",
          entityId: stored.agent_id,
          errorCode: "AGENT_METRICS_BROADCAST_DEFERRED",
          error,
        });
      }

      for (const outboxEventId of outboxEventIds) {
        try {
          await this.queue.publishOutbox(outboxEventId);
          await this.env.DB.prepare(
            `UPDATE domain_outbox SET status = 'published', attempts = attempts + 1,
               published_at = ?, last_error = NULL, updated_at = ?
             WHERE event_id = ? AND status = 'pending'`
          )
            .bind(now.toISOString(), now.toISOString(), outboxEventId)
            .run();
        } catch (error) {
          writeStructuredLog(this.env, {
            service: "queue",
            operation: "publish_agent_report_outbox",
            result: "deferred",
            eventId: outboxEventId,
            reportId: stored.report_id,
            jobId: job.id,
            entityType: "agent",
            entityId: stored.agent_id,
            errorCode: "AGENT_REPORT_OUTBOX_PUBLISH_DEFERRED",
            error,
          });
        }
      }
      return { outcome: "completed" };
    } catch (error) {
      return this.finishFailure(job, error);
    }
  }
}

export function isJobQueueMessage(
  message: XugouQueueMessage
): message is Extract<XugouQueueMessage, { kind: "job" }> {
  return message.kind === "job";
}
