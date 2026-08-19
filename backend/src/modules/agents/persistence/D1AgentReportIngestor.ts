import type { Bindings } from "../../../models/db";
import { writeStructuredLog } from "../../../platform/observability/StructuredLogger";
import {
  computeTraffic,
  getTrafficPeriodStart,
  normalizeTrafficResetDay,
  parseTrafficBaselines,
} from "../../../utils/traffic";
import type { AgentReportCommand } from "../domain/models";
import { publishLatestMetrics } from "../realtime/MetricsBroadcastPublisher";
import {
  normalizeAgentCountry,
  normalizeAgentGeo,
  type AgentReportSourceLocation,
} from "../../../utils/geo";
import { requestStatusRebuild } from "../../status/persistence/status-events";
import {
  base64ByteLength,
  base64ToBytes,
  decodeBlockBase64,
  MetricBlockError,
  type DecodedBlock,
} from "../metricblock/decode";
import {
  blockSamples,
  maxDiskUsageRate,
  maxOf,
  type BlockSample,
} from "../metricblock/materialize";

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
  traffic_baselines_json: string | null;
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

/** 摄入期块校验失败。调用方据此返回 422 而不是 5xx —— 这是客户端的问题。 */
export class AgentBlockRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentBlockRejected";
  }
}

function boolToInt(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

/**
 * 把 1 秒块还原成按时间升序的样本序列。
 * 聚合块（resolution=60）只做存储，不参与派生指标计算 —— 它的值是聚合过的，
 * 拿去算流量差分会重复计数。
 */
function materializeHotSamples(
  decoded: Array<{ resolution: number; block: DecodedBlock }>
): BlockSample[] {
  const samples: BlockSample[] = [];
  for (const entry of decoded) {
    if (entry.resolution !== 1) continue;
    samples.push(...blockSamples(entry.block));
  }
  samples.sort((left, right) => left.timestampMs - right.timestampMs);
  return samples;
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
 * Agent 每 60 秒通过 HTTP 提交一批列式压缩的指标块并直接落入 D1。
 * Queue 只接收状态变化或阈值越界事件。
 *
 * 块按 (agent_id, resolution, bucket_start) 幂等 upsert，重传无副作用，
 * 因此 v5 不再需要 v4 那套 agent_reports 去重表和 pending/processed/failed 状态机。
 */
export class D1AgentReportIngestor {
  constructor(private readonly env: Bindings) {}

  /**
   * 解码并校验上报体里的全部块。
   *
   * 写库之前先解码有两个作用：坏块直接拒收而不是先落库再发现；
   * 以及确认信封里的 resolution/bucket_start/point_count 与块头自述一致 ——
   * 不一致说明客户端有 bug 或在伪造，这类请求不该污染存储。
   */
  private async decodeBlocks(report: AgentReportCommand) {
    const decoded: Array<{ resolution: number; block: DecodedBlock }> = [];
    for (const block of report.blocks) {
      let parsed: DecodedBlock;
      try {
        parsed = await decodeBlockBase64(block.data);
      } catch (error) {
        const detail =
          error instanceof MetricBlockError ? error.message : String(error);
        throw new AgentBlockRejected(
          `块 (resolution=${block.resolution}, bucket_start=${block.bucket_start}) 解码失败: ${detail}`
        );
      }
      if (parsed.interval !== block.resolution) {
        throw new AgentBlockRejected(
          `块头 interval=${parsed.interval} 与信封 resolution=${block.resolution} 不一致`
        );
      }
      if (parsed.bucketStart !== block.bucket_start) {
        throw new AgentBlockRejected(
          `块头 bucket_start=${parsed.bucketStart} 与信封 ${block.bucket_start} 不一致`
        );
      }
      const actualPoints = blockSamples(parsed).length;
      if (actualPoints !== block.point_count) {
        throw new AgentBlockRejected(
          `块内实际点数 ${actualPoints} 与信封 point_count=${block.point_count} 不一致`
        );
      }
      decoded.push({ resolution: block.resolution, block: parsed });
    }
    return decoded;
  }

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

    // v5 去重不再依赖 agent_reports 状态机：块按
    // (agent_id, resolution, bucket_start) upsert，重传天然幂等，
    // 更短的块还会被单调守卫挡住。
    //
    // 解码放在写库之前：坏块直接拒收而不是先落库再发现，
    // 摄入路径顺带承担了块合法性校验。
    const decodedBlocks = await this.decodeBlocks(report);
    const samples = materializeHotSamples(decodedBlocks);

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
                traffic_baselines_json,
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

    // 派生指标全部来自解块后的样本序列：块里是完整的 1 秒精度数据，
    // 比只看 report.latest 更准（月流量靠计数器差分累加，阈值取窗口内峰值）。
    const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;
    const latestCollectedAtMs = lastSample
      ? lastSample.timestampMs
      : Date.parse(report.latest?.collected_at ?? nowIso);
    const latestCollectedAtIso = new Date(latestCollectedAtMs).toISOString();

    const traffic = computeTraffic(
      storedTraffic
        ? {
            month_rx: Number(storedTraffic.month_rx ?? 0),
            month_tx: Number(storedTraffic.month_tx ?? 0),
            baselines: parseTrafficBaselines(storedTraffic.traffic_baselines_json),
            last_total_rx: storedTraffic.last_total_rx,
            last_total_tx: storedTraffic.last_total_tx,
            month_reset_at: storedTraffic.month_reset_at,
            last_ts: storedTraffic.collected_at
              ? Date.parse(storedTraffic.collected_at)
              : null,
          }
        : null,
      // 逐网卡喂给累计器：接口名必须带上，否则无法分辨「某块网卡计数器归零」
      // 和「某块网卡从统计里消失」——后者按总和差分会凭空多记一整个总量。
      samples.map((sample) => ({
        ts: sample.timestampMs,
        interfaces: sample.nets.map((net) => ({
          name: net.iface,
          rx: net.bytesRecv,
          tx: net.bytesSent,
        })),
      })),
      getTrafficPeriodStart(
        new Date(latestCollectedAtMs),
        normalizeTrafficResetDay(agentState.traffic_reset_day)
      )
    );
    // samples 已按时间升序，speeds 与之一一对应，取最后一条即当前速率
    const latestSpeed =
      traffic.speeds.length > 0
        ? traffic.speeds[traffic.speeds.length - 1]
        : undefined;

    const observedMetrics = {
      cpu: maxOf(samples, (sample) => sample.cpuUsage),
      memory: maxOf(samples, (sample) => sample.memoryUsageRate),
      disk: maxOf(samples, maxDiskUsageRate),
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
    // agent_current_metrics 的快照来自 report.latest —— 它保留了不入块的静态
    // 元数据（CPU 型号、设备名、fs_type、ping target），块里没有这些。
    // 缺 latest 时退化到块内最后一个点，静态字段留空。
    const latest = report.latest;
    const latestMetrics = {
      agent_id: agentId,
      timestamp: latestCollectedAtIso,
      cpu_usage: latest?.cpu?.usage ?? lastSample?.cpuUsage ?? null,
      cpu_cores: latest?.cpu?.cores ?? null,
      cpu_model: latest?.cpu?.model_name ?? null,
      memory_total: latest?.memory?.total ?? lastSample?.memoryTotal ?? null,
      memory_used: latest?.memory?.used ?? lastSample?.memoryUsed ?? null,
      memory_free: latest?.memory?.free ?? lastSample?.memoryFree ?? null,
      memory_usage_rate:
        latest?.memory?.usage_rate ?? lastSample?.memoryUsageRate ?? null,
      load_1: latest?.load?.load1 ?? lastSample?.load1 ?? null,
      load_5: latest?.load?.load5 ?? lastSample?.load5 ?? null,
      load_15: latest?.load?.load15 ?? lastSample?.load15 ?? null,
      disk_metrics: JSON.stringify(latest?.disks ?? []),
      network_metrics: JSON.stringify(latest?.network ?? []),
      swap_total: latest?.swap?.total ?? lastSample?.swapTotal ?? null,
      swap_used: latest?.swap?.used ?? lastSample?.swapUsed ?? null,
      process_count: latest?.process_count ?? lastSample?.processCount ?? null,
      tcp_connections:
        latest?.tcp_connections ?? lastSample?.tcpConnections ?? null,
      udp_connections:
        latest?.udp_connections ?? lastSample?.udpConnections ?? null,
      ping_json: latest?.ping ? JSON.stringify(latest.ping) : null,
      ipv4_reachable: boolToInt(
        latest?.ipv4_reachable ?? lastSample?.ipv4Reachable ?? null
      ),
      ipv6_reachable: boolToInt(
        latest?.ipv6_reachable ?? lastSample?.ipv6Reachable ?? null
      ),
      network_rx_speed: latestSpeed?.rx ?? null,
      network_tx_speed: latestSpeed?.tx ?? null,
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
      // 块 upsert：幂等（重传同一块结果一致）且单调（更短的块不覆盖更完整的）。
      // 这两条性质替代了 v4 的 agent_reports 去重表与状态机。
      ...report.blocks.map((block) =>
        this.env.DB.prepare(
          `INSERT INTO agent_metric_blocks
           (agent_id, resolution, bucket_start, point_count, codec, byte_size, data)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, resolution, bucket_start) DO UPDATE SET
             point_count = excluded.point_count,
             byte_size   = excluded.byte_size,
             data        = excluded.data
           WHERE excluded.point_count >= agent_metric_blocks.point_count`
        ).bind(
          agentId,
          block.resolution,
          block.bucket_start,
          block.point_count,
          block.codec,
          base64ByteLength(block.data),
          base64ToBytes(block.data)
        )
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
          traffic_baselines_json,
          traffic_period_start, version, created_at_ms, updated_at_ms)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?
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
           traffic_baselines_json = excluded.traffic_baselines_json,
           traffic_period_start = excluded.traffic_period_start,
           version = agent_current_metrics.version + 1,
           updated_at_ms = excluded.updated_at_ms
         WHERE excluded.collected_at_ms >=
               COALESCE(agent_current_metrics.collected_at_ms, -1)`
      ).bind(
        agentId,
        JSON.stringify(latestMetrics),
        latestCollectedAtMs,
        nowMs,
        latestMetrics.cpu_usage,
        latestMetrics.memory_usage_rate,
        observedMetrics.disk,
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
        traffic.state.baselines
          ? JSON.stringify(traffic.state.baselines)
          : null,
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
            observed_at: latestCollectedAtIso,
            ...observedMetrics,
          }),
          nowIso,
          nowIso,
          nowIso
        )
      );
    }

    // v5 没有 agent_reports 状态机可写：批次失败就整体抛出，
    // Agent 侧不会 Ack，下一轮用同一个 report_id 原样重发。
    await this.env.DB.batch(statements);

    try {
      await publishLatestMetrics(
        this.env,
        agentId,
        latestCollectedAtIso,
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
