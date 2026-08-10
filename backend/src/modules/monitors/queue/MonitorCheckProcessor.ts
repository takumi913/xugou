import type { Bindings } from "../../../models/db";
import { writeStructuredLog } from "../../../platform/observability/StructuredLogger";
import { QueueJobPublisher } from "../../../platform/queues/QueuePublisher";
import { isContractMode } from "../../../platform/compatibility/CompatibilityMode";
import {
  monitorCheckBucket,
  prepareMonitorCheckRollupRebuild,
} from "../persistence/D1MonitorCheckRollup";

interface ClaimedMonitorJob {
  id: string;
  payload_json: string;
  attempts: number;
  max_attempts: number;
  lease_token: string;
}

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

export type MonitorJobResult =
  | { outcome: "completed" | "ignored" }
  | { outcome: "retry"; delaySeconds: number };

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2048);
}

export class MonitorCheckProcessor {
  private readonly publisher: QueueJobPublisher;

  constructor(
    private readonly env: Pick<
      Bindings,
      "DB" | "XUGOU_JOBS" | "DATA_COMPATIBILITY_MODE"
    >
  ) {
    this.publisher = new QueueJobPublisher(env.XUGOU_JOBS);
  }

  private async fail(job: ClaimedMonitorJob, error: unknown) {
    const now = new Date();
    const exhausted = job.attempts >= job.max_attempts;
    const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
    await this.env.DB.prepare(
      `UPDATE async_jobs SET status = ?, available_at = ?, lease_token = NULL,
       lease_expires_at = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND lease_token = ?`
    )
      .bind(
        exhausted ? "failed" : "retry",
        new Date(now.getTime() + delaySeconds * 1000).toISOString(),
        message(error),
        now.toISOString(),
        job.id,
        job.lease_token
      )
      .run();
    return exhausted
      ? ({ outcome: "ignored" } as const)
      : ({ outcome: "retry", delaySeconds } as const);
  }

  async process(jobId: string): Promise<MonitorJobResult> {
    const now = new Date();
    const leaseToken = crypto.randomUUID();
    const job = await this.env.DB.prepare(
      `UPDATE async_jobs SET status = 'processing', attempts = attempts + 1,
       lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND kind = 'monitor.check' AND attempts < max_attempts
       AND available_at <= ? AND (
         status IN ('pending', 'retry') OR (status = 'processing' AND lease_expires_at <= ?)
       )
       RETURNING id, payload_json, attempts, max_attempts, lease_token`
    )
      .bind(
        leaseToken,
        new Date(now.getTime() + 60_000).toISOString(),
        now.toISOString(),
        jobId,
        now.toISOString(),
        now.toISOString()
      )
      .first<ClaimedMonitorJob>();
    if (!job) return { outcome: "ignored" };

    try {
      const payload = JSON.parse(job.payload_json) as {
        monitor_id: number;
        scheduled_for_ms: number;
      };
      if (!Number.isInteger(payload.monitor_id) || !Number.isSafeInteger(payload.scheduled_for_ms)) {
        throw new Error("Invalid monitor job payload");
      }
      const targetMonitor = await this.env.DB.prepare(
        `SELECT d.id, d.name, d.url, d.method, d.headers_json AS headers,
                d.body, max(1, CAST(d.timeout_ms / 1000 AS INTEGER)) AS timeout,
                d.timeout_ms, d.expected_status, d.active, r.status
         FROM monitor_definitions d
         JOIN monitor_runtime r ON r.monitor_id = d.id
         WHERE d.id = ? AND d.deleted_at_ms IS NULL LIMIT 1`
      )
        .bind(payload.monitor_id)
        .first<MonitorRow>();
      const monitor =
        targetMonitor ??
        (isContractMode(this.env)
          ? null
          : await this.env.DB.prepare(
              `SELECT id, name, url, method, headers, body, timeout, timeout_ms,
               expected_status, active, status FROM monitors
               WHERE id = ? AND deleted_at IS NULL LIMIT 1`
            )
              .bind(payload.monitor_id)
              .first<MonitorRow>());
      if (!monitor || monitor.active !== 1) {
        await this.env.DB.prepare(
          `UPDATE async_jobs SET status = 'completed', completed_at = ?, lease_token = NULL,
           lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ?`
        )
          .bind(now.toISOString(), now.toISOString(), job.id, job.lease_token)
          .run();
        return { outcome: "completed" };
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
      const eventId = `monitor.checked:${job.id}`;
      const rollupBucket = monitorCheckBucket(checkedAt);
      const statements = [
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO monitor_check_samples
           (job_id, monitor_id, scheduled_for_ms, checked_at, status, response_time_ms,
            status_code, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          job.id,
          monitor.id,
          payload.scheduled_for_ms,
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
      if (!isContractMode(this.env)) {
        statements.push(
          this.env.DB.prepare(
            `UPDATE monitors SET status = ?, response_time = ?, last_checked = ?
             WHERE id = ? AND deleted_at IS NULL`
          ).bind(status, responseTime, checkedIso, monitor.id)
        );
      }
      if (changed) {
        if (!isContractMode(this.env)) {
          statements.push(
            this.env.DB.prepare(
              `INSERT INTO monitor_status_history_24h
               (monitor_id, status, timestamp, response_time, status_code, error)
               VALUES (?, ?, ?, ?, ?, ?)`
            ).bind(monitor.id, status, checkedIso, responseTime, statusCode, error)
          );
        }
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
        if (!isContractMode(this.env)) {
          statements.push(
            this.env.DB.prepare(
              `UPDATE public_status_snapshots SET dirty_at = ?, refresh_after = ?, refreshing = 0
               WHERE id = 1`
            ).bind(checkedIso, checkedIso)
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
            job_id: job.id,
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
        ),
        this.env.DB.prepare(
          `UPDATE async_jobs SET status = 'completed', completed_at = ?, lease_token = NULL,
           lease_expires_at = NULL, last_error = NULL, updated_at = ?
           WHERE id = ? AND lease_token = ?`
        ).bind(checkedIso, checkedIso, job.id, job.lease_token)
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
          jobId: job.id,
          entityType: "monitor",
          entityId: monitor.id,
          errorCode: "MONITOR_RESULT_PUBLISH_DEFERRED",
          error: cause,
        });
      }
      return { outcome: "completed" };
    } catch (error) {
      return this.fail(job, error);
    }
  }
}
