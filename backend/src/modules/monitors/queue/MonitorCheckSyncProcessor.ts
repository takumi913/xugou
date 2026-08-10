import type { Bindings } from "../../../models/db";
import { writeStructuredLog } from "../../../platform/observability/StructuredLogger";
import { QueueJobPublisher } from "../../../platform/queues/QueuePublisher";
import {
  monitorCheckBucket,
  prepareMonitorCheckRollupRebuild,
} from "../persistence/D1MonitorCheckRollup";

interface MonitorRow {
  id: number;
  name: string;
  url: string;
  method: string;
  headers: string;
  body: string | null;
  timeout: number;
  timeout_ms: number;
  expected_status: number;
  active: number;
  status: string | null;
}

export type MonitorJobResult = { outcome: "completed" | "ignored" };

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2048);
}

export class MonitorCheckSyncProcessor {
  private readonly publisher: QueueJobPublisher;

  constructor(
    private readonly env: Pick<
      Bindings,
      "DB" | "XUGOU_JOBS"
    >
  ) {
    this.publisher = new QueueJobPublisher(env.XUGOU_JOBS);
  }

  async process(monitorId: number, scheduledForMs: number): Promise<MonitorJobResult> {
    const now = new Date();
    try {
      const targetMonitor = await this.env.DB.prepare(
        `SELECT d.id, d.name, d.url, d.method, d.headers_json AS headers,
                d.body, max(1, CAST(d.timeout_ms / 1000 AS INTEGER)) AS timeout,
                d.timeout_ms, d.expected_status, d.active, r.status
         FROM monitor_definitions d
         JOIN monitor_runtime r ON r.monitor_id = d.id
         WHERE d.id = ? AND d.deleted_at_ms IS NULL LIMIT 1`
      )
        .bind(monitorId)
        .first<MonitorRow>();
      
      const monitor = targetMonitor;
              
      if (!monitor || monitor.active !== 1) {
        return { outcome: "ignored" };
      }

      let headers: Record<string, string> = {};
      try {
        const parsed = JSON.parse(monitor.headers) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          headers = Object.fromEntries(
            Object.entries(parsed).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          );
        }
      } catch {
        headers = {};
      }
      
      const startedAt = Date.now();
      let status = "down";
      let statusCode: number | null = null;
      let error: string | null = null;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        monitor.timeout_ms || Math.max(1, monitor.timeout) * 1000
      );
      
      try {
        const response = await fetch(monitor.url, {
          method: monitor.method,
          headers,
          body: ["GET", "HEAD"].includes(monitor.method) ? undefined : monitor.body ?? "",
          signal: controller.signal,
        });
        statusCode = response.status;
        const expected = monitor.expected_status;
        status =
          expected >= 1 && expected <= 5
            ? Math.floor(response.status / 100) === expected
              ? "up"
              : "down"
            : response.status === expected
              ? "up"
              : "down";
        if (status === "down") error = `Unexpected status ${response.status}`;
      } catch (cause) {
        error = message(cause);
      } finally {
        clearTimeout(timer);
      }
      
      const checkedAt = new Date();
      const checkedIso = checkedAt.toISOString();
      const responseTime = Math.max(0, Date.now() - startedAt);
      const changed = Boolean(monitor.status && monitor.status !== status);
      const jobId = `monitor-check:${monitor.id}:${scheduledForMs}`;
      const eventId = `monitor.checked:${jobId}`;
      const rollupBucket = monitorCheckBucket(checkedAt);
      
      const statements = [
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO monitor_check_samples
           (job_id, monitor_id, scheduled_for_ms, checked_at, status, response_time_ms,
            status_code, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          jobId,
          monitor.id,
          scheduledForMs,
          checkedIso,
          status,
          responseTime,
          statusCode,
          error,
          checkedIso,
          checkedIso
        ),
        this.env.DB.prepare(
          `UPDATE monitor_runtime
           SET status = ?, response_time_ms = ?, last_checked_at_ms = ?,
               version = version + 1, updated_at_ms = ?
           WHERE monitor_id = ?`
        ).bind(
          status,
          responseTime,
          checkedAt.getTime(),
          checkedAt.getTime(),
          monitor.id
        ),
        prepareMonitorCheckRollupRebuild(
          this.env.DB,
          monitor.id,
          rollupBucket,
          checkedIso
        ),
      ];
      
      if (changed) {
        if (status === "up") {
          statements.push(
            this.env.DB.prepare(
              `UPDATE monitor_incidents SET ended_at = ?, updated_at = ?
               WHERE monitor_id = ? AND ended_at IS NULL`
            ).bind(checkedIso, checkedIso, monitor.id)
          );
        } else {
          statements.push(
            this.env.DB.prepare(
              `INSERT INTO monitor_incidents
               (monitor_id, from_status, to_status, started_at, reason, last_error, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'status_change', ?, ?, ?)`
            ).bind(monitor.id, monitor.status, status, checkedIso, error, checkedIso, checkedIso)
          );
        }
      }
      
      statements.push(
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO domain_outbox
           (event_id, event_type, aggregate_type, aggregate_id, payload_json,
            status, attempts, available_at, created_at, updated_at)
           VALUES (?, 'monitor.checked', 'monitor', ?, ?, 'pending', 0, ?, ?, ?)`
        ).bind(
          eventId,
          String(monitor.id),
          JSON.stringify({
            job_id: jobId,
            monitor_id: monitor.id,
            previous_status: monitor.status,
            status,
            response_time_ms: responseTime,
            status_code: statusCode,
            error,
            changed,
          }),
          checkedIso,
          checkedIso,
          checkedIso
        )
      );
      
      await this.env.DB.batch(statements);
      
      try {
        await this.publisher.publishOutbox(eventId);
        await this.env.DB.prepare(
          `UPDATE domain_outbox SET status = 'published', attempts = attempts + 1,
           published_at = ?, updated_at = ? WHERE event_id = ? AND status = 'pending'`
        )
          .bind(checkedIso, checkedIso, eventId)
          .run();
      } catch (cause) {
        writeStructuredLog(this.env, {
          service: "queue",
          operation: "publish_monitor_result_outbox",
          result: "deferred",
          eventId,
          jobId,
          entityType: "monitor",
          entityId: monitor.id,
          errorCode: "MONITOR_RESULT_PUBLISH_DEFERRED",
          error: cause,
        });
      }
      
      return { outcome: "completed" };
    } catch (error) {
       writeStructuredLog(this.env, {
        service: "cron",
        operation: "monitor_sync_check",
        result: "failure",
        errorCode: "MONITOR_CHECK_FAILED",
        error,
        fields: { monitor_id: monitorId },
      });
      return { outcome: "ignored" };
    }
  }
}
