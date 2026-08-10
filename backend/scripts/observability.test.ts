import assert from "node:assert/strict";
import type { Bindings } from "../src/models/db";
import {
  createTraceId,
  writeStructuredLog,
} from "../src/platform/observability/StructuredLogger";

const preferredHeaders = new Headers({
  "CF-Ray": "ray-fixture-SJC",
  "X-Request-ID": "request-fixture",
});
assert.equal(createTraceId(preferredHeaders), "ray-fixture-SJC");

const untrustedHeaders = new Headers({
  "X-Request-ID": "invalid request id with whitespace",
});
assert.match(createTraceId(untrustedHeaders), /^[0-9a-f-]{36}$/);

const originalLog = console.log;
const records: string[] = [];
console.log = (value?: unknown) => records.push(String(value));
try {
  writeStructuredLog(
    {
      CF_VERSION_METADATA: {
        id: "release-fixture",
        tag: "",
        timestamp: "2026-08-08T00:00:00.000Z",
      },
    } as Bindings,
    {
      service: "migration",
      operation: "fixture_backfill",
      result: "success",
      traceId: "trace-fixture",
      durationMs: 12.345,
      jobId: "job-fixture",
      fields: { rows_written: 2 },
    }
  );
} finally {
  console.log = originalLog;
}

assert.equal(records.length, 1);
const record = JSON.parse(records[0]) as Record<string, unknown>;
assert.equal(record.trace_id, "trace-fixture");
assert.equal(record.service, "migration");
assert.equal(record.operation, "fixture_backfill");
assert.equal(record.result, "success");
assert.equal(record.schema_version, "v2");
assert.equal(record.release_version, "release-fixture");
assert.equal(record.duration_ms, 12.35);
assert.equal(record.job_id, "job-fixture");
assert.equal(record.rows_written, 2);
