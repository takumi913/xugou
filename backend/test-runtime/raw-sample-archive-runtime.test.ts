import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { Bindings } from "../src/models/db";
import {
  archiveRawSamples,
  cleanupVerifiedRawSamples,
} from "../src/platform/archive/RawSampleArchive";
import { restoreVerifiedRawSampleBatch } from "../src/platform/archive/RawSampleRestore";

const oldTimestamp = "2020-01-02T03:04:05.000Z";
const archiveNow = new Date("2026-08-09T08:00:00.000Z");

describe("verified raw sample R2 archive", () => {
  it("writes checksum evidence before allowing old source rows to be deleted", async () => {
    const agentId = 99501;
    const monitorId = 99502;
    const reportId = "955592a6-9234-4e21-b8e1-60ea206fcd85";
    const monitorJobId = "runtime-archive-monitor-99502";

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agents(id, name, token, status, created_at, updated_at)
         VALUES (?, 'archive-agent', 'archive-agent-token', 'inactive', ?, ?)`
      ).bind(agentId, oldTimestamp, oldTimestamp),
      env.DB.prepare(
        `INSERT INTO monitors
         (id, name, url, method, interval, timeout, timeout_ms, expected_status,
          headers, active, status, next_check_at, created_at, updated_at)
         VALUES (?, 'archive-monitor', 'https://archive.example.test', 'GET',
          300, 30, 30000, 200, '{}', 1, 'up', ?, ?, ?)`
      ).bind(monitorId, oldTimestamp, oldTimestamp, oldTimestamp),
      env.DB.prepare(
        `INSERT INTO agent_reports
         (report_id, agent_id, payload_digest, payload_json, sample_count,
          status, received_at, processed_at, created_at, updated_at)
         VALUES (?, ?, 'archive-digest', ?, 1, 'processed', ?, ?, ?, ?)`
      ).bind(
        reportId,
        agentId,
        JSON.stringify({ samples: [{ cpu_usage: 12 }] }),
        oldTimestamp,
        oldTimestamp,
        oldTimestamp,
        oldTimestamp
      ),
      env.DB.prepare(
        `INSERT INTO agent_report_samples
         (report_id, sample_index, agent_id, collected_at, metrics_json, created_at)
         VALUES (?, 0, ?, ?, ?, ?)`
      ).bind(
        reportId,
        agentId,
        oldTimestamp,
        JSON.stringify({ cpu_usage: 12 }),
        oldTimestamp
      ),
      env.DB.prepare(
        `INSERT INTO monitor_check_samples
         (job_id, monitor_id, scheduled_for_ms, checked_at, status,
          response_time_ms, status_code, error, created_at, updated_at)
         VALUES (?, ?, 1577934245000, ?, 'up', 123, 200, NULL, ?, ?)`
      ).bind(
        monitorJobId,
        monitorId,
        oldTimestamp,
        oldTimestamp,
        oldTimestamp
      ),
    ]);

    const results = await archiveRawSamples(env as Bindings, archiveNow);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.archivedRows)).toEqual([1, 1]);

    for (const result of results) {
      expect(result.objectKey).toBeTruthy();
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      const object = await env.RAW_SAMPLE_ARCHIVE.get(result.objectKey!);
      expect(object).not.toBeNull();
      const body = await object!.text();
      const records = body.trim().split("\n").map((line) => JSON.parse(line));
      expect(records[0]).toMatchObject({
        record_type: "xugou.raw-sample-archive",
        schema_version: 1,
        domain: result.domain,
      });
      expect(records[1]).toMatchObject({
        record_type: "sample",
        domain: result.domain,
      });

      const ledger = await env.DB.prepare(
        `SELECT status, content_sha256, object_size_bytes, source_rows,
                r2_etag, verified_at
         FROM raw_sample_archive_batches WHERE id = ?`
      )
        .bind(result.batchId)
        .first<{
          status: string;
          content_sha256: string;
          object_size_bytes: number;
          source_rows: number;
          r2_etag: string | null;
          verified_at: string | null;
        }>();
      expect(ledger).toMatchObject({
        status: "verified",
        content_sha256: result.sha256,
        source_rows: 1,
      });
      expect(ledger?.object_size_bytes).toBe(new TextEncoder().encode(body).byteLength);
      expect(ledger?.r2_etag).toBeTruthy();
      expect(ledger?.verified_at).toBe(archiveNow.toISOString());
    }

    const unverifiedJobId = "runtime-unverified-monitor-99502";
    await env.DB.prepare(
      `INSERT INTO monitor_check_samples
       (job_id, monitor_id, scheduled_for_ms, checked_at, status,
        response_time_ms, status_code, error, created_at, updated_at)
       VALUES (?, ?, 1577934246000, ?, 'down', 5000, NULL, 'timeout', ?, ?)`
    )
      .bind(
        unverifiedJobId,
        monitorId,
        oldTimestamp,
        oldTimestamp,
        oldTimestamp
      )
      .run();

    // Expand/observation defaults to archive-only so an older Worker can still
    // read the original D1 samples during the rollback window.
    const disabledCleanup = await cleanupVerifiedRawSamples(
      env as Bindings,
      archiveNow
    );
    expect(disabledCleanup).toEqual({
      agentRows: 0,
      monitorRows: 0,
      scrubbedReports: 0,
    });
    const preservedSamples = await env.DB.prepare(
      `SELECT
         (SELECT count(*) FROM agent_report_samples WHERE report_id = ?) AS agent_count,
         (SELECT count(*) FROM monitor_check_samples WHERE job_id = ?) AS monitor_count`
    )
      .bind(reportId, monitorJobId)
      .first<{ agent_count: number; monitor_count: number }>();
    expect(preservedSamples).toEqual({ agent_count: 1, monitor_count: 1 });

    const cleanup = await cleanupVerifiedRawSamples(
      {
        ...(env as Bindings),
        RAW_SAMPLE_ARCHIVE_DELETE_ENABLED: "true",
      },
      archiveNow
    );
    expect(cleanup).toEqual({
      agentRows: 1,
      monitorRows: 1,
      scrubbedReports: 1,
    });

    const remainingUnverified = await env.DB.prepare(
      `SELECT count(*) AS count FROM monitor_check_samples WHERE job_id = ?`
    )
      .bind(unverifiedJobId)
      .first<{ count: number }>();
    expect(remainingUnverified?.count).toBe(1);
    const report = await env.DB.prepare(
      `SELECT payload_json FROM agent_reports WHERE report_id = ?`
    )
      .bind(reportId)
      .first<{ payload_json: string }>();
    expect(report?.payload_json).toBe("{}");

    for (const result of results) {
      const restored = await restoreVerifiedRawSampleBatch(
        env as Bindings,
        result.batchId!
      );
      expect(restored).toMatchObject({
        batchId: result.batchId,
        domain: result.domain,
        sourceRows: 1,
        insertedRows: 1,
        deduplicatedRows: 0,
      });
      expect(
        await restoreVerifiedRawSampleBatch(env as Bindings, result.batchId!)
      ).toMatchObject({
        insertedRows: 0,
        deduplicatedRows: 1,
      });
    }
    const restoredSamples = await env.DB.prepare(
      `SELECT
         (SELECT count(*) FROM agent_report_samples WHERE report_id = ?) AS agent_count,
         (SELECT count(*) FROM monitor_check_samples WHERE job_id = ?) AS monitor_count`
    )
      .bind(reportId, monitorJobId)
      .first<{ agent_count: number; monitor_count: number }>();
    expect(restoredSamples).toEqual({ agent_count: 1, monitor_count: 1 });
  });
});
