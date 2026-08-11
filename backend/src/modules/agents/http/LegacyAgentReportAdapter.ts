import type { AgentReportCommand, AgentReportSample } from "../domain/models";
import { sha256Hex } from "../../../utils/crypto";
import { agentV4ReportSchema } from "./schemas";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function finite(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : undefined;
}

function integer(value: unknown) {
  const number = finite(value);
  return number === undefined ? undefined : Math.round(number);
}

function text(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : undefined;
}

function metricMap(value: unknown) {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      result[key] = typeof item === "string" ? item.slice(0, 1024) : item;
    }
  }
  return result;
}

function timestamp(value: JsonRecord, fallback: string) {
  const raw =
    typeof value.ts === "number" && Number.isFinite(value.ts)
      ? value.ts
      : value.timestamp;
  const parsed = raw instanceof Date ? raw : new Date(raw as string | number);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function normalizeSample(value: unknown, fallback: string): AgentReportSample {
  const row = asRecord(value);
  const cpu = asRecord(row.cpu);
  const memory = asRecord(row.memory);
  const load = asRecord(row.load);
  const swap = asRecord(row.swap);
  const ping = Object.fromEntries(
    Object.entries(asRecord(row.ping)).map(([key, item]) => [key, metricMap(item)])
  );
  return {
    collected_at: timestamp(row, fallback),
    cpu:
      Object.keys(cpu).length > 0
        ? {
            usage: finite(cpu.usage, 0, 100),
            cores: integer(cpu.cores),
            model_name: text(cpu.model_name, 512),
          }
        : undefined,
    memory:
      Object.keys(memory).length > 0
        ? {
            total: finite(memory.total),
            used: finite(memory.used),
            free: finite(memory.free),
            usage_rate: finite(memory.usage_rate, 0, 100),
          }
        : undefined,
    load:
      Object.keys(load).length > 0
        ? {
            load1: finite(load.load1),
            load5: finite(load.load5),
            load15: finite(load.load15),
          }
        : undefined,
    disks: Array.isArray(row.disks) ? row.disks.slice(0, 128).map(metricMap) : undefined,
    network: Array.isArray(row.network)
      ? row.network.slice(0, 128).map(metricMap)
      : undefined,
    swap:
      row.swap === null
        ? null
        : Object.keys(swap).length > 0
          ? {
              total: finite(swap.total),
              used: finite(swap.used),
              usage_rate: finite(swap.usage_rate, 0, 100),
            }
          : undefined,
    process_count: integer(row.process_count),
    tcp_connections: integer(row.tcp_connections),
    udp_connections: integer(row.udp_connections),
    ping: Object.keys(ping).length > 0 ? ping : undefined,
    ipv4_reachable:
      typeof row.ipv4_reachable === "boolean" ? row.ipv4_reachable : undefined,
    ipv6_reachable:
      typeof row.ipv6_reachable === "boolean" ? row.ipv6_reachable : undefined,
  };
}

function uuidFromSha256(digest: string) {
  const chars = digest.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function positiveSeconds(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(86_400, Math.max(1, Math.round(number)))
    : fallback;
}

/**
 * 把 v1 宽松上报投影为 v4 持久化命令。稳定 ID 包含凭据摘要与
 * 规范化 Payload，同一时间窗口的 HTTP 重试会进入同一 Job Ledger。
 */
export async function adaptLegacyAgentReport(
  input: unknown,
  agentVersion?: string | null,
  now: Date = new Date()
): Promise<{ token: string; report: AgentReportCommand }> {
  const rows = Array.isArray(input) ? input.map(asRecord) : [asRecord(input)];
  const primary = rows[0] ?? {};
  const token = text(primary.token, 512);
  if (!token) throw new Error("Legacy Agent token is missing");

  const reportInterval = positiveSeconds(
    primary.report_interval_seconds,
    positiveSeconds(primary.keepalive, 60)
  );
  const fallbackTime = new Date(
    Math.floor(now.getTime() / (reportInterval * 1000)) * reportInterval * 1000
  ).toISOString();
  const nestedSamples = Array.isArray(primary.samples) ? primary.samples : null;
  const sourceSamples = nestedSamples && nestedSamples.length > 0 ? nestedSamples : rows;
  const samples = sourceSamples
    .slice(0, 100)
    .map((sample) => normalizeSample(sample, fallbackTime));

  const base = {
    protocol_version: 4 as const,
    agent_version: text(agentVersion, 128) ?? text(primary.version, 128),
    hostname: text(primary.hostname, 255) ?? null,
    ip_addresses: Array.isArray(primary.ip_addresses)
      ? primary.ip_addresses
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().slice(0, 128))
          .filter(Boolean)
          .slice(0, 64)
      : undefined,
    os: text(primary.os, 128) ?? null,
    version: text(primary.version, 128) ?? null,
    boot_time: integer(primary.boot_time) ?? null,
    keepalive_seconds: positiveSeconds(primary.keepalive, reportInterval),
    report_interval_seconds: reportInterval,
    samples,
  };
  const credentialDigest = await sha256Hex(token);
  const payloadDigest = await sha256Hex(
    JSON.stringify({ credential_digest: credentialDigest, report: base })
  );
  const report = agentV4ReportSchema.parse({
    ...base,
    report_id: uuidFromSha256(payloadDigest),
  });
  return { token, report };
}
