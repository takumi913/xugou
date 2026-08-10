import type { Bindings } from "../../models/db";
import { getEnvBoolean, getEnvNumber } from "../../utils/env";

type ArchiveDomain = "agent" | "monitor";

interface ArchiveSource {
  sourceKey: string;
  sourceParentKey: string;
  occurredAt: string;
  value: Record<string, unknown>;
}

interface AgentSampleRow {
  report_id: string;
  sample_index: number;
  agent_id: number;
  collected_at: string;
  metrics_json: string;
  created_at: string;
}

interface MonitorSampleRow {
  job_id: string;
  monitor_id: number;
  scheduled_for_ms: number;
  checked_at: string;
  status: string;
  response_time_ms: number;
  status_code: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RawSampleArchiveResult {
  domain: ArchiveDomain;
  archivedRows: number;
  batchId: string | null;
  objectKey: string | null;
  sha256: string | null;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MIN_AGE_DAYS = 1;
const DEFAULT_AGENT_RETENTION_DAYS = 30;
const DEFAULT_MONITOR_RETENTION_DAYS = 90;
const ARCHIVE_SCHEMA_VERSION = 1;

function cutoffIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function byteHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2048);
}

async function selectAgentSources(
  env: Pick<Bindings, "DB">,
  before: string,
  limit: number
): Promise<ArchiveSource[]> {
  const { results } = await env.DB.prepare(
    `SELECT sample.report_id, sample.sample_index, sample.agent_id,
            sample.collected_at, sample.metrics_json, sample.created_at
     FROM agent_report_samples sample
     LEFT JOIN raw_sample_archive_members member
       ON member.domain = 'agent'
      AND member.source_key = sample.report_id || '#' || sample.sample_index
     WHERE sample.collected_at < ? AND member.source_key IS NULL
     ORDER BY sample.collected_at, sample.report_id, sample.sample_index
     LIMIT ?`
  )
    .bind(before, limit)
    .all<AgentSampleRow>();

  return results.map((row) => ({
    sourceKey: `${row.report_id}#${row.sample_index}`,
    sourceParentKey: row.report_id,
    occurredAt: row.collected_at,
    value: {
      report_id: row.report_id,
      sample_index: row.sample_index,
      agent_id: row.agent_id,
      collected_at: row.collected_at,
      metrics_json: row.metrics_json,
      created_at: row.created_at,
    },
  }));
}

async function selectMonitorSources(
  env: Pick<Bindings, "DB">,
  before: string,
  limit: number
): Promise<ArchiveSource[]> {
  const { results } = await env.DB.prepare(
    `SELECT sample.job_id, sample.monitor_id, sample.scheduled_for_ms,
            sample.checked_at, sample.status, sample.response_time_ms,
            sample.status_code, sample.error, sample.created_at,
            sample.updated_at
     FROM monitor_check_samples sample
     LEFT JOIN raw_sample_archive_members member
       ON member.domain = 'monitor' AND member.source_key = sample.job_id
     WHERE sample.checked_at < ? AND member.source_key IS NULL
     ORDER BY sample.checked_at, sample.job_id
     LIMIT ?`
  )
    .bind(before, limit)
    .all<MonitorSampleRow>();

  return results.map((row) => ({
    sourceKey: row.job_id,
    sourceParentKey: row.job_id,
    occurredAt: row.checked_at,
    value: {
      job_id: row.job_id,
      monitor_id: row.monitor_id,
      scheduled_for_ms: row.scheduled_for_ms,
      checked_at: row.checked_at,
      status: row.status,
      response_time_ms: row.response_time_ms,
      status_code: row.status_code,
      error: row.error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  }));
}

function encodeJsonLines(domain: ArchiveDomain, sources: ArchiveSource[]): Uint8Array {
  const header = JSON.stringify({
    record_type: "xugou.raw-sample-archive",
    schema_version: ARCHIVE_SCHEMA_VERSION,
    domain,
  });
  const records = sources.map((source) =>
    JSON.stringify({
      record_type: "sample",
      schema_version: ARCHIVE_SCHEMA_VERSION,
      domain,
      source_key: source.sourceKey,
      value: source.value,
    })
  );
  return new TextEncoder().encode(`${[header, ...records].join("\n")}\n`);
}

async function markPending(
  env: Pick<Bindings, "DB">,
  input: {
    batchId: string;
    domain: ArchiveDomain;
    objectKey: string;
    sha256: string;
    size: number;
    sources: ArchiveSource[];
    nowIso: string;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO raw_sample_archive_batches
     (id, domain, object_key, content_sha256, object_size_bytes, source_rows,
      range_start, range_end, status, attempts, r2_version, r2_etag,
      verified_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, NULL, NULL,
             NULL, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = 'pending', attempts = attempts + 1, r2_version = NULL,
       r2_etag = NULL, verified_at = NULL, last_error = NULL,
       updated_at = excluded.updated_at
     WHERE raw_sample_archive_batches.status <> 'verified'`
  )
    .bind(
      input.batchId,
      input.domain,
      input.objectKey,
      input.sha256,
      input.size,
      input.sources.length,
      input.sources[0].occurredAt,
      input.sources[input.sources.length - 1].occurredAt,
      input.nowIso,
      input.nowIso
    )
    .run();
}

async function archiveDomain(
  env: Pick<Bindings, "DB" | "RAW_SAMPLE_ARCHIVE">,
  domain: ArchiveDomain,
  before: string,
  limit: number,
  now: Date
): Promise<RawSampleArchiveResult> {
  const sources =
    domain === "agent"
      ? await selectAgentSources(env, before, limit)
      : await selectMonitorSources(env, before, limit);
  if (sources.length === 0) {
    return {
      domain,
      archivedRows: 0,
      batchId: null,
      objectKey: null,
      sha256: null,
    };
  }

  const content = encodeJsonLines(domain, sources);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(content).buffer
  );
  const sha256 = byteHex(digest);
  const day = sources[0].occurredAt.slice(0, 10).replaceAll("-", "/");
  const objectKey = `raw-samples/v1/${domain}/${day}/${sha256}.jsonl`;
  const batchId = `${domain}:${sha256}`;
  const nowIso = now.toISOString();

  await markPending(env, {
    batchId,
    domain,
    objectKey,
    sha256,
    size: content.byteLength,
    sources,
    nowIso,
  });

  try {
    await env.RAW_SAMPLE_ARCHIVE.put(objectKey, content, {
      sha256: digest,
      httpMetadata: { contentType: "application/x-ndjson" },
      customMetadata: {
        schema: String(ARCHIVE_SCHEMA_VERSION),
        domain,
        sha256,
        sourceRows: String(sources.length),
      },
    });
    const stored = await env.RAW_SAMPLE_ARCHIVE.head(objectKey);
    const storedSha256 = stored?.checksums.sha256
      ? byteHex(stored.checksums.sha256)
      : null;
    if (
      !stored ||
      stored.size !== content.byteLength ||
      storedSha256 !== sha256 ||
      stored.customMetadata?.sha256 !== sha256 ||
      stored.customMetadata?.sourceRows !== String(sources.length)
    ) {
      throw new Error("R2 archive verification mismatch");
    }

    const statements = [
      env.DB.prepare(
        `UPDATE raw_sample_archive_batches
         SET status = 'verified', r2_version = ?, r2_etag = ?,
             verified_at = ?, last_error = NULL, updated_at = ?
         WHERE id = ? AND content_sha256 = ?`
      ).bind(stored.version, stored.etag, nowIso, nowIso, batchId, sha256),
      ...sources.map((source) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO raw_sample_archive_members
           (domain, source_key, source_parent_key, batch_id, archived_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(
          domain,
          source.sourceKey,
          source.sourceParentKey,
          batchId,
          nowIso
        )
      ),
    ];
    await env.DB.batch(statements);
  } catch (error) {
    await env.DB.prepare(
      `UPDATE raw_sample_archive_batches
       SET status = 'failed', last_error = ?, updated_at = ?
       WHERE id = ? AND status <> 'verified'`
    )
      .bind(errorMessage(error), nowIso, batchId)
      .run();
    throw error;
  }

  return {
    domain,
    archivedRows: sources.length,
    batchId,
    objectKey,
    sha256,
  };
}

export function shouldRunRawSampleArchive(now: Date): boolean {
  return now.getUTCMinutes() % 5 === 0;
}

export async function archiveRawSamples(
  env: Pick<Bindings, "DB" | "RAW_SAMPLE_ARCHIVE">,
  now = new Date()
): Promise<RawSampleArchiveResult[]> {
  const enabled = getEnvBoolean(env, "RAW_SAMPLE_ARCHIVE_ENABLED", true);
  if (!enabled) return [];
  const minAgeDays = getEnvNumber(
    env,
    "RAW_SAMPLE_ARCHIVE_MIN_AGE_DAYS",
    DEFAULT_MIN_AGE_DAYS,
    { min: 1, max: 365 }
  );
  const limit = getEnvNumber(
    env,
    "RAW_SAMPLE_ARCHIVE_BATCH_SIZE",
    DEFAULT_BATCH_SIZE,
    { min: 1, max: 90 }
  );
  const before = cutoffIso(now, minAgeDays);
  const results: RawSampleArchiveResult[] = [];
  for (const domain of ["agent", "monitor"] as const) {
    results.push(await archiveDomain(env, domain, before, limit, now));
  }
  return results;
}

export async function cleanupVerifiedRawSamples(
  env: Pick<Bindings, "DB"> &
    Partial<
      Pick<
        Bindings,
        | "RAW_SAMPLE_ARCHIVE_DELETE_ENABLED"
        | "AGENT_RAW_SAMPLE_RETENTION_DAYS"
        | "MONITOR_RAW_SAMPLE_RETENTION_DAYS"
      >
    >,
  now = new Date()
): Promise<{ agentRows: number; monitorRows: number; scrubbedReports: number }> {
  if (!getEnvBoolean(env, "RAW_SAMPLE_ARCHIVE_DELETE_ENABLED", false)) {
    return { agentRows: 0, monitorRows: 0, scrubbedReports: 0 };
  }
  const agentCutoff = cutoffIso(
    now,
    getEnvNumber(
      env,
      "AGENT_RAW_SAMPLE_RETENTION_DAYS",
      DEFAULT_AGENT_RETENTION_DAYS,
      { min: 1, max: 3650 }
    )
  );
  const monitorCutoff = cutoffIso(
    now,
    getEnvNumber(
      env,
      "MONITOR_RAW_SAMPLE_RETENTION_DAYS",
      DEFAULT_MONITOR_RETENTION_DAYS,
      { min: 1, max: 3650 }
    )
  );

  const agentDelete = await env.DB.prepare(
    `DELETE FROM agent_report_samples
     WHERE collected_at < ?
       AND EXISTS (
         SELECT 1 FROM raw_sample_archive_members member
         INNER JOIN raw_sample_archive_batches batch ON batch.id = member.batch_id
         WHERE member.domain = 'agent'
           AND member.source_key = agent_report_samples.report_id || '#' || agent_report_samples.sample_index
           AND batch.status = 'verified' AND batch.verified_at IS NOT NULL
       )`
  )
    .bind(agentCutoff)
    .run();
  const monitorDelete = await env.DB.prepare(
    `DELETE FROM monitor_check_samples
     WHERE checked_at < ?
       AND EXISTS (
         SELECT 1 FROM raw_sample_archive_members member
         INNER JOIN raw_sample_archive_batches batch ON batch.id = member.batch_id
         WHERE member.domain = 'monitor'
           AND member.source_key = monitor_check_samples.job_id
           AND batch.status = 'verified' AND batch.verified_at IS NOT NULL
       )`
  )
    .bind(monitorCutoff)
    .run();
  const scrubbed = await env.DB.prepare(
    `UPDATE agent_reports
     SET payload_json = '{}', updated_at = ?
     WHERE status = 'processed' AND received_at < ? AND payload_json <> '{}'
       AND NOT EXISTS (
         SELECT 1 FROM agent_report_samples sample
         WHERE sample.report_id = agent_reports.report_id
       )
       AND sample_count <= (
         SELECT count(*) FROM raw_sample_archive_members member
         INNER JOIN raw_sample_archive_batches batch ON batch.id = member.batch_id
         WHERE member.domain = 'agent'
           AND member.source_parent_key = agent_reports.report_id
           AND batch.status = 'verified' AND batch.verified_at IS NOT NULL
       )`
  )
    .bind(now.toISOString(), agentCutoff)
    .run();

  return {
    agentRows: Number(agentDelete.meta.changes ?? 0),
    monitorRows: Number(monitorDelete.meta.changes ?? 0),
    scrubbedReports: Number(scrubbed.meta.changes ?? 0),
  };
}
