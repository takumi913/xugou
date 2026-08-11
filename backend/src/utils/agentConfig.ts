/**
 * 探针动态配置协议（服务端侧）
 *
 * 参照 CF-Server-Monitor/src/utils/agentConfig.js：
 * - 探针每次上报携带 X-Agent-Config-Schema: 2/3 与 X-Agent-Config-Md5（本地配置规范化串的 MD5）
 * - 服务端对该 agent 的 collect_interval/report_interval 生成规范化配置串并计算 MD5：
 *   一致返回 204 No Content；不一致返回 200 + application/x-www-form-urlencoded 配置串
 * - 协议刻意不含 secret/URL/命令类字段（无主控安全边界）
 *
 * MD5 用纯 TS 实现（Workers 的 crypto.subtle 支持 MD5 但 Node 测试环境不支持，
 * 纯函数实现保证两侧行为一致且可被合同测试覆盖）。
 */

import { bytesToHex } from "./hex";

// 协议版本：v3 在 v2 三键基础上引入 update 指令键（仅指令通道，不参与 MD5）。
// 服务端同时兼容 v2/v3 客户端：规范化串中的 schema_version 回填客户端声明的版本，
// 保证两端对同一字节串计算 MD5。
export const AGENT_CONFIG_SCHEMA_VERSION = 3;
export const AGENT_CONFIG_MIN_SCHEMA_VERSION = 2;
export const AGENT_CONFIG_SCHEMA_HEADER = "X-Agent-Config-Schema";
export const AGENT_CONFIG_MD5_HEADER = "X-Agent-Config-Md5";
export const AGENT_VERSION_HEADER = "X-Agent-Version";
// v3 起可附加到响应串末尾的升级指令（不落库、不进 MD5、客户端不持久化）
export const AGENT_CONFIG_UPDATE_DIRECTIVE = "update=1";

export const MIN_COLLECT_INTERVAL = 1;
export const MAX_COLLECT_INTERVAL = 3600;
export const MIN_REPORT_INTERVAL = 10;
export const MAX_REPORT_INTERVAL = 3600;

export const DEFAULT_COLLECT_INTERVAL = 1;
export const DEFAULT_REPORT_INTERVAL = 60;

// 单次上报最多承载/广播/缓存的样本条数（zod samples 上限、Agent Report Adapter 展开上限、
// realtime publisher 与 AgentRoom 批量上限的单一事实源）
export const MAX_REPORT_SAMPLES = 100;

export interface AgentIntervalConfig {
  collect_interval: number;
  report_interval: number;
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    return fallback;
  }
  return num;
}

/**
 * 从 agent 行读出并规范化间隔配置：越界/缺失回退默认值，且保证 report >= collect
 */
export function normalizeAgentIntervals(agent?: {
  collect_interval?: number | null;
  report_interval?: number | null;
}): AgentIntervalConfig {
  const collect = clampInt(
    agent?.collect_interval,
    MIN_COLLECT_INTERVAL,
    MAX_COLLECT_INTERVAL,
    DEFAULT_COLLECT_INTERVAL
  );
  let report = clampInt(
    agent?.report_interval,
    MIN_REPORT_INTERVAL,
    MAX_REPORT_INTERVAL,
    DEFAULT_REPORT_INTERVAL
  );
  if (report < collect) {
    // collect 已被 clamp 到 ≤ MAX_COLLECT_INTERVAL(=MAX_REPORT_INTERVAL)，结果必然合法
    report = Math.max(collect, DEFAULT_REPORT_INTERVAL);
  }
  return { collect_interval: collect, report_interval: report };
}

/**
 * 规范化客户端声明的协议版本头：仅接受 2 或 3，其余（含缺失）返回 null。
 */
export function normalizeAgentConfigSchema(value: unknown): number | null {
  const schema = Number(value);
  if (
    !Number.isInteger(schema) ||
    schema < AGENT_CONFIG_MIN_SCHEMA_VERSION ||
    schema > AGENT_CONFIG_SCHEMA_VERSION
  ) {
    return null;
  }
  return schema;
}

/**
 * 生成规范化配置串。键序、分隔符与 Go 客户端逐字节一致：
 * collect_interval=<n>&report_interval=<n>&schema_version=<v>
 *
 * schemaVersion 回填客户端声明的版本（2 或 3）：客户端本地按自身版本号算 MD5，
 * 服务端按同一版本号序列化，两端字节串一致；update 指令不进此串（MD5 对称性）。
 */
export function serializeAgentConfig(
  config: AgentIntervalConfig,
  schemaVersion: number = AGENT_CONFIG_MIN_SCHEMA_VERSION
): string {
  return (
    `collect_interval=${config.collect_interval}` +
    `&report_interval=${config.report_interval}` +
    `&schema_version=${schemaVersion}`
  );
}

/**
 * 语义化版本比较（支持 v 前缀与预发布后缀，如 v1.2.3-rc1）。
 * 返回 -1/0/1 表示 a 小于/等于/大于 b；任一版本无法解析时返回 null。
 * 与 Go 侧 selfmgmt.CompareVersions 语义一致（1.0.0 > 1.0.0-rc1）。
 */
export function compareSemver(a: string, b: string): number | null {
  const identifier = /^[0-9A-Za-z-]+$/;
  const parse = (v: string): { core: string[]; pre: string[] } | null => {
    const trimmed = v.trim().replace(/^[vV]/, "");
    if (!trimmed) return null;
    const buildParts = trimmed.split("+");
    if (buildParts.length > 2) return null;
    if (
      buildParts[1] !== undefined &&
      buildParts[1].split(".").some((item) => !identifier.test(item))
    ) {
      return null;
    }
    const dashIndex = buildParts[0].indexOf("-");
    const base = dashIndex < 0 ? buildParts[0] : buildParts[0].slice(0, dashIndex);
    const preValue = dashIndex < 0 ? undefined : buildParts[0].slice(dashIndex + 1);
    const core = base.split(".");
    if (
      core.length !== 3 ||
      core.some((item) => !/^(0|[1-9]\d*)$/.test(item))
    ) {
      return null;
    }
    const pre = preValue === undefined ? [] : preValue.split(".");
    if (
      pre.some(
        (item) =>
          !identifier.test(item) || (/^\d+$/.test(item) && !/^(0|[1-9]\d*)$/.test(item))
      )
    ) {
      return null;
    }
    return { core, pre };
  };

  const va = parse(a);
  const vb = parse(b);
  if (!va || !vb) return null;

  const compareNumeric = (left: string, right: string) =>
    left.length === right.length
      ? left === right
        ? 0
        : left < right
          ? -1
          : 1
      : left.length < right.length
        ? -1
        : 1;
  for (let i = 0; i < 3; i++) {
    const result = compareNumeric(va.core[i], vb.core[i]);
    if (result !== 0) return result;
  }
  if (va.pre.length === 0 && vb.pre.length === 0) return 0;
  if (va.pre.length === 0) return 1;
  if (vb.pre.length === 0) return -1;
  for (let i = 0; i < Math.min(va.pre.length, vb.pre.length); i++) {
    const leftNumeric = /^\d+$/.test(va.pre[i]);
    const rightNumeric = /^\d+$/.test(vb.pre[i]);
    if (leftNumeric && !rightNumeric) return -1;
    if (!leftNumeric && rightNumeric) return 1;
    let result: number;
    if (leftNumeric) {
      result = compareNumeric(va.pre[i], vb.pre[i]);
    } else {
      const leftNatural = /^(.+?)(\d+)$/.exec(va.pre[i]);
      const rightNatural = /^(.+?)(\d+)$/.exec(vb.pre[i]);
      result =
        leftNatural && rightNatural && leftNatural[1] === rightNatural[1]
          ? compareNumeric(
              leftNatural[2].replace(/^0+(?=\d)/, ""),
              rightNatural[2].replace(/^0+(?=\d)/, "")
            )
          : va.pre[i] === vb.pre[i]
            ? 0
            : va.pre[i] < vb.pre[i]
              ? -1
              : 1;
    }
    if (result !== 0) return result;
  }
  return va.pre.length === vb.pre.length ? 0 : va.pre.length < vb.pre.length ? -1 : 1;
}

/**
 * 是否应触发探针自升级：agent 开启 auto_update，且服务端配置了
 * LATEST_AGENT_VERSION，且客户端上报的 X-Agent-Version 语义化低于它。
 */
export function shouldTriggerAgentUpdate(
  autoUpdate: boolean,
  latestVersion: unknown,
  agentVersion: string | null | undefined
): boolean {
  if (!autoUpdate) return false;
  if (typeof latestVersion !== "string" || latestVersion.trim() === "") {
    return false;
  }
  if (typeof agentVersion !== "string" || agentVersion.trim() === "") {
    return false;
  }
  return compareSemver(agentVersion, latestVersion) === -1;
}

export interface AgentConfigDescriptor {
  config: AgentIntervalConfig;
  serialized: string;
  md5: string;
}

/**
 * 生成配置描述符：规范化配置 + 序列化串 + MD5（供上报响应协商使用）。
 * schemaVersion 取客户端声明的版本（默认 2 保持向下兼容）。
 */
export function describeAgentConfig(
  agent?: {
    collect_interval?: number | null;
    report_interval?: number | null;
  },
  schemaVersion: number = AGENT_CONFIG_MIN_SCHEMA_VERSION
): AgentConfigDescriptor {
  const config = normalizeAgentIntervals(agent);
  const serialized = serializeAgentConfig(config, schemaVersion);
  return { config, serialized, md5: md5Hex(serialized) };
}

// ---------------------------------------------------------------------------
// 纯 TS MD5 实现（RFC 1321），输入按 UTF-8 编码
// ---------------------------------------------------------------------------

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
  15, 21,
];

// K[i] = floor(2^32 * abs(sin(i + 1)))
const MD5_K = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
  }
  return k;
})();

function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

export function md5Hex(input: string): string {
  const message = new TextEncoder().encode(input);
  const bitLength = message.length * 8;

  // 填充：补 0x80，再补零到 56 mod 64，最后 8 字节为小端消息位长
  const paddedLength = (((message.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      m[i] = view.getUint32(offset + i * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const temp = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[i] + m[g]) >>> 0;
      b = (b + rotl(sum, MD5_SHIFTS[i])) >>> 0;
      a = temp;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);

  return bytesToHex(out);
}
