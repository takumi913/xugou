/**
 * 把解码后的块还原成按时间排列的样本序列。
 *
 * 摄入路径（流量记账、阈值判定、速率计算）与读路径（图表降采样）共用本层，
 * 避免"块 → 指标"的映射写两遍导致两处漂移。
 *
 * 还原出的是块内实际存在的点，缺失槽直接跳过——调用方拿到的序列长度
 * 等于 point_count 而非 slot_count。
 */

import type { DecodedBlock } from "./decode";
import {
  NET_FIELD_BYTES_RECV,
  NET_FIELD_BYTES_SENT,
  NET_FIELD_PACKETS_RECV,
  NET_FIELD_PACKETS_SENT,
  PING_FIELD_LATENCY_MS,
  PING_FIELD_LOSS,
  SERIES_CPU_USAGE,
  SERIES_IPV4_REACHABLE,
  SERIES_IPV6_REACHABLE,
  SERIES_LOAD1,
  SERIES_LOAD5,
  SERIES_LOAD15,
  SERIES_MEMORY_FREE,
  SERIES_MEMORY_USED,
  SERIES_PROCESS_COUNT,
  SERIES_SWAP_USED,
  SERIES_TCP_CONNECTIONS,
  SERIES_UDP_CONNECTIONS,
  diskSeriesId,
  netSeriesId,
  pingSeriesId,
} from "./registry";

export interface BlockDiskSample {
  mountPoint: string;
  total: number;
  used: number | null;
  /** 由 used/total 推导，total 为 0 时为 null。 */
  usageRate: number | null;
  free: number | null;
}

export interface BlockNetSample {
  iface: string;
  bytesSent: number | null;
  bytesRecv: number | null;
  packetsSent: number | null;
  packetsRecv: number | null;
}

export interface BlockPingSample {
  key: string;
  latencyMs: number | null;
  loss: boolean | null;
}

export interface BlockSample {
  /** epoch 毫秒，便于直接喂给现有基于 Date.parse 的逻辑。 */
  timestampMs: number;
  cpuUsage: number | null;
  memoryTotal: number;
  memoryUsed: number | null;
  memoryFree: number | null;
  memoryUsageRate: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  swapTotal: number;
  swapUsed: number | null;
  swapUsageRate: number | null;
  processCount: number | null;
  tcpConnections: number | null;
  udpConnections: number | null;
  ipv4Reachable: boolean | null;
  ipv6Reachable: boolean | null;
  disks: BlockDiskSample[];
  nets: BlockNetSample[];
  pings: BlockPingSample[];
}

function rate(used: number | null, total: number): number | null {
  if (used === null || !Number.isFinite(total) || total <= 0) return null;
  return (used / total) * 100;
}

function toBool(value: number | null): boolean | null {
  if (value === null) return null;
  return value !== 0;
}

/**
 * 还原块内的样本序列。
 *
 * `agg` 选择聚合位：1 秒块只有 0；1 分钟块可传 0=avg / 1=min / 2=max。
 * 超出 aggregateCount 时回退到 0。
 */
export function blockSamples(block: DecodedBlock, agg = 0): BlockSample[] {
  const slice = agg < block.aggregateCount ? agg : 0;

  const at = (seriesId: number, slot: number): number | null => {
    const aggs = block.series.get(seriesId);
    if (!aggs) return null;
    const values = aggs[slice];
    if (!values) return null;
    return values[slot] ?? null;
  };

  // 只要该槽有任意一个序列存在，就认为这个时间点存在
  const seriesList = [...block.series.values()];
  const out: BlockSample[] = [];

  for (let slot = 0; slot < block.slotCount; slot++) {
    let occupied = false;
    for (const aggs of seriesList) {
      const values = aggs[slice];
      if (values && values[slot] !== null && values[slot] !== undefined) {
        occupied = true;
        break;
      }
    }
    if (!occupied) continue;

    const memoryUsed = at(SERIES_MEMORY_USED, slot);
    const swapUsed = at(SERIES_SWAP_USED, slot);

    const disks: BlockDiskSample[] = block.dims.disks.map((disk, index) => {
      const used = at(diskSeriesId(index), slot);
      return {
        mountPoint: disk.name,
        total: disk.total,
        used,
        usageRate: rate(used, disk.total),
        free: used === null ? null : Math.max(0, disk.total - used),
      };
    });

    const nets: BlockNetSample[] = block.dims.nets.map((iface, index) => ({
      iface,
      bytesSent: at(netSeriesId(index, NET_FIELD_BYTES_SENT), slot),
      bytesRecv: at(netSeriesId(index, NET_FIELD_BYTES_RECV), slot),
      packetsSent: at(netSeriesId(index, NET_FIELD_PACKETS_SENT), slot),
      packetsRecv: at(netSeriesId(index, NET_FIELD_PACKETS_RECV), slot),
    }));

    const pings: BlockPingSample[] = block.dims.pings.map((key, index) => ({
      key,
      latencyMs: at(pingSeriesId(index, PING_FIELD_LATENCY_MS), slot),
      loss: toBool(at(pingSeriesId(index, PING_FIELD_LOSS), slot)),
    }));

    out.push({
      timestampMs: (block.bucketStart + slot * block.interval) * 1000,
      cpuUsage: at(SERIES_CPU_USAGE, slot),
      memoryTotal: block.memoryTotal,
      memoryUsed,
      memoryFree: at(SERIES_MEMORY_FREE, slot),
      memoryUsageRate: rate(memoryUsed, block.memoryTotal),
      load1: at(SERIES_LOAD1, slot),
      load5: at(SERIES_LOAD5, slot),
      load15: at(SERIES_LOAD15, slot),
      swapTotal: block.swapTotal,
      swapUsed,
      swapUsageRate: rate(swapUsed, block.swapTotal),
      processCount: at(SERIES_PROCESS_COUNT, slot),
      tcpConnections: at(SERIES_TCP_CONNECTIONS, slot),
      udpConnections: at(SERIES_UDP_CONNECTIONS, slot),
      ipv4Reachable: toBool(at(SERIES_IPV4_REACHABLE, slot)),
      ipv6Reachable: toBool(at(SERIES_IPV6_REACHABLE, slot)),
      disks,
      nets,
      pings,
    });
  }

  return out;
}

/** 网络计数器总和，用于流量记账。缺值的接口不参与求和。 */
export function sumNetTotals(sample: BlockSample): {
  rx: number | null;
  tx: number | null;
} {
  let rx: number | null = null;
  let tx: number | null = null;
  for (const net of sample.nets) {
    if (net.bytesRecv !== null) rx = (rx ?? 0) + net.bytesRecv;
    if (net.bytesSent !== null) tx = (tx ?? 0) + net.bytesSent;
  }
  return { rx, tx };
}

/** 块内某序列的最大值，用于阈值判定。 */
export function maxOf(
  samples: BlockSample[],
  pick: (sample: BlockSample) => number | null
): number | null {
  let best: number | null = null;
  for (const sample of samples) {
    const value = pick(sample);
    if (value === null || !Number.isFinite(value)) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

/** 所有磁盘里最高的使用率。 */
export function maxDiskUsageRate(sample: BlockSample): number | null {
  let best: number | null = null;
  for (const disk of sample.disks) {
    if (disk.usageRate === null) continue;
    if (best === null || disk.usageRate > best) best = disk.usageRate;
  }
  return best;
}
