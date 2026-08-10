import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { XugouQueueMessage } from "../src/contracts/queue";
import { checkAgentsStatus } from "../src/jobs/agent-task";
import { checkExpiringAgents } from "../src/jobs/expiry-task";
import { generateDailyMonitorStats } from "../src/jobs/monitor-task";
import type { Bindings } from "../src/models/db";
import { D1NotificationRepository } from "../src/modules/notifications/persistence/D1NotificationRepository";
import { D1NotificationChannelStore } from "../src/modules/notifications/persistence/D1NotificationChannelStore";
import {
  backfillLegacyAgentCredentials,
  digestAgentToken,
} from "../src/modules/agents/persistence/D1AgentCredentialStore";
import worker from "../src/worker";
import { D1ReleaseReadinessQuery } from "../src/modules/operations/persistence/D1ReleaseReadinessQuery";
import {
  backfillLegacyAgentHistory,
  legacyAgentHistoryCoverage,
} from "../src/platform/migrations/LegacyAgentHistoryBackfill";
import {
  backfillLegacyMonitorHistory,
  legacyMonitorHistoryCoverage,
} from "../src/platform/migrations/LegacyMonitorHistoryBackfill";
import { queryMonitorHistory } from "../src/modules/monitors/persistence/D1LegacyMonitorFacade";
import { queryMonitorDailyStats } from "../src/modules/monitors/persistence/D1LegacyMonitorFacade";
import { canonicalMigrationJson } from "../src/platform/migrations/MigrationEncoding";
import {
  backfillLegacyMonitorDailyStats,
  legacyMonitorDailyStatsCoverage,
} from "../src/platform/migrations/LegacyMonitorDailyStatsBackfill";
import {
  backfillLegacyMonitorModel,
  legacyMonitorModelCoverage,
} from "../src/platform/migrations/LegacyMonitorModelBackfill";
import { createMonitorUseCases } from "../src/modules/monitors/composition";
import {
  backfillLegacyNotificationHistory,
  legacyNotificationHistoryCoverage,
} from "../src/platform/migrations/LegacyNotificationHistoryBackfill";
import {
  backfillLegacyAgentModel,
  legacyAgentModelCoverage,
  projectLegacyAgentModel,
} from "../src/platform/migrations/LegacyAgentModelBackfill";
import { createAgentUseCases } from "../src/modules/agents/composition";
import {
  monitorCheckBucket,
  prepareMonitorCheckRollupRebuild,
} from "../src/modules/monitors/persistence/D1MonitorCheckRollup";
import {
  backfillLegacyAgentCurrentMetrics,
  legacyAgentCurrentMetricsCoverage,
} from "../src/platform/migrations/LegacyAgentCurrentMetricsBackfill";
import { queryLatestLegacyAgentMetric } from "../src/modules/agents/persistence/D1LegacyAgentFacade";
import {
  backfillLegacyStatusPage,
  legacyStatusPageCoverage,
} from "../src/platform/migrations/LegacyStatusPageBackfill";
import { D1StatusRepository } from "../src/modules/status/persistence/D1StatusRepository";
import { StatusPublicationConsumer } from "../src/modules/status/queue/StatusPublicationConsumer";
import {
  backfillLegacyNotificationRules,
  legacyNotificationRulesCoverage,
} from "../src/platform/migrations/LegacyNotificationRulesBackfill";
import {
  backfillLegacyNotificationTemplates,
  legacyNotificationTemplatesCoverage,
} from "../src/platform/migrations/LegacyNotificationTemplatesBackfill";

const now = "2026-08-02T00:00:00.000Z";

async function scalar<T>(query: string, ...bindings: unknown[]): Promise<T> {
  const row = await env.DB.prepare(query).bind(...bindings).first<T>();
  if (!row) throw new Error(`query returned no row: ${query}`);
  return row;
}

describe("single Worker runtime queue integration", () => {
  it("keeps credentialed CORS same-origin unless an exact origin is configured", async () => {
    const sameOriginContext = createExecutionContext();
    const sameOrigin = await worker.fetch(
      new Request("http://localhost/api/v2/session/login", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost" },
      }),
      env,
      sameOriginContext
    );
    expect(sameOrigin.status).toBe(204);
    expect(sameOrigin.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost"
    );
    expect(sameOrigin.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true"
    );

    const rejectedContext = createExecutionContext();
    const rejected = await worker.fetch(
      new Request("http://localhost/api/v2/session/login", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.test" },
      }),
      env,
      rejectedContext
    );
    expect(rejected.status).toBe(204);
    expect(rejected.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(rejected.headers.has("Access-Control-Allow-Credentials")).toBe(false);
  });

  it("rejects oversized API bodies before JSON parsing", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://localhost/api/v2/session/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: "x".repeat(2 * 1024 * 1024 + 1),
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json"
    );
    await expect(response.json()).resolves.toMatchObject({
      code: "REQUEST_BODY_TOO_LARGE",
      status: 413,
    });
  });

  it("serves versioned session and profile routes through the same Worker", async () => {
    const loginContext = createExecutionContext();
    const loginResponse = await worker.fetch(
      new Request("http://localhost/api/v2/session/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          username: "admin",
          password: "test-initial-password",
        }),
      }),
      env as Bindings,
      loginContext
    );
    await waitOnExecutionContext(loginContext);
    expect(loginResponse.status).toBe(200);
    const setCookie = loginResponse.headers.get("set-cookie") ?? "";
    const session = /xugou_session=([^;,\s]+)/.exec(setCookie)?.[1];
    const csrf = /xugou_csrf=([^;,\s]+)/.exec(setCookie)?.[1];
    expect(session).toBeTruthy();
    expect(csrf).toBeTruthy();

    const profileContext = createExecutionContext();
    const profileResponse = await worker.fetch(
      new Request("http://localhost/api/v2/profile", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          Cookie: `xugou_session=${session}; xugou_csrf=${csrf}`,
          "X-CSRF-Token": csrf!,
        },
        body: JSON.stringify({ email: "admin@example.test" }),
      }),
      env as Bindings,
      profileContext
    );
    await waitOnExecutionContext(profileContext);
    expect(profileResponse.status).toBe(200);
    await expect(profileResponse.json()).resolves.toMatchObject({
      success: true,
      user: { id: 1, email: "admin@example.test" },
    });

    const auditContext = createExecutionContext();
    const auditResponse = await worker.fetch(
      new Request(
        "http://localhost/api/v2/operations/security-audit?limit=1",
        { headers: { Cookie: `xugou_session=${session}` } }
      ),
      env as Bindings,
      auditContext
    );
    await waitOnExecutionContext(auditContext);
    expect(auditResponse.status).toBe(200);
    const firstAuditPage = await auditResponse.json<{
      data: Array<{ id: string }>;
      next_cursor: string | null;
      has_more: boolean;
    }>();
    expect(firstAuditPage.data).toHaveLength(1);
    expect(firstAuditPage.has_more).toBe(true);
    expect(firstAuditPage.next_cursor).toBeTruthy();

    const secondAuditContext = createExecutionContext();
    const secondAuditResponse = await worker.fetch(
      new Request(
        `http://localhost/api/v2/operations/security-audit?limit=1&cursor=${encodeURIComponent(firstAuditPage.next_cursor!)}`,
        { headers: { Cookie: `xugou_session=${session}` } }
      ),
      env as Bindings,
      secondAuditContext
    );
    await waitOnExecutionContext(secondAuditContext);
    expect(secondAuditResponse.status).toBe(200);
    const secondAuditPage = await secondAuditResponse.json<{
      data: Array<{ id: string }>;
    }>();
    expect(secondAuditPage.data).toHaveLength(1);
    expect(secondAuditPage.data[0].id).not.toBe(firstAuditPage.data[0].id);
  });

  it("returns Problem Details for v2 validation, authentication, and CSRF failures", async () => {
    const invalidLoginContext = createExecutionContext();
    const invalidLogin = await worker.fetch(
      new Request("http://localhost/api/v2/session/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      env as Bindings,
      invalidLoginContext
    );
    await waitOnExecutionContext(invalidLoginContext);
    expect(invalidLogin.status).toBe(400);
    expect(invalidLogin.headers.get("content-type")).toContain(
      "application/problem+json"
    );
    await expect(invalidLogin.json()).resolves.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });

    const unauthorizedContext = createExecutionContext();
    const unauthorized = await worker.fetch(
      new Request("http://localhost/api/v2/profile", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({ email: "ignored@example.test" }),
      }),
      env as Bindings,
      unauthorizedContext
    );
    await waitOnExecutionContext(unauthorizedContext);
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });

    const loginContext = createExecutionContext();
    const login = await worker.fetch(
      new Request("http://localhost/api/v2/session/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          username: "admin",
          password: "test-initial-password",
        }),
      }),
      env as Bindings,
      loginContext
    );
    await waitOnExecutionContext(loginContext);
    const session = /xugou_session=([^;,\s]+)/.exec(
      login.headers.get("set-cookie") ?? ""
    )?.[1];
    const csrf = /xugou_csrf=([^;,\s]+)/.exec(
      login.headers.get("set-cookie") ?? ""
    )?.[1];
    expect(session).toBeTruthy();
    expect(csrf).toBeTruthy();

    const csrfContext = createExecutionContext();
    const csrfFailure = await worker.fetch(
      new Request("http://localhost/api/v2/profile", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          Cookie: `xugou_session=${session}`,
        },
        body: JSON.stringify({ email: "ignored@example.test" }),
      }),
      env as Bindings,
      csrfContext
    );
    await waitOnExecutionContext(csrfContext);
    expect(csrfFailure.status).toBe(403);
    await expect(csrfFailure.json()).resolves.toMatchObject({
      status: 403,
      code: "CSRF_VALIDATION_FAILED",
    });

    const authenticatedHeaders = {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      Cookie: `xugou_session=${session}; xugou_csrf=${csrf}`,
      "X-CSRF-Token": csrf!,
      "Idempotency-Key": "runtime-item-validation",
    };
    const itemValidationContext = createExecutionContext();
    const itemValidation = await worker.fetch(
      new Request("http://localhost/api/v2/notifications/settings/bulk", {
        method: "PUT",
        headers: authenticatedHeaders,
        body: JSON.stringify({
          settings: [
            {
              target_type: "global-agent",
              target_id: 7,
              enabled: true,
              channels: [1, 1],
            },
            {
              target_type: "monitor",
              target_id: 0,
              enabled: true,
              channels: [],
            },
          ],
        }),
      }),
      env as Bindings,
      itemValidationContext
    );
    await waitOnExecutionContext(itemValidationContext);
    expect(itemValidation.status).toBe(400);
    await expect(itemValidation.json()).resolves.toMatchObject({
      code: "VALIDATION_ERROR",
      errors: {
        "settings.0.target_id": ["global target_id must be 0"],
        "settings.0.channels": ["duplicate notification channel"],
        "settings.1.target_id": ["resource target_id is required"],
      },
    });

    const beforeRules = await scalar<{ count: number }>(
      "SELECT COUNT(*) AS count FROM notification_rules"
    );
    const semanticValidationContext = createExecutionContext();
    const semanticValidation = await worker.fetch(
      new Request("http://localhost/api/v2/notifications/settings/bulk", {
        method: "PUT",
        headers: {
          ...authenticatedHeaders,
          "Idempotency-Key": "runtime-semantic-validation",
        },
        body: JSON.stringify({
          settings: [
            {
              target_type: "global-agent",
              target_id: 0,
              enabled: true,
              channels: [999_991],
            },
            {
              target_type: "monitor",
              target_id: 999_992,
              enabled: true,
              channels: [999_993],
            },
          ],
        }),
      }),
      env as Bindings,
      semanticValidationContext
    );
    await waitOnExecutionContext(semanticValidationContext);
    expect(semanticValidation.status).toBe(400);
    await expect(semanticValidation.json()).resolves.toMatchObject({
      code: "SETTING_BULK_VALIDATION_FAILED",
      errors: {
        "settings.0.channels": [
          "notification channel 999991 does not exist",
        ],
        "settings.1.channels": [
          "notification channel 999993 does not exist",
        ],
        "settings.1.target_id": ["monitor target 999992 does not exist"],
      },
    });
    await expect(
      scalar<{ count: number }>("SELECT COUNT(*) AS count FROM notification_rules")
    ).resolves.toEqual(beforeRules);
  });

  it("deduplicates overlapping cron scheduling in D1", async () => {
    const monitorId = 91001;
    await env.DB.prepare(
      `INSERT INTO monitors
       (id, name, url, method, interval, timeout, timeout_ms, expected_status,
        headers, active, status, next_check_at, created_at, updated_at)
       VALUES (?, 'runtime-cron', 'https://example.test/health', 'GET', 300,
        30, 30000, 200, '{}', 1, 'pending', ?, ?, ?)`
    )
      .bind(monitorId, now, now, now)
      .run();

    // Cron 的 D1 调度账本与 Queue Consumer 已分别由本文件覆盖；这里使用
    // 一个完成型 Producer，避免 Miniflare 在测试结束时继续投递 Cron 产生的
    // 历史迁移消息，确保 Scheduled Invocation 本身被完整等待。
    const scheduledQueueMetrics = { backlogCount: 0, backlogBytes: 0 };
    const scheduledEnv: Bindings = {
      ...env,
      XUGOU_JOBS: {
        metrics: async () => scheduledQueueMetrics,
        send: async () => ({ metadata: { metrics: scheduledQueueMetrics } }),
        sendBatch: async () => ({ metadata: { metrics: scheduledQueueMetrics } }),
      },
    };

    for (let index = 0; index < 2; index += 1) {
      const controller = createScheduledController({
        scheduledTime: new Date(now),
        cron: "* * * * *",
      });
      const ctx = createExecutionContext();
      await worker.scheduled(controller, scheduledEnv, ctx);
      await waitOnExecutionContext(ctx);
    }

    const result = await scalar<{ count: number }>(
      `SELECT count(*) AS count FROM async_jobs
       WHERE aggregate_type = 'monitor' AND aggregate_id = ?`,
      String(monitorId)
    );
    expect(result.count).toBe(1);
  });

  it("rebuilds exact five-minute and daily monitor p95 from immutable samples", async () => {
    const monitorId = 91501;
    const sampleStart = new Date("2026-08-02T12:00:00.000Z");
    await env.DB.prepare(
      `INSERT INTO monitors
       (id, name, url, method, interval, timeout, timeout_ms, expected_status,
        headers, active, status, next_check_at, created_at, updated_at)
       VALUES (?, 'runtime-p95', 'https://example.test/health', 'GET', 300,
        30, 30000, 200, '{}', 1, 'pending', ?, ?, ?)`
    )
      .bind(monitorId, now, now, now)
      .run();

    const sampleStatements = Array.from({ length: 20 }, (_, index) => {
      const checkedAt = new Date(sampleStart.getTime() + index * 10_000).toISOString();
      return env.DB.prepare(
        `INSERT INTO monitor_check_samples
         (job_id, monitor_id, scheduled_for_ms, checked_at, status,
          response_time_ms, status_code, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 200, NULL, ?, ?)`
      ).bind(
        `runtime-p95-${index + 1}`,
        monitorId,
        sampleStart.getTime() + index * 10_000,
        checkedAt,
        index === 19 ? "down" : "up",
        index + 1,
        checkedAt,
        checkedAt
      );
    });
    const bucket = monitorCheckBucket(sampleStart);
    await env.DB.batch([
      ...sampleStatements,
      prepareMonitorCheckRollupRebuild(env.DB, monitorId, bucket, now),
    ]);

    expect(
      await scalar<{
        total_checks: number;
        up_checks: number;
        down_checks: number;
        last_status: string;
        response_time_p95: number;
        response_time_max: number;
      }>(
        `SELECT total_checks, up_checks, down_checks, last_status,
                response_time_p95, response_time_max
         FROM monitor_check_rollups
         WHERE monitor_id = ? AND bucket_size_seconds = 300`,
        monitorId
      )
    ).toMatchObject({
      total_checks: 20,
      up_checks: 19,
      down_checks: 1,
      last_status: "down",
      response_time_p95: 19,
      response_time_max: 20,
    });

    const dailyNow = new Date("2026-08-03T00:05:00.000Z");
    await generateDailyMonitorStats(env as Bindings, dailyNow, {
      monitorBatchSize: 1,
    });
    await generateDailyMonitorStats(env as Bindings, dailyNow, {
      monitorBatchSize: 1,
    });
    expect(
      await scalar<{
        total_checks: number;
        response_time_p95: number;
        response_time_max: number;
      }>(
        `SELECT total_checks, response_time_p95, response_time_max
         FROM monitor_check_rollups
         WHERE monitor_id = ? AND bucket_size_seconds = 86400`,
        monitorId
      )
    ).toMatchObject({
      total_checks: 20,
      response_time_p95: 19,
      response_time_max: 20,
    });

    await env.DB.batch([
      env.DB.prepare("DELETE FROM monitor_daily_stats WHERE monitor_id = ?").bind(
        monitorId
      ),
      env.DB.prepare("DELETE FROM monitor_check_rollups WHERE monitor_id = ?").bind(
        monitorId
      ),
      env.DB.prepare("DELETE FROM monitor_check_samples WHERE monitor_id = ?").bind(
        monitorId
      ),
      env.DB.prepare("DELETE FROM monitors WHERE id = ?").bind(monitorId),
    ]);
  });

  it("processes duplicate and expired-lease Agent jobs exactly once", async () => {
    const agentId = 92001;
    const reportId = "8bc16ef7-7035-48d0-854f-79471227439a";
    const jobId = `agent-report:${reportId}`;
    const report = {
      protocol_version: 4,
      agent_version: "v0.2.0",
      report_id: reportId,
      hostname: "runtime-agent",
      os: "linux",
      report_interval_seconds: 300,
      samples: Array.from({ length: 20 }, (_, index) => ({
        collected_at:
          index === 0
            ? "2026-08-02T08:00:00.000+08:00"
            : new Date(Date.parse(now) + index * 10_000).toISOString(),
        cpu: { usage: index + 1, cores: 2 },
        memory: { usage_rate: (index + 1) * 2 },
        network: [
          { interface: "eth0", bytes_recv: 1000, bytes_sent: 2000 },
        ],
      })),
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agents(id, name, token, status, created_at, updated_at)
         VALUES (?, 'runtime-agent', ?, 'inactive', ?, ?)`
      ).bind(agentId, `legacy-runtime-${agentId}`, now, now),
      env.DB.prepare(
        `INSERT INTO agent_reports
         (report_id, agent_id, payload_digest, payload_json, sample_count, status,
          received_at, created_at, updated_at)
         VALUES (?, ?, 'runtime-digest', ?, ?, 'pending', ?, ?, ?)`
      ).bind(
        reportId,
        agentId,
        JSON.stringify(report),
        report.samples.length,
        now,
        now,
        now
      ),
      env.DB.prepare(
        `INSERT INTO async_jobs
         (id, kind, dedup_key, aggregate_type, aggregate_id, payload_json, status,
          attempts, max_attempts, available_at, lease_token, lease_expires_at,
          created_at, updated_at)
         VALUES (?, 'agent.report.process', ?, 'agent_report', ?, ?, 'processing',
          1, 8, ?, 'expired-lease', '2026-08-01T00:00:00.000Z', ?, ?)`
      ).bind(
        jobId,
        jobId,
        reportId,
        JSON.stringify({ report_id: reportId }),
        "2000-01-01T00:00:00.000Z",
        now,
        now
      ),
    ]);

    const messages = [
      {
        id: "runtime-agent-duplicate-1",
        timestamp: new Date(now),
        attempts: 1,
        body: { version: 1, kind: "job", job_id: jobId },
      },
      {
        id: "runtime-agent-duplicate-2",
        timestamp: new Date(now),
        attempts: 2,
        body: { version: 1, kind: "job", job_id: jobId },
      },
    ];
    const batch = createMessageBatch<XugouQueueMessage>("xugou-jobs", messages);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.retryMessages).toStrictEqual([]);
    expect(result.explicitAcks.sort()).toStrictEqual(messages.map((message) => message.id).sort());

    expect(
      (
        await scalar<{ count: number }>(
          "SELECT count(*) AS count FROM agent_report_samples WHERE report_id = ?",
          reportId
        )
      ).count
    ).toBe(20);
    expect(
      await scalar<{ collected_at: string }>(
        `SELECT collected_at FROM agent_report_samples
         WHERE report_id = ? ORDER BY sample_index ASC LIMIT 1`,
        reportId
      )
    ).toMatchObject({ collected_at: now });
    expect(
      await scalar<{
        sample_count: number;
        cpu_p95: number;
        cpu_max: number;
        memory_p95: number;
        memory_max: number;
      }>(
        `SELECT sample_count, cpu_p95, cpu_max, memory_p95, memory_max
         FROM agent_metric_rollups
         WHERE agent_id = ? AND bucket_size_seconds = 300`,
        agentId
      )
    ).toMatchObject({
      sample_count: 20,
      cpu_p95: 19,
      cpu_max: 20,
      memory_p95: 38,
      memory_max: 40,
    });
    expect(
      (
        await scalar<{ count: number }>(
          "SELECT count(*) AS count FROM domain_outbox WHERE event_id = ?",
          `agent.report.processed:${reportId}`
        )
      ).count
    ).toBe(1);
    expect(
      (
        await scalar<{ attempts: number; status: string }>(
          "SELECT attempts, status FROM async_jobs WHERE id = ?",
          jobId
        )
      )
    ).toMatchObject({ attempts: 2, status: "completed" });

    const nextReportId = "a3f32752-2e6b-46c8-9ca2-f67441276c98";
    const nextJobId = `agent-report:${nextReportId}`;
    const nextCollectedAt = "2026-08-02T00:03:20.000Z";
    const nextReport = {
      ...report,
      report_id: nextReportId,
      samples: [
        {
          ...report.samples[0],
          collected_at: nextCollectedAt,
          network: [
            { interface: "eth0", bytes_recv: 2000, bytes_sent: 2500 },
          ],
        },
      ],
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agent_reports
         (report_id, agent_id, payload_digest, payload_json, sample_count, status,
          received_at, created_at, updated_at)
         VALUES (?, ?, 'runtime-next-digest', ?, 1, 'pending', ?, ?, ?)`
      ).bind(nextReportId, agentId, JSON.stringify(nextReport), now, now, now),
      env.DB.prepare(
        `INSERT INTO async_jobs
         (id, kind, dedup_key, aggregate_type, aggregate_id, payload_json, status,
          attempts, max_attempts, available_at, created_at, updated_at)
         VALUES (?, 'agent.report.process', ?, 'agent_report', ?, ?, 'pending',
          0, 8, '2000-01-01T00:00:00.000Z', ?, ?)`
      ).bind(
        nextJobId,
        nextJobId,
        nextReportId,
        JSON.stringify({ report_id: nextReportId }),
        now,
        now
      ),
    ]);
    const nextBatch = createMessageBatch<XugouQueueMessage>("xugou-jobs", [
      {
        id: "runtime-agent-traffic-next",
        timestamp: new Date(now),
        attempts: 1,
        body: { version: 1, kind: "job", job_id: nextJobId },
      },
    ]);
    const nextCtx = createExecutionContext();
    await worker.queue(nextBatch, env, nextCtx);
    await getQueueResult(nextBatch, nextCtx);
    expect(
      await scalar<{
        network_rx_speed: number;
        network_tx_speed: number;
        month_rx: number;
        month_tx: number;
      }>(
        `SELECT network_rx_speed, network_tx_speed, month_rx, month_tx
         FROM agent_latest_metrics WHERE agent_id = ?`,
        agentId
      )
    ).toMatchObject({
      network_rx_speed: 100,
      network_tx_speed: 50,
      month_rx: 1000,
      month_tx: 500,
    });
  });

  it("keeps per-message ack and retry state for partial batch failures", async () => {
    const eventId = "runtime-malformed-monitor-event";
    await env.DB.prepare(
      `INSERT INTO domain_outbox
       (event_id, event_type, aggregate_type, aggregate_id, payload_json, status,
        attempts, available_at, created_at, updated_at)
       VALUES (?, 'monitor.checked', 'monitor', '999999', '{malformed', 'pending',
        0, ?, ?, ?)`
    )
      .bind(eventId, now, now, now)
      .run();

    const messages = [
      {
        id: "runtime-missing-job",
        timestamp: new Date(now),
        attempts: 1,
        body: { version: 1, kind: "job", job_id: "agent-report:missing" },
      },
      {
        id: "runtime-malformed-outbox",
        timestamp: new Date(now),
        attempts: 3,
        body: { version: 1, kind: "outbox", event_id: eventId },
      },
    ];
    const batch = createMessageBatch<XugouQueueMessage>("xugou-jobs", messages);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toContain("runtime-missing-job");
    expect(result.retryMessages).toEqual([
      expect.objectContaining({ msgId: "runtime-malformed-outbox" }),
    ]);
    expect(
      (
        await scalar<{ count: number }>(
          `SELECT count(*) AS count FROM processed_events
           WHERE consumer = 'status.publication.v1' AND event_id = ?`,
          eventId
        )
      ).count
    ).toBe(1);
  });

  it("routes an unknown outbox event to the failure ledger instead of acknowledging it", async () => {
    const eventId = `runtime-unknown-event:${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO domain_outbox
       (event_id, event_type, aggregate_type, aggregate_id, payload_json, status,
        attempts, available_at, created_at, updated_at)
       VALUES (?, 'fixture.unknown', 'fixture', '1', '{}', 'pending', 0, ?, ?, ?)`
    )
      .bind(eventId, now, now, now)
      .run();
    const batch = createMessageBatch<XugouQueueMessage>("xugou-jobs", [
      {
        id: `message:${eventId}`,
        timestamp: new Date(now),
        attempts: 1,
        body: { version: 1, kind: "outbox", event_id: eventId },
      },
    ]);
    const context = createExecutionContext();
    await worker.queue(batch, env, context);
    const result = await getQueueResult(batch, context);
    expect(result.retryMessages).toEqual([
      expect.objectContaining({ msgId: `message:${eventId}` }),
    ]);
    expect(
      await scalar<{ status: string }>(
        `SELECT status FROM domain_outbox WHERE event_id = ?`,
        eventId
      )
    ).toEqual({ status: "failed" });
    expect(
      await scalar<{ count: number }>(
        `SELECT COUNT(*) AS count FROM processed_events WHERE event_id = ?`,
        eventId
      )
    ).toEqual({ count: 0 });
    expect(
      await scalar<{ status: string; message_json: string }>(
        `SELECT status, message_json FROM queue_failures
         WHERE failure_id = ?`,
        `unsupported-outbox:${eventId}`
      )
    ).toMatchObject({ status: "open" });

    const deadLetterBatch = createMessageBatch<XugouQueueMessage>(
      "xugou-jobs-dlq",
      [
        {
          id: `message:${eventId}`,
          timestamp: new Date(now),
          attempts: 6,
          body: { version: 1, kind: "outbox", event_id: eventId },
        },
      ]
    );
    const deadLetterContext = createExecutionContext();
    await worker.queue(deadLetterBatch, env, deadLetterContext);
    const deadLetterResult = await getQueueResult(
      deadLetterBatch,
      deadLetterContext
    );
    expect(deadLetterResult.explicitAcks).toContain(`message:${eventId}`);
    expect(
      await scalar<{
        source_kind: string;
        source_id: string;
        delivery_attempts: number;
        status: string;
      }>(
        `SELECT source_kind, source_id, delivery_attempts, status
         FROM queue_failures
         WHERE queue_name = 'xugou-jobs-dlq' AND message_id = ?`,
        `message:${eventId}`
      )
    ).toMatchObject({
      source_kind: "outbox",
      source_id: eventId,
      delivery_attempts: 6,
      status: "open",
    });
  });

  it("captures duplicate DLQ delivery once for audited replay", async () => {
    const body: XugouQueueMessage = {
      version: 1,
      kind: "job",
      job_id: "agent-report:runtime-dead-letter",
    };
    const messages = [
      {
        id: "runtime-dead-letter-message",
        timestamp: new Date(now),
        attempts: 6,
        body,
      },
    ];
    const firstBatch = createMessageBatch<XugouQueueMessage>(
      "xugou-jobs-dlq",
      messages
    );
    const firstCtx = createExecutionContext();
    await worker.queue(firstBatch, env, firstCtx);
    await getQueueResult(firstBatch, firstCtx);

    const duplicateBatch = createMessageBatch<XugouQueueMessage>(
      "xugou-jobs-dlq",
      messages
    );
    const duplicateCtx = createExecutionContext();
    await worker.queue(duplicateBatch, env, duplicateCtx);
    await getQueueResult(duplicateBatch, duplicateCtx);

    const failure = await scalar<{
      count: number;
      delivery_attempts: number;
      status: string;
    }>(
      `SELECT count(*) AS count, max(delivery_attempts) AS delivery_attempts,
              max(status) AS status
       FROM queue_failures WHERE queue_name = 'xugou-jobs-dlq' AND message_id = ?`,
      messages[0].id
    );
    expect(failure).toMatchObject({ count: 1, delivery_attempts: 6, status: "open" });
  });

  it("commits an offline transition and its outbox event exactly once", async () => {
    const agentId = 93001;
    const deadline = "2000-01-01T00:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO agents
       (id, name, token, status, keepalive, last_seen_at, next_offline_at,
        created_at, updated_at)
       VALUES (?, 'runtime-offline', ?, 'active', '60', ?, ?, ?, ?)`
    )
      .bind(agentId, `legacy-runtime-${agentId}`, deadline, deadline, deadline, deadline)
      .run();

    await checkAgentsStatus(env as Bindings);
    await checkAgentsStatus(env as Bindings);

    expect(
      await scalar<{ status: string; next_offline_at: string | null }>(
        "SELECT status, next_offline_at FROM agents WHERE id = ?",
        agentId
      )
    ).toMatchObject({ status: "inactive", next_offline_at: null });
    expect(
      (
        await scalar<{ count: number }>(
          `SELECT count(*) AS count FROM domain_outbox
           WHERE event_type = 'agent.status.changed' AND aggregate_id = ?`,
          String(agentId)
        )
      ).count
    ).toBe(1);
  });

  it("renews expired Agents and deduplicates expiry reminder outbox events", async () => {
    const renewingAgentId = 93011;
    const reminderAgentId = 93012;
    const secondBatchReminderAgentId = 93250;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agents
         (id, name, token, status, expire_date, billing_cycle, auto_renewal,
          created_at, updated_at)
         VALUES (?, 'runtime-renewal', ?, 'inactive', '2026-07-31', 'monthly', 1, ?, ?)`
      ).bind(renewingAgentId, `legacy-runtime-${renewingAgentId}`, now, now),
      env.DB.prepare(
        `INSERT INTO agents
         (id, name, token, status, expire_date, billing_cycle, auto_renewal,
          created_at, updated_at)
         VALUES (?, 'runtime-expiry', ?, 'inactive', '2026-08-05', 'monthly', 0, ?, ?)`
      ).bind(reminderAgentId, `legacy-runtime-${reminderAgentId}`, now, now),
      env.DB.prepare(
        `WITH RECURSIVE seq(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 105
         )
         INSERT INTO agents
         (id, name, token, status, expire_date, billing_cycle, auto_renewal,
          created_at, updated_at)
         SELECT 93100 + n, 'runtime-expiry-scan-' || n,
                'legacy-runtime-expiry-scan-' || n, 'inactive', 'invalid-date',
                'monthly', 0, ?, ? FROM seq`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO agents
         (id, name, token, status, expire_date, billing_cycle, auto_renewal,
          created_at, updated_at)
         VALUES (?, 'runtime-expiry-second-batch', ?, 'inactive', '2026-08-06',
                 'monthly', 0, ?, ?)`
      ).bind(
        secondBatchReminderAgentId,
        `legacy-runtime-${secondBatchReminderAgentId}`,
        now,
        now
      ),
    ]);

    const at = Date.parse("2026-08-02T12:00:00.000Z");
    await checkExpiringAgents(env as Bindings, at);
    await checkExpiringAgents(env as Bindings, at);

    expect(
      await scalar<{ expire_date: string }>(
        "SELECT expire_date FROM agents WHERE id = ?",
        renewingAgentId
      )
    ).toMatchObject({ expire_date: "2026-08-31" });
    expect(
      (
        await scalar<{ count: number }>(
          `SELECT COUNT(*) AS count FROM domain_outbox
           WHERE event_type = 'agent.expiry.reminder' AND aggregate_id = ?`,
          String(reminderAgentId)
        )
      ).count
    ).toBe(1);
    expect(
      (
        await scalar<{ count: number }>(
          `SELECT COUNT(*) AS count FROM domain_outbox
           WHERE event_type = 'agent.expiry.reminder' AND aggregate_id = ?`,
          String(secondBatchReminderAgentId)
        )
      ).count
    ).toBe(1);
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM domain_outbox
         WHERE event_type = 'agent.expiry.reminder' AND aggregate_id = ?`
      ).bind(String(secondBatchReminderAgentId)),
      env.DB.prepare(
        `DELETE FROM agents
         WHERE id BETWEEN 93101 AND 93205 OR id = ?`
      ).bind(secondBatchReminderAgentId),
    ]);
  });

  it("checkpoints credential backfill and quarantines a digest conflict", async () => {
    const firstId = 93021;
    const secondId = 93022;
    const validId = 93023;
    const conflictingToken = "runtime-conflicting-legacy-token";
    const digest = await digestAgentToken(env as Bindings, conflictingToken);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agents(id, name, token, status, created_at, updated_at)
         VALUES (?, 'runtime-backfill-a', ?, 'inactive', ?, ?)`
      ).bind(firstId, "runtime-owner-token", now, now),
      env.DB.prepare(
        `INSERT INTO agents(id, name, token, status, created_at, updated_at)
         VALUES (?, 'runtime-backfill-b', ?, 'inactive', ?, ?)`
      ).bind(secondId, conflictingToken, now, now),
      env.DB.prepare(
        `INSERT INTO agents(id, name, token, status, created_at, updated_at)
         VALUES (?, 'runtime-backfill-valid', ?, 'inactive', ?, ?)`
      ).bind(validId, "runtime-valid-legacy-token", now, now),
      env.DB.prepare(
        `INSERT INTO agent_credentials
         (agent_id, token_digest, token_hint, last_used_at, revoked_at,
          created_at, updated_at)
         VALUES (?, ?, 'xga_…test', ?, NULL, ?, ?)`
      ).bind(firstId, digest, now, now, now),
    ]);

    const result = await backfillLegacyAgentCredentials(env as Bindings, 25);
    expect(result).toMatchObject({ anomalies: 1, configured: true });
    const checkpoint = await scalar<{
      status: string;
      rows_read: number;
      rows_written: number;
      anomaly_rows: number;
    }>(
      `SELECT status, rows_read, rows_written, anomaly_rows
       FROM migration_checkpoints WHERE migration_key = 'agent-credential-v1'`
    );
    expect(checkpoint.status).toBe("completed_with_anomalies");
    expect(checkpoint.rows_read).toBeGreaterThanOrEqual(result.migrated + 1);
    expect(checkpoint.rows_written).toBeGreaterThanOrEqual(result.migrated);
    expect(checkpoint.anomaly_rows).toBeGreaterThanOrEqual(1);
    expect(
      await scalar<{ status: string; raw_value_json: string }>(
        `SELECT status, raw_value_json FROM migration_anomalies
         WHERE migration_key = 'agent-credential-v1' AND source_pk = ?`,
        String(secondId)
      )
    ).toMatchObject({ status: "open" });
  });

  it("serves the active immutable v2 status publication with its strong ETag", async () => {
    const payload = JSON.stringify({
      title: "Runtime Status",
      description: "Published",
      logoUrl: "",
      customCss: "",
      theme: "mono",
      monitors: [],
      agents: [],
    });
    const etag = '"sha256-runtime-publication"';
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO status_publications
         (id, source_event_id, payload_json, etag, generated_at, created_at, updated_at)
         VALUES (99001, 'runtime-status', ?, ?, ?, ?, ?)`
      ).bind(payload, etag, now, now, now),
      env.DB.prepare(
        `INSERT INTO status_publication_state
         (singleton_key, active_publication_id, updated_at)
         VALUES (1, 99001, ?)
         ON CONFLICT(singleton_key) DO UPDATE SET
           active_publication_id = excluded.active_publication_id,
           updated_at = excluded.updated_at`
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO status_metric_publications
         (status_publication_id, agent_id, payload_json, etag, generated_at, created_at, updated_at)
         VALUES (99001, 99011, ?, '"sha256-runtime-metric"', ?, ?, ?)`
      ).bind(
        JSON.stringify({ success: true, agent: [{ agent_id: 99011, timestamp: now }] }),
        now,
        now,
        now
      ),
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://runtime.test/api/v2/status/public"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe(etag);
    expect(await response.json()).toMatchObject({ title: "Runtime Status" });

    const conditionalCtx = createExecutionContext();
    const conditional = await worker.fetch(
      new Request("https://runtime.test/api/v2/status/public", {
        headers: { "If-None-Match": etag },
      }),
      env,
      conditionalCtx
    );
    expect(conditional.status).toBe(304);

    const metricContext = createExecutionContext();
    const metricResponse = await worker.fetch(
      new Request("https://runtime.test/api/v2/status/public/agents/99011/metrics"),
      env,
      metricContext
    );
    await waitOnExecutionContext(metricContext);
    expect(metricResponse.status).toBe(200);
    expect(metricResponse.headers.get("ETag")).toBe('"sha256-runtime-metric"');
    const metricConditional = await worker.fetch(
      new Request("https://runtime.test/api/v2/status/public/agents/99011/metrics", {
        headers: { "If-None-Match": '"sha256-runtime-metric"' },
      }),
      env,
      createExecutionContext()
    );
    expect(metricConditional.status).toBe(304);
  });

  it("returns publication-not-ready without writing from an anonymous GET", async () => {
    const active = await scalar<{ active_publication_id: number }>(
      `SELECT active_publication_id FROM status_publication_state WHERE singleton_key = 1`
    );
    const before = await scalar<{ count: number }>(
      `SELECT COUNT(*) AS count FROM status_publications`
    );
    await env.DB.prepare(`DELETE FROM status_publication_state`).run();
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://runtime.test/api/v2/status/public"),
      env,
      context
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await scalar<{ count: number }>(
      `SELECT COUNT(*) AS count FROM status_publications`
    )).toEqual(before);
    await env.DB.prepare(
      `INSERT INTO status_publication_state(singleton_key, active_publication_id, updated_at)
       VALUES (1, ?, ?)`
    )
      .bind(active.active_publication_id, now)
      .run();
  });

  it("keeps the previous publication pointer when the final activation transaction fails", async () => {
    const previous = await scalar<{ active_publication_id: number }>(
      `SELECT active_publication_id FROM status_publication_state WHERE singleton_key = 1`
    );
    const sourceEventId = `runtime-publication-rollback:${crypto.randomUUID()}`;
    const originalDb = env.DB;
    const failingDb = new Proxy(originalDb, {
      get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes("INSERT INTO status_publication_state")) {
            return statement;
          }
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty !== "bind") {
                const value = Reflect.get(statementTarget, statementProperty);
                return typeof value === "function"
                  ? value.bind(statementTarget)
                  : value;
              }
              return (...bindings: unknown[]) => {
                const bound = statementTarget.bind(...bindings);
                return new Proxy(bound, {
                  get(boundTarget, boundProperty) {
                    if (boundProperty === "run") {
                      return () =>
                        target.batch([
                          boundTarget,
                          target.prepare(
                            `INSERT INTO injected_missing_publication_table(id) VALUES (1)`
                          ),
                        ]);
                    }
                    const value = Reflect.get(boundTarget, boundProperty);
                    return typeof value === "function"
                      ? value.bind(boundTarget)
                      : value;
                  },
                });
              };
            },
          });
        };
      },
    }) as D1Database;
    const consumer = new StatusPublicationConsumer({
      ...(env as Bindings),
      DB: failingDb,
      DATA_COMPATIBILITY_MODE: "contract",
    });
    await expect(
      consumer.process({
        event_id: sourceEventId,
        event_type: "status.rebuild.requested",
        aggregate_type: "status_page",
        aggregate_id: "1",
        payload_json: "{}",
        status: "pending",
      })
    ).rejects.toThrow();
    expect(
      await scalar<{ active_publication_id: number }>(
        `SELECT active_publication_id FROM status_publication_state WHERE singleton_key = 1`
      )
    ).toEqual(previous);
    const inactive = await scalar<{ id: number }>(
      `SELECT id FROM status_publications WHERE source_event_id = ?`,
      sourceEventId
    );
    expect(inactive.id).not.toBe(previous.active_publication_id);
  });

  it("persists v2 notification channels through encrypted request-level D1 ports", async () => {
    const runtimeEnv = {
      ...env,
      NOTIFICATION_KEK: btoa(
        String.fromCharCode(...new Uint8Array(32).fill(7))
      ),
    } as Bindings;
    const repository = new D1NotificationRepository(runtimeEnv);
    const created = await repository.createChannel({
      name: "runtime-telegram",
      type: "telegram",
      config: JSON.stringify({ botToken: "runtime-secret", chatId: "10001" }),
      enabled: true,
    });
    expect(created.success).toBe(true);
    const channelId = created.id!;

    const persisted = await scalar<{
      config: string;
      ciphertext: string;
      public_config_json: string;
    }>(
      `SELECT c.config, s.ciphertext, e.public_config_json
       FROM notification_channels c
       JOIN notification_endpoints e ON e.channel_id = c.id
       JOIN notification_secrets s ON s.channel_id = c.id
       WHERE c.id = ?`,
      channelId
    );
    expect(persisted.config).not.toContain("runtime-secret");
    expect(persisted.public_config_json).toContain("10001");
    expect(persisted.ciphertext).not.toContain("runtime-secret");

    const masked = await repository.getChannel(channelId);
    expect(String(masked?.config)).toContain("********");
    expect(String(masked?.config)).not.toContain("runtime-secret");
    const delivery = await new D1NotificationChannelStore(runtimeEnv).deliveryChannel(
      channelId
    );
    expect(delivery?.config).toContain("runtime-secret");

    const setting = await repository.saveSetting({
      target_type: "global-agent",
      target_id: 0,
      enabled: false,
      on_down: false,
      on_recovery: true,
      on_offline: true,
      on_cpu_threshold: true,
      cpu_threshold: 90,
      on_memory_threshold: false,
      memory_threshold: 85,
      on_disk_threshold: false,
      disk_threshold: 90,
      cooldown_minutes: 30,
      channels: JSON.stringify([channelId]),
    });
    expect(setting.success).toBe(true);
    expect(await repository.getConfig()).toMatchObject({
      settings: { agents: { enabled: false, channels: [channelId] } },
    });

    const command = {
      target_type: "global-agent" as const,
      target_id: 0,
      enabled: true,
      on_down: false,
      on_recovery: true,
      on_offline: true,
      on_cpu_threshold: false,
      cpu_threshold: 90,
      on_memory_threshold: false,
      memory_threshold: 85,
      on_disk_threshold: false,
      disk_threshold: 90,
      cooldown_minutes: 30,
      channels: JSON.stringify([channelId]),
    };
    const bulk = await repository.saveSettingsBulk(
      [command],
      "runtime-bulk-key",
      "runtime-bulk-hash"
    );
    expect(bulk).toMatchObject({ success: true, replayed: false });
    const replay = await repository.saveSettingsBulk(
      [command],
      "runtime-bulk-key",
      "runtime-bulk-hash"
    );
    expect(replay).toMatchObject({ success: true, replayed: true, ids: bulk.ids });
    const beforeFailure = await repository.getConfig();
    const failed = await repository.saveSettingsBulk(
      [{ ...command, enabled: false, channels: "[999999999]" }],
      "runtime-bulk-failure",
      "runtime-bulk-failure-hash"
    );
    expect(failed.success).toBe(false);
    expect(await repository.getConfig()).toEqual(beforeFailure);
  });

  it("audits legacy route hits and exposes release reconciliation gates", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://runtime.test/api/status/public/data"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);

    const hit = await scalar<{
      route_group: string;
      hit_count: number;
      status_family: string;
    }>(
      `SELECT route_group, hit_count, status_family
       FROM api_compatibility_hits WHERE route_group = 'status_v1'
       ORDER BY last_seen_at DESC LIMIT 1`
    );
    expect(hit).toMatchObject({
      route_group: "status_v1",
      hit_count: 1,
      status_family: "2xx",
    });

    const readiness = await new D1ReleaseReadinessQuery(env as Bindings).get(
      new Date(now)
    );
    expect(readiness.management_v1_sunset_ready).toBe(false);
    expect(readiness.compatibility_windows.management_hits).toBeGreaterThan(0);
    expect(readiness.checks.map((item) => item.key)).toContain(
      "active_publication_age_seconds"
    );
  });

  it("backfills legacy Agent history with mapping, deduplication, and conservation", async () => {
    const agentId = 93031;
    const historyId = 88000000000001;
    const anomalyId = 88000000000002;
    const recentId = 93031;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agents(id, name, token, status, created_at, updated_at)
         VALUES (?, 'runtime-history', ?, 'inactive', ?, ?)`
      ).bind(agentId, `legacy-runtime-${agentId}`, now, now),
      env.DB.prepare(
        `INSERT INTO agent_metrics_history
         (id, agent_id, timestamp, cpu_usage, memory_usage_rate,
          disk_metrics, network_metrics, ping_json)
         VALUES (?, ?, ?, 12.5, 45, '[]', '[]', '{}')`
      ).bind(historyId, agentId, now),
      env.DB.prepare(
        `INSERT INTO agent_metrics_history
         (id, agent_id, timestamp, disk_metrics, network_metrics, ping_json)
         VALUES (?, ?, ?, '{bad-json', '[]', '{}')`
      ).bind(anomalyId, agentId, now),
      env.DB.prepare(
        `INSERT INTO agent_metrics_24h
         (id, agent_id, timestamp, cpu_usage, memory_usage_rate,
          disk_metrics, network_metrics)
         VALUES (?, ?, ?, 12.5, 45, '[]', '[]')`
      ).bind(recentId, agentId, now),
    ]);

    await Promise.all([
      backfillLegacyAgentHistory(env as Bindings, 10),
      backfillLegacyAgentHistory(env as Bindings, 10),
    ]);
    let result = await backfillLegacyAgentHistory(env as Bindings, 10);
    while (result.remaining) {
      result = await backfillLegacyAgentHistory(env as Bindings, 10);
    }

    expect(
      (
        await scalar<{ count: number }>(
          `SELECT COUNT(*) AS count FROM agent_report_samples WHERE agent_id = ?`,
          agentId
        )
      ).count
    ).toBe(1);
    expect(
      await scalar<{
        sample_count: number;
        cpu_p95: number;
        cpu_max: number;
        memory_p95: number;
        memory_max: number;
      }>(
        `SELECT sample_count, cpu_p95, cpu_max, memory_p95, memory_max
         FROM agent_metric_rollups
         WHERE agent_id = ? AND bucket_size_seconds = 300`,
        agentId
      )
    ).toMatchObject({
      sample_count: 1,
      cpu_p95: 12.5,
      cpu_max: 12.5,
      memory_p95: 45,
      memory_max: 45,
    });
    expect(
      (
        await scalar<{ count: number }>(
          `SELECT COUNT(*) AS count FROM legacy_id_map
           WHERE source_table IN ('agent_metrics_history', 'agent_metrics_24h')
             AND source_id IN (?, ?, ?)`,
          String(historyId),
          String(anomalyId),
          String(recentId)
        )
      ).count
    ).toBe(2);
    expect(
      await scalar<{ error_code: string; status: string }>(
        `SELECT error_code, status FROM migration_anomalies
         WHERE source_table = 'agent_metrics_history' AND source_pk = ?`,
        String(anomalyId)
      )
    ).toMatchObject({ error_code: "INVALID_JSON", status: "open" });
    const coverage = await legacyAgentHistoryCoverage(env as Bindings);
    expect(
      coverage.find((row) => row.source_table === "agent_metrics_history")
    ).toMatchObject({ conserved: true });
    expect(
      coverage.find((row) => row.source_table === "agent_metrics_24h")
    ).toMatchObject({ conserved: true });
    expect(
      (
        await scalar<{ rows_read: number }>(
          `SELECT SUM(rows_read) AS rows_read FROM migration_checkpoints
           WHERE migration_key IN (
             'legacy-agent-history-v1:agent_metrics_history',
             'legacy-agent-history-v1:agent_metrics_24h'
           )`
        )
      ).rows_read
    ).toBe(3);

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE agent_metrics_history SET disk_metrics = '[]' WHERE id = ?`
      ).bind(anomalyId),
      env.DB.prepare(
        `UPDATE migration_anomalies SET status = 'retry_requested', updated_at = ?
         WHERE source_table = 'agent_metrics_history' AND source_pk = ?`
      ).bind(new Date().toISOString(), String(anomalyId)),
    ]);
    await backfillLegacyAgentHistory(env as Bindings, 10);
    expect(
      await scalar<{ status: string }>(
        `SELECT status FROM migration_anomalies
         WHERE source_table = 'agent_metrics_history' AND source_pk = ?`,
        String(anomalyId)
      )
    ).toMatchObject({ status: "resolved" });
    expect(
      (
        await scalar<{ count: number }>(
          `SELECT COUNT(*) AS count FROM legacy_id_map
           WHERE source_table = 'agent_metrics_history'
             AND source_id IN (?, ?)`,
          String(historyId),
          String(anomalyId)
        )
      ).count
    ).toBe(2);
    expect(
      (await legacyAgentHistoryCoverage(env as Bindings)).find(
        (row) => row.source_table === "agent_metrics_history"
      )
    ).toMatchObject({ conserved: true });
  });

  it("backfills and reconciles legacy Monitor history without duplicate samples", async () => {
    const monitorId = 94001;
    const duplicateId = 94011;
    const newId = 94012;
    const anomalyId = 94013;
    const monitorNow = new Date().toISOString();
    const monitorNext = new Date(Date.now() + 60_000).toISOString();
    const monitorRetry = new Date(Date.now() + 120_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO monitors
         (id, name, url, method, interval, timeout, timeout_ms, expected_status,
          headers, active, status, created_at, updated_at)
         VALUES (?, 'runtime-monitor-history', 'https://example.test', 'GET',
                 300, 30, 30000, 200, '{}', 1, 'up', ?, ?)`
      ).bind(monitorId, monitorNow, monitorNow),
      env.DB.prepare(
        `INSERT INTO monitor_check_samples
         (job_id, monitor_id, scheduled_for_ms, checked_at, status,
          response_time_ms, status_code, error, created_at, updated_at)
         VALUES ('runtime-monitor-existing', ?, ?, ?, 'up', 25, 200, NULL, ?, ?)`
      ).bind(
        monitorId,
        Date.parse(monitorNow),
        monitorNow,
        monitorNow,
        monitorNow
      ),
      env.DB.prepare(
        `INSERT INTO monitor_status_history_24h
         (id, monitor_id, status, timestamp, response_time, status_code, error)
         VALUES (?, ?, 'up', ?, 25, 200, NULL)`
      ).bind(duplicateId, monitorId, monitorNow),
      env.DB.prepare(
        `INSERT INTO monitor_status_history_24h
         (id, monitor_id, status, timestamp, response_time, status_code, error)
         VALUES (?, ?, 'down', ?, 30, 500, 'fixture')`
      ).bind(newId, monitorId, monitorNext),
      env.DB.prepare(
        `INSERT INTO monitor_status_history_24h
         (id, monitor_id, status, timestamp, response_time, status_code, error)
         VALUES (?, ?, 'down', 'invalid-time', 30, 500, 'fixture')`
      ).bind(anomalyId, monitorId),
    ]);
    const existingIdentity = await scalar<{
      monitor_id: number;
      checked_at: string;
      status: string;
      response_time_ms: number;
      status_code: number | null;
      error: string | null;
    }>(
      `SELECT monitor_id, checked_at, status, response_time_ms, status_code, error
       FROM monitor_check_samples WHERE job_id = 'runtime-monitor-existing'`
    );
    const sourceIdentity = await scalar<{
      monitor_id: number;
      timestamp: string;
      status: string;
      response_time: number;
      status_code: number | null;
      error: string | null;
    }>(
      `SELECT monitor_id, timestamp, status, response_time, status_code, error
       FROM monitor_status_history_24h WHERE id = ?`,
      duplicateId
    );
    expect(canonicalMigrationJson(existingIdentity)).toBe(
      canonicalMigrationJson({
        monitor_id: sourceIdentity.monitor_id,
        checked_at: new Date(sourceIdentity.timestamp).toISOString(),
        status: sourceIdentity.status,
        response_time_ms: sourceIdentity.response_time,
        status_code: sourceIdentity.status_code,
        error: sourceIdentity.error,
      })
    );

    await Promise.all([
      backfillLegacyMonitorHistory(env as Bindings, 10),
      backfillLegacyMonitorHistory(env as Bindings, 10),
    ]);
    let monitorResult = await backfillLegacyMonitorHistory(env as Bindings, 10);
    while (monitorResult.remaining) {
      monitorResult = await backfillLegacyMonitorHistory(env as Bindings, 10);
    }
    expect(
      await scalar<{ target_id: string }>(
        `SELECT target_id FROM legacy_id_map
         WHERE source_table = 'monitor_status_history_24h' AND source_id = ?`,
        String(duplicateId)
      )
    ).toMatchObject({ target_id: "runtime-monitor-existing" });
    expect(
      (
        await scalar<{ count: number }>(
          `SELECT COUNT(*) AS count FROM monitor_check_samples WHERE monitor_id = ?`,
          monitorId
        )
      ).count
    ).toBe(2);
    expect(await legacyMonitorHistoryCoverage(env as Bindings)).toMatchObject({
      conserved: true,
    });
    expect(
      await scalar<{ rows_read: number; rows_written: number; rows_skipped: number }>(
        `SELECT rows_read, rows_written, rows_skipped FROM migration_checkpoints
         WHERE migration_key = 'legacy-monitor-history-v1'`
      )
    ).toMatchObject({ rows_read: 3, rows_written: 1, rows_skipped: 1 });

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE monitor_status_history_24h SET timestamp = ? WHERE id = ?`
      ).bind(monitorRetry, anomalyId),
      env.DB.prepare(
        `UPDATE migration_anomalies SET status = 'retry_requested', updated_at = ?
         WHERE migration_key = 'legacy-monitor-history-v1' AND source_pk = ?`
      ).bind(new Date().toISOString(), String(anomalyId)),
    ]);
    await backfillLegacyMonitorHistory(env as Bindings, 10);
    expect(
      await scalar<{ status: string }>(
        `SELECT status FROM migration_anomalies
         WHERE migration_key = 'legacy-monitor-history-v1' AND source_pk = ?`,
        String(anomalyId)
      )
    ).toMatchObject({ status: "resolved" });
    expect(await legacyMonitorHistoryCoverage(env as Bindings)).toMatchObject({
      conserved: true,
      mapped_rows: 3,
    });
    const history = await queryMonitorHistory(env as Bindings, monitorId);
    expect(history).toHaveLength(3);
  });

  it("backfills Monitor daily statistics into canonical daily rollups", async () => {
    const monitorId = 94501;
    const duplicateId = 94511;
    const newId = 94512;
    const anomalyId = 94513;
    const createdAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO monitors
         (id, name, url, method, interval, timeout, timeout_ms, expected_status,
          headers, active, status, created_at, updated_at)
         VALUES (?, 'runtime-monitor-daily', 'https://example.test', 'GET',
                 300, 30, 30000, 200, '{}', 1, 'up', ?, ?)`
      ).bind(monitorId, createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO monitor_check_rollups
         (monitor_id, bucket_start, bucket_size_seconds, total_checks, up_checks,
          down_checks, last_status, response_time_avg, response_time_min,
          response_time_p95, response_time_max, created_at, updated_at)
         VALUES (?, '2026-07-29T00:00:00.000Z', 86400, 10, 9, 1, NULL,
                 20, 10, 40, 40, ?, ?)`
      ).bind(monitorId, createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO monitor_daily_stats
         (id, monitor_id, date, total_checks, up_checks, down_checks,
          avg_response_time, min_response_time, max_response_time,
          availability, created_at)
         VALUES (?, ?, '2026-07-29', 10, 9, 1, 20, 10, 40, 90, ?)`
      ).bind(duplicateId, monitorId, createdAt),
      env.DB.prepare(
        `INSERT INTO monitor_daily_stats
         (id, monitor_id, date, total_checks, up_checks, down_checks,
          avg_response_time, min_response_time, max_response_time,
          availability, created_at)
         VALUES (?, ?, '2026-07-30', 12, 12, 0, 25, 15, 50, 100, ?)`
      ).bind(newId, monitorId, createdAt),
      env.DB.prepare(
        `INSERT INTO monitor_daily_stats
         (id, monitor_id, date, total_checks, up_checks, down_checks,
          avg_response_time, min_response_time, max_response_time,
          availability, created_at)
         VALUES (?, ?, '2026-07-31', 10, 8, 2, 30, 20, 60, 99, ?)`
      ).bind(anomalyId, monitorId, createdAt),
    ]);

    await Promise.all([
      backfillLegacyMonitorDailyStats(env as Bindings, 10),
      backfillLegacyMonitorDailyStats(env as Bindings, 10),
    ]);
    let result = await backfillLegacyMonitorDailyStats(env as Bindings, 10);
    while (result.remaining) {
      result = await backfillLegacyMonitorDailyStats(env as Bindings, 10);
    }
    expect(
      await scalar<{ rows_read: number; rows_written: number; rows_skipped: number }>(
        `SELECT rows_read, rows_written, rows_skipped FROM migration_checkpoints
         WHERE migration_key = 'legacy-monitor-daily-stats-v1'`
      )
    ).toMatchObject({ rows_read: 3, rows_written: 1, rows_skipped: 1 });
    expect(
      (
        await scalar<{ count: number }>(
          `SELECT COUNT(*) AS count FROM monitor_check_rollups
           WHERE monitor_id = ? AND bucket_size_seconds = 86400`,
          monitorId
        )
      ).count
    ).toBe(2);
    expect(await legacyMonitorDailyStatsCoverage(env as Bindings)).toMatchObject({
      conserved: true,
    });

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE monitor_daily_stats SET availability = 80 WHERE id = ?`
      ).bind(anomalyId),
      env.DB.prepare(
        `UPDATE migration_anomalies SET status = 'retry_requested', updated_at = ?
         WHERE migration_key = 'legacy-monitor-daily-stats-v1' AND source_pk = ?`
      ).bind(new Date().toISOString(), String(anomalyId)),
    ]);
    await backfillLegacyMonitorDailyStats(env as Bindings, 10);
    expect(await legacyMonitorDailyStatsCoverage(env as Bindings)).toMatchObject({
      conserved: true,
      mapped_rows: 3,
    });
    const daily = await queryMonitorDailyStats(env as Bindings, monitorId);
    expect(daily).toHaveLength(3);
    expect(daily.at(-1)).toMatchObject({
      date: "2026-07-31",
      total_checks: 10,
      availability: 80,
    });
  });

  it("backfills legacy Notification History into auditable messages and attempts", async () => {
    const channelId = 95001;
    const templateId = 95001;
    const duplicateId = 95011;
    const newId = 95012;
    const anomalyId = 95013;
    const legacyDefaultId = 95014;
    const sentAt = new Date().toISOString();
    const failedAt = new Date(Date.now() + 1000).toISOString();
    const duplicateContent = JSON.stringify({
      subject: "runtime subject",
      content: "runtime content",
      variables: { name: "fixture" },
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO notification_channels
         (id, name, type, config, enabled, created_at, updated_at)
         VALUES (?, 'runtime-history-channel', 'webhook', '{}', 0, ?, ?)`
      ).bind(channelId, sentAt, sentAt),
      env.DB.prepare(
        `INSERT INTO notification_templates
         (id, name, type, subject, content, is_default, created_at, updated_at)
         VALUES (?, 'runtime-history-template', 'monitor', 'subject', 'content', 0, ?, ?)`
      ).bind(templateId, sentAt, sentAt),
      env.DB.prepare(
        `INSERT INTO notification_events
         (event_id, source_event_id, type, target_id, event_key, variables_json,
          status, completed_at, created_at, updated_at)
         VALUES ('runtime-existing-event', 'runtime-existing-source', 'monitor',
                 94001, 'fixture', '{}', 'completed', ?, ?, ?)`
      ).bind(sentAt, sentAt, sentAt),
      env.DB.prepare(
        `INSERT INTO notification_messages
         (message_id, event_id, channel_id, template_id, subject, content,
          cooldown_minutes, status, attempts, max_attempts, available_at,
          sent_at, created_at, updated_at)
         VALUES ('runtime-existing-message', 'runtime-existing-event', ?, ?,
                 'runtime subject', 'runtime content', 0, 'sent', 1, 1, ?, ?, ?, ?)`
      ).bind(channelId, templateId, sentAt, sentAt, sentAt, sentAt),
      env.DB.prepare(
        `INSERT INTO notification_attempts
         (attempt_id, message_id, attempt_number, started_at, completed_at,
          duration_ms, success, error_category, error, retryable,
          created_at, updated_at)
         VALUES ('runtime-existing-attempt', 'runtime-existing-message', 1,
                 ?, ?, 0, 1, NULL, NULL, 0, ?, ?)`
      ).bind(sentAt, sentAt, sentAt, sentAt),
      env.DB.prepare(
        `INSERT INTO notification_history
         (id, type, target_id, channel_id, template_id, status, content, error, sent_at)
         VALUES (?, 'monitor', 94001, ?, ?, 'success', ?, NULL, ?)`
      ).bind(duplicateId, channelId, templateId, duplicateContent, sentAt),
      env.DB.prepare(
        `INSERT INTO notification_history
         (id, type, target_id, channel_id, template_id, status, content, error, sent_at)
         VALUES (?, 'monitor', 94001, ?, ?, 'failed', 'legacy body', 'provider', ?)`
      ).bind(newId, channelId, templateId, failedAt),
      env.DB.prepare(
        `INSERT INTO notification_history
         (id, type, target_id, channel_id, template_id, status, content, error, sent_at)
         VALUES (?, 'monitor', 94001, ?, ?, 'failed', 'legacy bad', 'provider', 'bad-time')`
      ).bind(anomalyId, channelId, templateId),
      env.DB.prepare(
        `INSERT INTO notification_history
         (id, type, target_id, channel_id, template_id, status, content, error, sent_at)
         VALUES (?, 'monitor', 94001, ?, ?, 'success', ?, NULL, 'CURRENT_TIMESTAMP')`
      ).bind(
        legacyDefaultId,
        channelId,
        templateId,
        JSON.stringify({
          subject: "legacy default subject",
          content: "legacy default content",
          variables: { time: "2026/8/9 12:34:56" },
        })
      ),
    ]);

    await Promise.all([
      backfillLegacyNotificationHistory(env as Bindings, 10),
      backfillLegacyNotificationHistory(env as Bindings, 10),
    ]);
    let notificationResult = await backfillLegacyNotificationHistory(
      env as Bindings,
      10
    );
    while (notificationResult.remaining) {
      notificationResult = await backfillLegacyNotificationHistory(
        env as Bindings,
        10
      );
    }
    expect(
      await scalar<{ target_id: string }>(
        `SELECT target_id FROM legacy_id_map
         WHERE source_table = 'notification_history' AND source_id = ?`,
        String(duplicateId)
      )
    ).toMatchObject({ target_id: "runtime-existing-message" });
    expect(
      (
        await scalar<{ count: number }>(
          `SELECT COUNT(*) AS count FROM notification_messages WHERE channel_id = ?`,
          channelId
        )
      ).count
    ).toBe(3);
    expect(
      (
        await scalar<{ count: number }>(
          `SELECT COUNT(*) AS count FROM notification_attempts a
           JOIN notification_messages m ON m.message_id = a.message_id
           WHERE m.channel_id = ?`,
          channelId
        )
      ).count
    ).toBe(3);
    expect(
      await scalar<{ completed_at: string }>(
        `SELECT a.completed_at FROM notification_attempts a
         JOIN legacy_id_map map ON map.target_id = a.message_id
         WHERE map.source_table = 'notification_history' AND map.source_id = ?`,
        String(legacyDefaultId)
      )
    ).toMatchObject({ completed_at: "2026-08-09T04:34:56.000Z" });
    expect(await legacyNotificationHistoryCoverage(env as Bindings)).toMatchObject({
      conserved: true,
    });
    const readiness = await new D1ReleaseReadinessQuery(env as Bindings).get();
    expect(
      readiness.checks.find((item) => item.key === "failed_notifications")
    ).toMatchObject({ actual: 0, ready: true });
    expect(
      await scalar<{ rows_read: number; rows_written: number; rows_skipped: number }>(
        `SELECT rows_read, rows_written, rows_skipped FROM migration_checkpoints
         WHERE migration_key = 'legacy-notification-history-v1'`
      )
    ).toMatchObject({ rows_read: 4, rows_written: 2, rows_skipped: 1 });

    const repairedAt = new Date(Date.now() + 2000).toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE notification_history SET sent_at = ? WHERE id = ?`).bind(
        repairedAt,
        anomalyId
      ),
      env.DB.prepare(
        `UPDATE migration_anomalies SET status = 'retry_requested', updated_at = ?
         WHERE migration_key = 'legacy-notification-history-v1' AND source_pk = ?`
      ).bind(new Date().toISOString(), String(anomalyId)),
    ]);
    await backfillLegacyNotificationHistory(env as Bindings, 10);
    expect(
      await scalar<{ status: string }>(
        `SELECT status FROM migration_anomalies
         WHERE migration_key = 'legacy-notification-history-v1' AND source_pk = ?`,
        String(anomalyId)
      )
    ).toMatchObject({ status: "resolved" });
    expect(await legacyNotificationHistoryCoverage(env as Bindings)).toMatchObject({
      conserved: true,
      mapped_rows: 4,
    });
  });

  it("splits Monitor definitions and runtime with dual-write and soft deletion", async () => {
    const monitorId = 96001;
    const anomalyId = 96002;
    const createdAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO monitors
         (id, name, url, method, interval, timeout, timeout_ms, expected_status,
          headers, body, active, status, response_time, last_checked,
          next_check_at, deleted_at, created_at, updated_at, sort_order)
         VALUES (?, 'runtime-model', 'https://example.test/health', 'GET',
                 300, 30, 30000, 200, '{"Accept":"application/json"}', NULL,
                 1, 'up', 20, ?, ?, NULL, ?, ?, 3)`
      ).bind(monitorId, createdAt, createdAt, createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO monitors
         (id, name, url, method, interval, timeout, timeout_ms, expected_status,
          headers, body, active, status, response_time, last_checked,
          next_check_at, deleted_at, created_at, updated_at, sort_order)
         VALUES (?, 'runtime-model-bad', 'https://example.test/bad', 'GET',
                 300, 30, 30000, 200, 'bad-json', NULL, 1, 'pending', 0,
                 NULL, ?, NULL, ?, ?, 4)`
      ).bind(anomalyId, createdAt, createdAt, createdAt),
    ]);

    await Promise.all([
      backfillLegacyMonitorModel(env as Bindings, 20),
      backfillLegacyMonitorModel(env as Bindings, 20),
    ]);
    let result = await backfillLegacyMonitorModel(env as Bindings, 20);
    while (result.remaining) result = await backfillLegacyMonitorModel(env as Bindings, 20);
    expect(await legacyMonitorModelCoverage(env as Bindings)).toMatchObject({
      conserved: true,
    });
    expect(
      await scalar<{ interval_ms: number; status: string }>(
        `SELECT d.interval_ms, r.status FROM monitor_definitions d
         JOIN monitor_runtime r ON r.monitor_id = d.id WHERE d.id = ?`,
        monitorId
      )
    ).toMatchObject({ interval_ms: 300000, status: "up" });

    await env.DB.batch([
      env.DB.prepare(`UPDATE monitors SET headers = '{}' WHERE id = ?`).bind(anomalyId),
      env.DB.prepare(
        `UPDATE migration_anomalies SET status = 'retry_requested', updated_at = ?
         WHERE migration_key = 'legacy-monitor-model-v2' AND source_pk = ?`
      ).bind(new Date().toISOString(), String(anomalyId)),
    ]);
    await backfillLegacyMonitorModel(env as Bindings, 20);
    expect(await legacyMonitorModelCoverage(env as Bindings)).toMatchObject({
      conserved: true,
    });

    const useCases = createMonitorUseCases(env as Bindings);
    expect(await useCases.get(monitorId)).toMatchObject({
      name: "runtime-model",
      interval_seconds: 300,
      status: "up",
    });
    await useCases.update(monitorId, {
      name: "runtime-model-updated",
      interval_seconds: 600,
    });
    expect(
      await scalar<{ name: string; interval_ms: number }>(
        `SELECT name, interval_ms FROM monitor_definitions WHERE id = ?`,
        monitorId
      )
    ).toMatchObject({ name: "runtime-model-updated", interval_ms: 600000 });
    expect(
      await scalar<{ name: string; interval: number }>(
        `SELECT name, interval FROM monitors WHERE id = ?`,
        monitorId
      )
    ).toMatchObject({ name: "runtime-model-updated", interval: 600 });

    await env.DB.prepare(
      `INSERT INTO monitor_check_samples
       (job_id, monitor_id, scheduled_for_ms, checked_at, status,
        response_time_ms, status_code, error, created_at, updated_at)
       VALUES ('runtime-model-sample', ?, ?, ?, 'up', 20, 200, NULL, ?, ?)`
    )
      .bind(monitorId, Date.parse(createdAt), createdAt, createdAt, createdAt)
      .run();
    await useCases.delete(monitorId);
    expect(
      await scalar<{ deleted_at: string | null }>(
        `SELECT deleted_at FROM monitors WHERE id = ?`,
        monitorId
      )
    ).toMatchObject({ deleted_at: expect.any(String) });
    expect(
      (
        await scalar<{ count: number }>(
          `SELECT COUNT(*) AS count FROM monitor_check_samples WHERE monitor_id = ?`,
          monitorId
        )
      ).count
    ).toBe(1);
  });

  it("splits Agent configuration and runtime with retry, dual-write, and soft deletion", async () => {
    const agentId = 97001;
    const anomalyId = 97002;
    const createdAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agents
         (id, name, token, status, created_at, updated_at, hostname,
          ip_addresses, os, version, keepalive, last_seen_at,
          last_state_changed_at, next_offline_at, collect_interval,
          report_interval, currency, auto_renewal, is_hidden,
          traffic_reset_day, traffic_calc_type, auto_update, tags, sort_order)
         VALUES (?, 'runtime-agent-model', 'runtime-agent-model-token', 'active',
                 ?, ?, 'edge-a', '["192.0.2.10"]', 'linux', 'v1.0.0', '300',
                 ?, ?, ?, 60, 300, 'USD', 0, 0, 1, 'sum', 0, 'edge,prod', 2)`
      ).bind(agentId, createdAt, createdAt, createdAt, createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO agents
         (id, name, token, status, created_at, updated_at, ip_addresses,
          collect_interval, report_interval, currency, traffic_reset_day,
          traffic_calc_type)
         VALUES (?, 'runtime-agent-model-bad', 'runtime-agent-model-bad-token',
                 'inactive', ?, ?, 'bad-json', 60, 300, 'USD', 1, 'sum')`
      ).bind(anomalyId, createdAt, createdAt),
    ]);

    await Promise.all([
      backfillLegacyAgentModel(env as Bindings, 20),
      backfillLegacyAgentModel(env as Bindings, 20),
    ]);
    let result = await backfillLegacyAgentModel(env as Bindings, 20);
    while (result.remaining) result = await backfillLegacyAgentModel(env as Bindings, 20);
    expect(await legacyAgentModelCoverage(env as Bindings)).toMatchObject({
      conserved: true,
      read_ready: false,
    });
    expect(
      await scalar<{ collect_interval_ms: number; status: string }>(
        `SELECT n.collect_interval_ms, r.status FROM agent_nodes n
         JOIN agent_runtime r ON r.agent_id = n.id WHERE n.id = ?`,
        agentId
      )
    ).toMatchObject({ collect_interval_ms: 60000, status: "active" });

    await env.DB.batch([
      env.DB.prepare(`UPDATE agents SET ip_addresses = '[]' WHERE id = ?`).bind(
        anomalyId
      ),
      env.DB.prepare(
        `UPDATE migration_anomalies SET status = 'retry_requested', updated_at = ?
         WHERE migration_key = 'legacy-agent-model-v2' AND source_pk = ?`
      ).bind(new Date().toISOString(), String(anomalyId)),
    ]);
    await backfillLegacyAgentModel(env as Bindings, 20);
    expect(await legacyAgentModelCoverage(env as Bindings)).toMatchObject({
      conserved: true,
      read_ready: true,
    });

    const useCases = createAgentUseCases(env as Bindings);
    expect(await useCases.get(agentId)).toMatchObject({
      name: "runtime-agent-model",
      hostname: "edge-a",
      collect_interval_seconds: 60,
      status: "active",
    });
    await useCases.update(agentId, {
      name: "runtime-agent-model-updated",
      hostname: "edge-b",
      collect_interval_seconds: 120,
    });
    expect(
      await scalar<{ name: string; collect_interval_ms: number }>(
        `SELECT name, collect_interval_ms FROM agent_nodes WHERE id = ?`,
        agentId
      )
    ).toMatchObject({
      name: "runtime-agent-model-updated",
      collect_interval_ms: 120000,
    });
    expect(
      await scalar<{ name: string; collect_interval: number }>(
        `SELECT name, collect_interval FROM agents WHERE id = ?`,
        agentId
      )
    ).toMatchObject({
      name: "runtime-agent-model-updated",
      collect_interval: 120,
    });
    expect(
      await scalar<{ hostname: string }>(
        `SELECT hostname FROM agent_runtime WHERE agent_id = ?`,
        agentId
      )
    ).toMatchObject({ hostname: "edge-b" });

    await useCases.delete(agentId);
    expect(
      await scalar<{ deleted_at: string | null }>(
        `SELECT deleted_at FROM agents WHERE id = ?`,
        agentId
      )
    ).toMatchObject({ deleted_at: expect.any(String) });
    expect(
      await scalar<{ deleted_at_ms: number | null }>(
        `SELECT deleted_at_ms FROM agent_nodes WHERE id = ?`,
        agentId
      )
    ).toMatchObject({ deleted_at_ms: expect.any(Number) });
  });

  it("backfills Agent current metrics with retry, reconciliation, and canonical reads", async () => {
    const agentId = 98001;
    const anomalyId = 98002;
    const createdAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agents
         (id, name, token, status, created_at, updated_at,
          collect_interval, report_interval, currency, traffic_reset_day,
          traffic_calc_type)
         VALUES (?, 'current-metric-agent', 'current-metric-agent-token',
                 'active', ?, ?, 60, 300, 'USD', 1, 'sum')`
      ).bind(agentId, createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO agents
         (id, name, token, status, created_at, updated_at,
          collect_interval, report_interval, currency, traffic_reset_day,
          traffic_calc_type)
         VALUES (?, 'current-metric-bad', 'current-metric-bad-token',
                 'inactive', ?, ?, 60, 300, 'USD', 1, 'sum')`
      ).bind(anomalyId, createdAt, createdAt),
    ]);
    await projectLegacyAgentModel(env as Bindings, agentId);
    await projectLegacyAgentModel(env as Bindings, anomalyId);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agent_latest_metrics
         (agent_id, metrics_json, collected_at, reported_at, cpu_usage,
          memory_usage_rate, ping_json, month_rx, month_tx, updated_at)
         VALUES (?, ?, ?, ?, 12.5, 40, '{}', 100, 200, ?)`
      ).bind(
        agentId,
        JSON.stringify({ agent_id: agentId, timestamp: createdAt, cpu_usage: 12.5 }),
        createdAt,
        createdAt,
        createdAt
      ),
      env.DB.prepare(
        `INSERT INTO agent_latest_metrics
         (agent_id, metrics_json, collected_at, reported_at, cpu_usage,
          ping_json, month_rx, month_tx, updated_at)
         VALUES (?, '{}', ?, ?, 20, 'bad-json', 0, 0, ?)`
      ).bind(anomalyId, createdAt, createdAt, createdAt),
    ]);

    await Promise.all([
      backfillLegacyAgentCurrentMetrics(env as Bindings, 20),
      backfillLegacyAgentCurrentMetrics(env as Bindings, 20),
    ]);
    let result = await backfillLegacyAgentCurrentMetrics(env as Bindings, 20);
    while (result.remaining) {
      result = await backfillLegacyAgentCurrentMetrics(env as Bindings, 20);
    }
    expect(
      await legacyAgentCurrentMetricsCoverage(env as Bindings)
    ).toMatchObject({ conserved: true, read_ready: false });
    expect(
      await scalar<{ cpu_usage: number; month_tx: number }>(
        `SELECT cpu_usage, month_tx FROM agent_current_metrics WHERE agent_id = ?`,
        agentId
      )
    ).toMatchObject({ cpu_usage: 12.5, month_tx: 200 });

    await env.DB.batch([
      env.DB.prepare(`UPDATE agent_latest_metrics SET ping_json = '{}' WHERE agent_id = ?`).bind(
        anomalyId
      ),
      env.DB.prepare(
        `UPDATE migration_anomalies SET status = 'retry_requested', updated_at = ?
         WHERE migration_key = 'legacy-agent-current-metrics-v1' AND source_pk = ?`
      ).bind(new Date().toISOString(), String(anomalyId)),
    ]);
    await backfillLegacyAgentCurrentMetrics(env as Bindings, 20);
    expect(
      await legacyAgentCurrentMetricsCoverage(env as Bindings)
    ).toMatchObject({ conserved: true, read_ready: true });
    expect(await queryLatestLegacyAgentMetric(env as Bindings, agentId)).toMatchObject({
      agent_id: agentId,
      cpu_usage: 12.5,
    });

    const reconciledAt = new Date(Date.now() + 3000).toISOString();
    await env.DB.prepare(
      `UPDATE agent_latest_metrics
       SET metrics_json = ?, cpu_usage = 33, updated_at = ? WHERE agent_id = ?`
    )
      .bind(
        JSON.stringify({ agent_id: agentId, timestamp: createdAt, cpu_usage: 33 }),
        reconciledAt,
        agentId
      )
      .run();
    await backfillLegacyAgentCurrentMetrics(env as Bindings, 20);
    expect(
      await scalar<{ cpu_usage: number }>(
        `SELECT cpu_usage FROM agent_current_metrics WHERE agent_id = ?`,
        agentId
      )
    ).toMatchObject({ cpu_usage: 33 });
  });

  it("unifies status page components with dual-write and stale-target reconciliation", async () => {
    const monitorId = 99011;
    const agentId = 99012;
    const createdAt = new Date().toISOString();
    const config = await scalar<{ id: number }>(
      `SELECT id FROM status_page_config WHERE singleton_key = 1`
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO monitors
         (id, name, url, method, interval, timeout, timeout_ms, expected_status,
          headers, active, status, created_at, updated_at)
         VALUES (?, 'status-component-monitor', 'https://example.test/status',
                 'GET', 300, 30, 30000, 200, '{}', 1, 'up', ?, ?)`
      ).bind(monitorId, createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO agents
         (id, name, token, status, created_at, updated_at,
          collect_interval, report_interval, currency, traffic_reset_day,
          traffic_calc_type)
         VALUES (?, 'status-component-agent', 'status-component-agent-token',
                 'active', ?, ?, 60, 300, 'USD', 1, 'sum')`
      ).bind(agentId, createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO status_page_monitors(config_id, monitor_id) VALUES (?, ?)`
      ).bind(config.id, monitorId),
      env.DB.prepare(
        `INSERT INTO status_page_agents(config_id, agent_id) VALUES (?, ?)`
      ).bind(config.id, agentId),
    ]);

    await Promise.all([
      backfillLegacyStatusPage(env as Bindings, 20),
      backfillLegacyStatusPage(env as Bindings, 20),
    ]);
    let result = await backfillLegacyStatusPage(env as Bindings, 20);
    while (result.remaining) result = await backfillLegacyStatusPage(env as Bindings, 20);
    expect(await legacyStatusPageCoverage(env as Bindings)).toMatchObject({
      conserved: true,
      read_ready: true,
      stale_rows: 0,
    });
    expect(
      await scalar<{ count: number }>(
        `SELECT COUNT(*) AS count FROM status_components
         WHERE page_id = ? AND component_id IN (?, ?)`,
        config.id,
        monitorId,
        agentId
      )
    ).toMatchObject({ count: 2 });

    const repository = new D1StatusRepository(env as Bindings);
    const view = await repository.getConfig();
    expect(view.monitors.find((item) => item.id === monitorId)?.selected).toBe(true);
    expect(view.agents.find((item) => item.id === agentId)?.selected).toBe(true);
    await repository.saveConfig({
      title: "Canonical Status",
      description: "dual-write",
      logoUrl: "",
      customCss: "",
      theme: "mono",
      monitors: [monitorId],
      agents: [],
    });
    expect(
      await scalar<{ count: number }>(
        `SELECT COUNT(*) AS count FROM status_components WHERE page_id = ?`,
        config.id
      )
    ).toMatchObject({ count: 1 });
    expect(await legacyStatusPageCoverage(env as Bindings)).toMatchObject({
      read_ready: true,
    });

    await env.DB.prepare(
      `DELETE FROM status_page_monitors WHERE config_id = ? AND monitor_id = ?`
    )
      .bind(config.id, monitorId)
      .run();
    expect(await legacyStatusPageCoverage(env as Bindings)).toMatchObject({
      read_ready: false,
      stale_rows: 1,
    });
    await backfillLegacyStatusPage(env as Bindings, 20);
    expect(await legacyStatusPageCoverage(env as Bindings)).toMatchObject({
      read_ready: true,
      stale_rows: 0,
    });
  });

  it("normalizes notification rules with retry, dual-write, and read switching", async () => {
    const monitorId = 99511;
    const validSettingId = 99512;
    const invalidSettingId = 99513;
    const createdAt = new Date().toISOString();
    const channel = await scalar<{ id: number }>(
      `SELECT id FROM notification_channels
       WHERE deleted_at IS NULL ORDER BY id LIMIT 1`
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO monitors
         (id, name, url, method, interval, timeout, timeout_ms, expected_status,
          headers, active, status, created_at, updated_at)
         VALUES (?, 'notification-rule-monitor', 'https://example.test/rule',
                 'GET', 300, 30, 30000, 200, '{}', 1, 'up', ?, ?)`
      ).bind(monitorId, createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO notification_settings
         (id, target_type, target_id, enabled, channels, created_at, updated_at)
         VALUES (?, 'monitor', ?, 1, ?, ?, ?)`
      ).bind(
        validSettingId,
        monitorId,
        JSON.stringify([channel.id]),
        createdAt,
        createdAt
      ),
      env.DB.prepare(
        `INSERT INTO notification_settings
         (id, target_type, target_id, enabled, channels, created_at, updated_at)
         VALUES (?, 'global-agent', NULL, 1, '{"bad":true}', ?, ?)`
      ).bind(invalidSettingId, createdAt, createdAt),
    ]);

    await Promise.all([
      backfillLegacyNotificationRules(env as Bindings, 20),
      backfillLegacyNotificationRules(env as Bindings, 20),
    ]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const coverage = await legacyNotificationRulesCoverage(env as Bindings);
      if (coverage.conserved) break;
      await backfillLegacyNotificationRules(env as Bindings, 20);
    }
    expect(await legacyNotificationRulesCoverage(env as Bindings)).toMatchObject({
      conserved: true,
      read_ready: false,
    });
    expect(
      await scalar<{ channel_id: number }>(
        `SELECT channel_id FROM notification_rule_endpoints WHERE rule_id = ?`,
        validSettingId
      )
    ).toMatchObject({ channel_id: channel.id });

    const repairedAt = new Date(Date.now() + 3000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE notification_settings SET channels = '[]', updated_at = ? WHERE id = ?`
      ).bind(repairedAt, invalidSettingId),
      env.DB.prepare(
        `UPDATE migration_anomalies SET status = 'retry_requested', updated_at = ?
         WHERE migration_key = 'legacy-notification-rules-v1'
           AND source_pk = ?`
      ).bind(repairedAt, String(invalidSettingId)),
    ]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await backfillLegacyNotificationRules(env as Bindings, 20);
      if ((await legacyNotificationRulesCoverage(env as Bindings)).read_ready) break;
    }
    expect(await legacyNotificationRulesCoverage(env as Bindings)).toMatchObject({
      conserved: true,
      read_ready: true,
      stale_rows: 0,
    });

    const repository = new D1NotificationRepository(env as Bindings);
    expect(
      await scalar<{ channels: string }>(
        `SELECT json_group_array(channel_id) AS channels
         FROM notification_rule_endpoints WHERE rule_id = ?`,
        validSettingId
      )
    ).toMatchObject({ channels: JSON.stringify([channel.id]) });
    await repository.saveSetting({
      target_type: "monitor",
      target_id: monitorId,
      enabled: true,
      on_down: true,
      on_recovery: true,
      on_offline: false,
      on_cpu_threshold: false,
      cpu_threshold: 90,
      on_memory_threshold: false,
      memory_threshold: 85,
      on_disk_threshold: false,
      disk_threshold: 90,
      cooldown_minutes: 15,
      channels: "[]",
    });
    expect(
      await scalar<{ cooldown_minutes: number }>(
        `SELECT cooldown_minutes FROM notification_rules WHERE id = ?`,
        validSettingId
      )
    ).toMatchObject({ cooldown_minutes: 15 });
    expect(
      await scalar<{ count: number }>(
        `SELECT COUNT(*) AS count FROM notification_rule_endpoints WHERE rule_id = ?`,
        validSettingId
      )
    ).toMatchObject({ count: 0 });
    expect(await legacyNotificationRulesCoverage(env as Bindings)).toMatchObject({
      read_ready: true,
      stale_rows: 0,
    });
  });

  it("versions notification templates while preserving legacy IDs", async () => {
    const validTemplateId = 99611;
    const invalidTemplateId = 99612;
    const createdAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO notification_templates
         (id, name, type, subject, content, is_default, created_at, updated_at)
         VALUES (?, 'versioned-monitor', 'monitor', 'subject-v1', 'content-v1',
                 0, ?, ?)`
      ).bind(validTemplateId, createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO notification_templates
         (id, name, type, subject, content, is_default, created_at, updated_at)
         VALUES (?, 'invalid-template', 'unknown', 'bad', 'bad', 0, ?, ?)`
      ).bind(invalidTemplateId, createdAt, createdAt),
    ]);

    await Promise.all([
      backfillLegacyNotificationTemplates(env as Bindings, 20),
      backfillLegacyNotificationTemplates(env as Bindings, 20),
    ]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const coverage = await legacyNotificationTemplatesCoverage(env as Bindings);
      if (coverage.conserved) break;
      await backfillLegacyNotificationTemplates(env as Bindings, 20);
    }
    expect(await legacyNotificationTemplatesCoverage(env as Bindings)).toMatchObject({
      conserved: true,
      read_ready: false,
    });
    expect(
      await scalar<{ current_version: number }>(
        `SELECT current_version FROM notification_template_definitions WHERE id = ?`,
        validTemplateId
      )
    ).toMatchObject({ current_version: 1 });

    const repairedAt = new Date(Date.now() + 3000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE notification_templates SET type = 'agent', updated_at = ? WHERE id = ?`
      ).bind(repairedAt, invalidTemplateId),
      env.DB.prepare(
        `UPDATE migration_anomalies SET status = 'retry_requested', updated_at = ?
         WHERE migration_key = 'legacy-notification-templates-v1'
           AND source_pk = ?`
      ).bind(repairedAt, String(invalidTemplateId)),
    ]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await backfillLegacyNotificationTemplates(env as Bindings, 20);
      if ((await legacyNotificationTemplatesCoverage(env as Bindings)).read_ready) {
        break;
      }
    }
    expect(await legacyNotificationTemplatesCoverage(env as Bindings)).toMatchObject({
      conserved: true,
      read_ready: true,
      stale_rows: 0,
    });

    const repository = new D1NotificationRepository(env as Bindings);
    await repository.updateTemplate(validTemplateId, {
      subject: "subject-v2",
      content: "content-v2",
    });
    expect(
      await scalar<{ current_version: number; subject: string; content: string }>(
        `SELECT definition.current_version, version.subject, version.content
         FROM notification_template_definitions definition
         JOIN notification_template_versions version
           ON version.template_id = definition.id
          AND version.version = definition.current_version
         WHERE definition.id = ?`,
        validTemplateId
      )
    ).toMatchObject({
      current_version: 2,
      subject: "subject-v2",
      content: "content-v2",
    });
    expect(
      await scalar<{ count: number }>(
        `SELECT COUNT(*) AS count FROM notification_template_versions
         WHERE template_id = ?`,
        validTemplateId
      )
    ).toMatchObject({ count: 2 });
    expect(await repository.getTemplate(validTemplateId)).toMatchObject({
      id: validTemplateId,
      subject: "subject-v2",
      content: "content-v2",
    });
    expect(await legacyNotificationTemplatesCoverage(env as Bindings)).toMatchObject({
      read_ready: true,
      stale_rows: 0,
    });
  });
});
