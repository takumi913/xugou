import type { Bindings } from "../../models/db";

type ArchiveDomain = "agent" | "monitor";

interface ArchiveBatchRow {
  id: string;
  domain: ArchiveDomain;
  object_key: string;
  content_sha256: string;
  object_size_bytes: number;
  source_rows: number;
  status: string;
  verified_at: string | null;
}

interface ArchiveRecord {
  record_type: "sample";
  schema_version: 1;
  domain: ArchiveDomain;
  source_key: string;
  value: Record<string, unknown>;
}

export interface RawSampleRestoreResult {
  batchId: string;
  domain: ArchiveDomain;
  sourceRows: number;
  insertedRows: number;
  deduplicatedRows: number;
}

function byteHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function recordValue(
  value: unknown,
  domain: ArchiveDomain
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Raw sample ${domain} archive value is invalid`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`Raw sample archive field ${key} is invalid`);
  }
  return field;
}

function integerField(
  value: Record<string, unknown>,
  key: string,
  minimum = 0
) {
  const field = value[key];
  if (!Number.isSafeInteger(field) || Number(field) < minimum) {
    throw new Error(`Raw sample archive field ${key} is invalid`);
  }
  return Number(field);
}

function nullableIntegerField(value: Record<string, unknown>, key: string) {
  return value[key] === null ? null : integerField(value, key, 0);
}

function nullableStringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== "string") {
    throw new Error(`Raw sample archive field ${key} is invalid`);
  }
  return field;
}

function parseRecords(bytes: Uint8Array, batch: ArchiveBatchRow) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text.endsWith("\n")
    ? text.slice(0, -1).split("\n")
    : text.split("\n");
  if (lines.length < 1 || lines.some((line) => line.length === 0)) {
    throw new Error("Raw sample archive JSONL framing is invalid");
  }
  const values = lines.map((line) => JSON.parse(line) as unknown);
  const header = values[0];
  if (
    !header ||
    typeof header !== "object" ||
    Array.isArray(header) ||
    (header as Record<string, unknown>).record_type !==
      "xugou.raw-sample-archive" ||
    (header as Record<string, unknown>).schema_version !== 1 ||
    (header as Record<string, unknown>).domain !== batch.domain
  ) {
    throw new Error("Raw sample archive header is invalid");
  }
  const records = values.slice(1).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Raw sample archive record is invalid");
    }
    const record = value as Partial<ArchiveRecord>;
    if (
      record.record_type !== "sample" ||
      record.schema_version !== 1 ||
      record.domain !== batch.domain ||
      typeof record.source_key !== "string" ||
      record.source_key.length === 0
    ) {
      throw new Error("Raw sample archive record metadata is invalid");
    }
    return {
      ...record,
      value: recordValue(record.value, batch.domain),
    } as ArchiveRecord;
  });
  if (records.length !== batch.source_rows) {
    throw new Error("Raw sample archive source row count mismatch");
  }
  if (new Set(records.map((record) => record.source_key)).size !== records.length) {
    throw new Error("Raw sample archive contains duplicate source keys");
  }
  return records;
}

function restoreStatement(
  env: Pick<Bindings, "DB">,
  domain: ArchiveDomain,
  record: ArchiveRecord
) {
  const value = record.value;
  if (domain === "agent") {
    const reportId = stringField(value, "report_id");
    const sampleIndex = integerField(value, "sample_index");
    if (record.source_key !== `${reportId}#${sampleIndex}`) {
      throw new Error("Raw Agent sample source key mismatch");
    }
    const metricsJson = stringField(value, "metrics_json");
    JSON.parse(metricsJson);
    return env.DB.prepare(
      `INSERT OR IGNORE INTO agent_report_samples
       (report_id, sample_index, agent_id, collected_at, metrics_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      reportId,
      sampleIndex,
      integerField(value, "agent_id", 1),
      stringField(value, "collected_at"),
      metricsJson,
      stringField(value, "created_at")
    );
  }
  const jobId = stringField(value, "job_id");
  if (record.source_key !== jobId) {
    throw new Error("Raw Monitor sample source key mismatch");
  }
  return env.DB.prepare(
    `INSERT OR IGNORE INTO monitor_check_samples
     (job_id, monitor_id, scheduled_for_ms, checked_at, status,
      response_time_ms, status_code, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    jobId,
    integerField(value, "monitor_id", 1),
    integerField(value, "scheduled_for_ms"),
    stringField(value, "checked_at"),
    stringField(value, "status"),
    integerField(value, "response_time_ms"),
    nullableIntegerField(value, "status_code"),
    nullableStringField(value, "error"),
    stringField(value, "created_at"),
    stringField(value, "updated_at")
  );
}

export async function restoreVerifiedRawSampleBatch(
  env: Pick<Bindings, "DB" | "RAW_SAMPLE_ARCHIVE">,
  batchId: string
): Promise<RawSampleRestoreResult> {
  const batch = await env.DB.prepare(
    `SELECT id, domain, object_key, content_sha256, object_size_bytes,
            source_rows, status, verified_at
     FROM raw_sample_archive_batches WHERE id = ? LIMIT 1`
  )
    .bind(batchId)
    .first<ArchiveBatchRow>();
  if (!batch || batch.status !== "verified" || !batch.verified_at) {
    throw new Error("Raw sample archive batch is not verified");
  }
  if (
    (batch.domain !== "agent" && batch.domain !== "monitor") ||
    !/^[a-f0-9]{64}$/.test(batch.content_sha256) ||
    !Number.isSafeInteger(batch.object_size_bytes) ||
    batch.object_size_bytes <= 0 ||
    !Number.isSafeInteger(batch.source_rows) ||
    batch.source_rows <= 0 ||
    batch.source_rows > 90
  ) {
    throw new Error("Raw sample archive batch evidence is invalid");
  }
  const object = await env.RAW_SAMPLE_ARCHIVE.get(batch.object_key);
  if (!object) throw new Error("Raw sample archive object is missing");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = byteHex(digest);
  const storedSha256 = object.checksums.sha256
    ? byteHex(object.checksums.sha256)
    : null;
  if (
    bytes.byteLength !== batch.object_size_bytes ||
    object.size !== batch.object_size_bytes ||
    sha256 !== batch.content_sha256 ||
    storedSha256 !== batch.content_sha256 ||
    object.customMetadata?.sha256 !== batch.content_sha256 ||
    object.customMetadata?.sourceRows !== String(batch.source_rows)
  ) {
    throw new Error("Raw sample archive object verification mismatch");
  }
  const records = parseRecords(bytes, batch);
  const members = await env.DB.prepare(
    `SELECT domain, source_key FROM raw_sample_archive_members
     WHERE batch_id = ? ORDER BY domain, source_key`
  )
    .bind(batch.id)
    .all<{ domain: string; source_key: string }>();
  const memberKeys = members.results.map(
    (member) => `${member.domain}:${member.source_key}`
  );
  const recordKeys = records
    .map((record) => `${record.domain}:${record.source_key}`)
    .sort();
  if (
    memberKeys.length !== recordKeys.length ||
    memberKeys.some((key, index) => key !== recordKeys[index])
  ) {
    throw new Error("Raw sample archive member ledger mismatch");
  }
  const results = await env.DB.batch(
    records.map((record) => restoreStatement(env, batch.domain, record))
  );
  const insertedRows = results.reduce(
    (total, result) => total + Number(result.meta.changes ?? 0),
    0
  );
  return {
    batchId: batch.id,
    domain: batch.domain,
    sourceRows: records.length,
    insertedRows,
    deduplicatedRows: records.length - insertedRows,
  };
}
