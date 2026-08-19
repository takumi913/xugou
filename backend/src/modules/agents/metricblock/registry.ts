/**
 * 指标块序列注册表（codec v1）。
 *
 * 本文件必须与 `agent/pkg/metricblock/registry.go` 逐字节一致 ——
 * 任何一侧改动都要同步另一侧，否则解码出的数值会静默错位。
 * 跨语言往返测试（metricblock.test.ts）用 Go 生成的 fixture 守住这条约束。
 */

export const MAGIC = 0xb1;
export const CODEC_VERSION = 1;

/** 头部固定 32 字节：前 16 字节标量字段 + memory_total(16..23) + swap_total(24..31)。 */
export const HEADER_SIZE = 32;

export const FLAG_GZIP = 0x01;
export const FLAG_PRESENCE = 0x02;

export const MAX_SERIES_COUNT = 512;
export const MAX_POINT_COUNT = 3600;
export const MAX_DIM_ENTRIES = 64;
export const MAX_DECOMPRESSED_BYTES = 1 << 20;

export const ENCODING_DELTA = 0;
export const ENCODING_DELTA_OF_DELTA = 1;
export const ENCODING_RAW = 2;

/** 标量序列 ID（1–99）。 */
export const SERIES_CPU_USAGE = 1;
export const SERIES_MEMORY_USED = 2;
export const SERIES_MEMORY_FREE = 3;
export const SERIES_LOAD1 = 4;
export const SERIES_LOAD5 = 5;
export const SERIES_LOAD15 = 6;
export const SERIES_SWAP_USED = 7;
export const SERIES_PROCESS_COUNT = 8;
export const SERIES_TCP_CONNECTIONS = 9;
export const SERIES_UDP_CONNECTIONS = 10;
export const SERIES_IPV4_REACHABLE = 11;
export const SERIES_IPV6_REACHABLE = 12;

/** 按实例的序列 ID 基址。slot 由 DimHeader 的出现顺序决定（0-based）。 */
export const SERIES_DISK_BASE = 100;
export const SERIES_NET_BASE = 200;
export const SERIES_PING_BASE = 500;

export const NET_FIELD_BYTES_SENT = 0;
export const NET_FIELD_BYTES_RECV = 1;
export const NET_FIELD_PACKETS_SENT = 2;
export const NET_FIELD_PACKETS_RECV = 3;

export const PING_FIELD_LATENCY_MS = 0;
export const PING_FIELD_LOSS = 1;

const SERIES_DISK_MAX = SERIES_DISK_BASE + MAX_DIM_ENTRIES - 1; // 163
const SERIES_NET_MAX = SERIES_NET_BASE + MAX_DIM_ENTRIES * 4 - 1; // 455
const SERIES_PING_MAX = SERIES_PING_BASE + MAX_DIM_ENTRIES * 2 - 1; // 627

export interface SeriesSpec {
  encoding: number;
  scale: number;
}

const SCALAR_SPECS = new Map<number, SeriesSpec>([
  [SERIES_CPU_USAGE, { encoding: ENCODING_DELTA, scale: 2 }],
  [SERIES_MEMORY_USED, { encoding: ENCODING_DELTA, scale: 0 }],
  [SERIES_MEMORY_FREE, { encoding: ENCODING_DELTA, scale: 0 }],
  [SERIES_LOAD1, { encoding: ENCODING_DELTA, scale: 2 }],
  [SERIES_LOAD5, { encoding: ENCODING_DELTA, scale: 2 }],
  [SERIES_LOAD15, { encoding: ENCODING_DELTA, scale: 2 }],
  [SERIES_SWAP_USED, { encoding: ENCODING_DELTA, scale: 0 }],
  [SERIES_PROCESS_COUNT, { encoding: ENCODING_DELTA, scale: 0 }],
  [SERIES_TCP_CONNECTIONS, { encoding: ENCODING_DELTA, scale: 0 }],
  [SERIES_UDP_CONNECTIONS, { encoding: ENCODING_DELTA, scale: 0 }],
  [SERIES_IPV4_REACHABLE, { encoding: ENCODING_RAW, scale: 0 }],
  [SERIES_IPV6_REACHABLE, { encoding: ENCODING_RAW, scale: 0 }],
]);

/**
 * 返回序列 ID 对应的编码规格，非法 ID 返回 null。
 *
 * 1 分钟聚合块里同一个 series_id 承载 avg/min/max 三个值，共用同一份规格 ——
 * 聚合既不改变量纲也不改变编码方式。
 */
export function specFor(id: number): SeriesSpec | null {
  const scalar = SCALAR_SPECS.get(id);
  if (scalar) return scalar;
  if (id >= SERIES_DISK_BASE && id <= SERIES_DISK_MAX) {
    return { encoding: ENCODING_DELTA, scale: 0 };
  }
  if (id >= SERIES_NET_BASE && id <= SERIES_NET_MAX) {
    return { encoding: ENCODING_DELTA_OF_DELTA, scale: 0 };
  }
  if (id >= SERIES_PING_BASE && id <= SERIES_PING_MAX) {
    if ((id - SERIES_PING_BASE) % 2 === PING_FIELD_LOSS) {
      return { encoding: ENCODING_RAW, scale: 0 };
    }
    return { encoding: ENCODING_DELTA, scale: 3 };
  }
  return null;
}

export function diskSeriesId(slot: number): number {
  return SERIES_DISK_BASE + slot;
}

export function netSeriesId(slot: number, field: number): number {
  return SERIES_NET_BASE + slot * 4 + field;
}

export function pingSeriesId(slot: number, field: number): number {
  return SERIES_PING_BASE + slot * 2 + field;
}
