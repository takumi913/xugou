import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { runScheduledTasks } from "../src/jobs";
import type { Bindings } from "../src/models/db";
import {
  dataCompatibilityMode,
  isContractMode,
  isLegacyApiPath,
} from "../src/platform/compatibility/CompatibilityMode";
import worker from "../src/worker";
import { createMonitorUseCases } from "../src/modules/monitors/composition";
import { scheduleDueMonitorChecks } from "../src/modules/monitors/queue/MonitorScheduler";
import { D1StatusRepository } from "../src/modules/status/persistence/D1StatusRepository";
import { StatusPublicationConsumer } from "../src/modules/status/queue/StatusPublicationConsumer";

describe("Contract-compatible single Worker mode", () => {
  it("classifies only retired unversioned API roots", () => {
    expect(dataCompatibilityMode({ DATA_COMPATIBILITY_MODE: "expand" })).toBe(
      "expand"
    );
    expect(isContractMode({ DATA_COMPATIBILITY_MODE: "CONTRACT" })).toBe(true);
    expect(isLegacyApiPath("/api/agents/1")).toBe(true);
    expect(isLegacyApiPath("/api/v2/agents/1")).toBe(false);
    expect(isLegacyApiPath("/api/security/audit")).toBe(false);
    expect(isLegacyApiPath("/api/ws")).toBe(false);
  });

  it("retires v1 routes and rejects legacy JWT while preserving v2/public routes", async () => {
    const contractEnv = {
      ...(env as Bindings),
      DATA_COMPATIBILITY_MODE: "contract",
    };

    const legacyContext = createExecutionContext();
    const legacy = await worker.fetch(
      new Request("https://runtime.test/api/status/public/data"),
      contractEnv,
      legacyContext
    );
    await waitOnExecutionContext(legacyContext);
    expect(legacy.status).toBe(410);
    expect(legacy.headers.get("content-type")).toContain(
      "application/problem+json"
    );
    await expect(legacy.json()).resolves.toMatchObject({
      status: 410,
      code: "LEGACY_API_RETIRED",
    });

    const publicContext = createExecutionContext();
    const publicResponse = await worker.fetch(
      new Request("https://runtime.test/api/v2/status/public"),
      contractEnv,
      publicContext
    );
    await waitOnExecutionContext(publicContext);
    expect(publicResponse.status).not.toBe(410);

    const jwtContext = createExecutionContext();
    const jwtResponse = await worker.fetch(
      new Request("https://runtime.test/api/security/audit", {
        headers: { Authorization: "Bearer legacy.jwt.signature" },
      }),
      contractEnv,
      jwtContext
    );
    await waitOnExecutionContext(jwtContext);
    expect(jwtResponse.status).toBe(401);
  });

  it("does not run legacy backfills during Contract scheduled ticks", async () => {
    const agentId = 99601;
    const now = "2026-08-09T09:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO agents(id, name, token, status, created_at, updated_at)
       VALUES (?, 'contract-no-backfill', ?, 'inactive', ?, ?)`
    )
      .bind(agentId, `legacy-contract-${agentId}`, now, now)
      .run();

    const controller = createScheduledController({
      scheduledTime: new Date(now),
      cron: "* * * * *",
    });
    const context = createExecutionContext();
    await runScheduledTasks(
      controller,
      {
        ...(env as Bindings),
        DATA_COMPATIBILITY_MODE: "contract",
      },
      context
    );
    await waitOnExecutionContext(context);

    const target = await env.DB.prepare(
      `SELECT id FROM agent_nodes WHERE id = ? LIMIT 1`
    )
      .bind(agentId)
      .first<{ id: number }>();
    const credential = await env.DB.prepare(
      `SELECT id FROM agent_credentials WHERE agent_id = ? LIMIT 1`
    )
      .bind(agentId)
      .first<{ id: number }>();
    expect(target).toBeNull();
    expect(credential).toBeNull();
  });

  it("uses canonical Monitor reads and writes without refreshing legacy projections", async () => {
    const monitorId = 99611;
    const createdAt = "2026-08-09T09:10:00.000Z";
    const legacyNextCheck = "2020-01-01T00:00:00.000Z";
    const contractEnv = {
      ...(env as Bindings),
      DATA_COMPATIBILITY_MODE: "contract",
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO monitors
         (id, name, url, method, interval, timeout, timeout_ms, expected_status,
          headers, active, status, next_check_at, created_at, updated_at)
         VALUES (?, 'legacy-monitor-name', 'https://legacy.example.test', 'GET',
          300, 30, 30000, 200, '{}', 1, 'pending', ?, ?, ?)`
      ).bind(monitorId, legacyNextCheck, createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO monitor_definitions
         (id, name, url, method, headers_json, body, interval_ms, timeout_ms,
          expected_status, active, sort_order, created_at_ms, updated_at_ms,
          deleted_at_ms)
         VALUES (?, 'canonical-monitor-name', 'https://canonical.example.test',
          'GET', '{}', NULL, 300000, 30000, 200, 1, 0, ?, ?, NULL)`
      ).bind(monitorId, Date.parse(createdAt), Date.parse(createdAt)),
      env.DB.prepare(
        `INSERT INTO monitor_runtime
         (monitor_id, status, response_time_ms, last_checked_at_ms,
          next_due_at_ms, version, created_at_ms, updated_at_ms)
         VALUES (?, 'pending', 0, NULL, ?, 0, ?, ?)`
      ).bind(
        monitorId,
        Date.parse(createdAt),
        Date.parse(createdAt),
        Date.parse(createdAt)
      ),
    ]);

    const monitors = createMonitorUseCases(contractEnv);
    expect(await monitors.get(monitorId)).toMatchObject({
      name: "canonical-monitor-name",
      url: "https://canonical.example.test",
    });
    await monitors.update(monitorId, {
      name: "canonical-monitor-updated",
      interval_seconds: 600,
    });

    const legacyAfterUpdate = await env.DB.prepare(
      `SELECT name, interval, next_check_at, deleted_at FROM monitors WHERE id = ?`
    )
      .bind(monitorId)
      .first<{
        name: string;
        interval: number;
        next_check_at: string | null;
        deleted_at: string | null;
      }>();
    expect(legacyAfterUpdate).toEqual({
      name: "legacy-monitor-name",
      interval: 300,
      next_check_at: legacyNextCheck,
      deleted_at: null,
    });
    expect(
      await env.DB.prepare(
        `SELECT name, interval_ms FROM monitor_definitions WHERE id = ?`
      )
        .bind(monitorId)
        .first<{ name: string; interval_ms: number }>()
    ).toEqual({ name: "canonical-monitor-updated", interval_ms: 600000 });

    await scheduleDueMonitorChecks(
      contractEnv,
      new Date("2026-08-09T09:20:00.000Z")
    );
    expect(
      await env.DB.prepare(`SELECT next_check_at FROM monitors WHERE id = ?`)
        .bind(monitorId)
        .first<{ next_check_at: string | null }>()
    ).toEqual({ next_check_at: legacyNextCheck });

    await monitors.delete(monitorId);
    expect(
      await env.DB.prepare(
        `SELECT deleted_at_ms FROM monitor_definitions WHERE id = ?`
      )
        .bind(monitorId)
        .first<{ deleted_at_ms: number | null }>()
    ).toEqual({ deleted_at_ms: expect.any(Number) });
    expect(
      await env.DB.prepare(`SELECT deleted_at FROM monitors WHERE id = ?`)
        .bind(monitorId)
        .first<{ deleted_at: string | null }>()
    ).toEqual({ deleted_at: null });
  });

  it("keyset-pages every due monitor within the scheduler budget", async () => {
    const baseId = 99700;
    const dueAt = Date.parse("2026-08-09T08:00:00.000Z");
    const scheduledAt = new Date("2026-08-09T09:00:00.000Z");
    const statements: D1PreparedStatement[] = [];
    for (let offset = 0; offset < 31; offset += 1) {
      const id = baseId + offset;
      statements.push(
        env.DB.prepare(
          `INSERT INTO monitor_definitions
           (id, name, url, method, headers_json, body, interval_ms, timeout_ms,
            expected_status, active, sort_order, created_at_ms, updated_at_ms, deleted_at_ms)
           VALUES (?, ?, ?, 'GET', '{}', NULL, 300000, 30000, 200, 1, ?, ?, ?, NULL)`
        ).bind(id, `scheduler-${id}`, `https://scheduler-${id}.example.test`, offset, dueAt, dueAt),
        env.DB.prepare(
          `INSERT INTO monitor_runtime
           (monitor_id, status, response_time_ms, last_checked_at_ms,
            next_due_at_ms, version, created_at_ms, updated_at_ms)
           VALUES (?, 'pending', 0, NULL, ?, 0, ?, ?)`
        ).bind(id, dueAt + offset, dueAt, dueAt)
      );
    }
    await env.DB.batch(statements);
    const result = await scheduleDueMonitorChecks(
      {
        ...(env as Bindings),
        DATA_COMPATIBILITY_MODE: "contract",
        MONITOR_CHECK_BATCH_SIZE: "10",
        MONITOR_SCHEDULER_TIME_BUDGET_MS: "25000",
      },
      scheduledAt
    );
    expect(result).toMatchObject({ scheduled: 31, published: 31, batches: 4 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM async_jobs
         WHERE kind = 'monitor.check' AND aggregate_id BETWEEN ? AND ?`
      )
        .bind(String(baseId), String(baseId + 30))
        .first<{ count: number }>()
    ).toEqual({ count: 31 });
  });

  it("uses canonical Status configuration and publications without legacy projections", async () => {
    const monitorId = 99621;
    const agentId = 99622;
    const hiddenAgentId = 99623;
    const now = "2026-08-09T09:30:00.000Z";
    const nowMs = Date.parse(now);
    const recentMetricAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const expiredMetricAt = new Date(
      Date.now() - 25 * 60 * 60 * 1000
    ).toISOString();
    const contractEnv = {
      ...(env as Bindings),
      DATA_COMPATIBILITY_MODE: "contract",
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO monitor_definitions
         (id, name, url, method, headers_json, body, interval_ms, timeout_ms,
          expected_status, active, sort_order, created_at_ms, updated_at_ms,
          deleted_at_ms)
         VALUES (?, 'canonical-status-monitor', 'https://status.example.test',
          'GET', '{}', NULL, 300000, 30000, 200, 1, 0, ?, ?, NULL)`
      ).bind(monitorId, nowMs, nowMs),
      env.DB.prepare(
        `INSERT INTO monitor_runtime
         (monitor_id, status, response_time_ms, last_checked_at_ms,
          next_due_at_ms, version, created_at_ms, updated_at_ms)
         VALUES (?, 'up', 42, ?, ?, 1, ?, ?)`
      ).bind(monitorId, nowMs, nowMs + 300000, nowMs, nowMs),
      env.DB.prepare(
        `INSERT INTO agent_nodes
         (id, name, collect_interval_ms, report_interval_ms, group_name,
          tags_json, auto_renewal, is_hidden, traffic_reset_day,
          traffic_calc_type, auto_update, sort_order, created_at_ms,
          updated_at_ms, deleted_at_ms)
         VALUES (?, 'canonical-status-agent', 300000, 300000, NULL, '[]',
          0, 0, 1, 'sum', 0, 0, ?, ?, NULL)`
      ).bind(agentId, nowMs, nowMs),
      env.DB.prepare(
        `INSERT INTO agent_nodes
         (id, name, collect_interval_ms, report_interval_ms, group_name,
          tags_json, auto_renewal, is_hidden, traffic_reset_day,
          traffic_calc_type, auto_update, sort_order, created_at_ms,
          updated_at_ms, deleted_at_ms)
         VALUES (?, 'canonical-hidden-agent', 300000, 300000, NULL, '[]',
          0, 1, 1, 'sum', 0, 1, ?, ?, NULL)`
      ).bind(hiddenAgentId, nowMs, nowMs),
      env.DB.prepare(
        `INSERT INTO agent_runtime
         (agent_id, status, ip_addresses_json, version, created_at_ms, updated_at_ms)
         VALUES (?, 'active', '[]', 1, ?, ?)`
      ).bind(agentId, nowMs, nowMs),
      env.DB.prepare(
        `INSERT INTO agent_runtime
         (agent_id, status, ip_addresses_json, version, created_at_ms, updated_at_ms)
         VALUES (?, 'active', '[]', 1, ?, ?)`
      ).bind(hiddenAgentId, nowMs, nowMs),
      env.DB.prepare(
        `INSERT INTO agents
         (id, name, token, status, created_at, updated_at)
         VALUES (?, 'metric-rollup-fk', ?, 'active', ?, ?)`
      ).bind(agentId, `metric-rollup-${agentId}`, now, now),
      env.DB.prepare(
        `INSERT INTO agent_metric_rollups
         (agent_id, bucket_start, bucket_size_seconds, sample_count,
          cpu_avg, cpu_max, memory_avg, memory_max, disk_max, load_avg,
          network_delta_json, created_at)
         VALUES (?, ?, 300, 1, 11, 11, 31, 31, 41, 1, '[]', ?)`
      ).bind(agentId, expiredMetricAt, now),
      env.DB.prepare(
        `INSERT INTO agent_metric_rollups
         (agent_id, bucket_start, bucket_size_seconds, sample_count,
          cpu_avg, cpu_max, memory_avg, memory_max, disk_max, load_avg,
          network_delta_json, created_at)
         VALUES (?, ?, 300, 1, 22, 22, 32, 32, 42, 2, '[]', ?)`
      ).bind(agentId, recentMetricAt, now),
    ]);

    const legacyBefore = await env.DB.prepare(
      `SELECT id, title FROM status_page_config WHERE singleton_key = 1`
    ).first<{ id: number; title: string }>();
    expect(legacyBefore).not.toBeNull();
    await env.DB.prepare(
      `INSERT INTO status_pages
       (id, singleton_key, title, description, logo_url, custom_css, theme,
        created_at_ms, updated_at_ms)
       VALUES (1, 1, 'canonical-status-before', '', '', '', 'mono', ?, ?)
       ON CONFLICT(singleton_key) DO NOTHING`
    )
      .bind(nowMs, nowMs)
      .run();
    await env.DB.prepare(
      `UPDATE status_pages SET title = 'canonical-status-before', updated_at_ms = ?
       WHERE singleton_key = 1`
    )
      .bind(nowMs)
      .run();

    const repository = new D1StatusRepository(contractEnv);
    await expect(repository.getConfig()).resolves.toMatchObject({
      title: "canonical-status-before",
    });
    await repository.saveConfig({
      title: "canonical-status-after",
      description: "contract fixture",
      logoUrl: "",
      customCss: "",
      theme: "mono",
      monitors: [monitorId],
      agents: [agentId, hiddenAgentId],
    });

    expect(
      await env.DB.prepare(
        `SELECT title FROM status_page_config WHERE singleton_key = 1`
      ).first<{ title: string }>()
    ).toEqual({ title: legacyBefore?.title });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM status_page_monitors WHERE monitor_id = ?`
      )
        .bind(monitorId)
        .first<{ count: number }>()
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        `SELECT component_type, component_id FROM status_components
         WHERE component_id IN (?, ?, ?) ORDER BY component_type, component_id`
      )
        .bind(monitorId, agentId, hiddenAgentId)
        .all<{ component_type: string; component_id: number }>()
    ).toMatchObject({
      results: [
        { component_type: "agent", component_id: agentId },
        { component_type: "agent", component_id: hiddenAgentId },
        { component_type: "monitor", component_id: monitorId },
      ],
    });

    await env.DB.prepare(
      `INSERT INTO public_status_snapshots
       (id, snapshot_json, etag, generated_at, expires_at, refreshing)
       VALUES (1, 'legacy-snapshot-marker', 'legacy-etag', ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json,
         etag = excluded.etag, generated_at = excluded.generated_at,
         expires_at = excluded.expires_at`
    )
      .bind(now, now)
      .run();
    await new StatusPublicationConsumer(contractEnv).process({
      event_id: `status.contract.fixture:${crypto.randomUUID()}`,
      event_type: "status.rebuild.requested",
      aggregate_type: "status_page",
      aggregate_id: "1",
      payload_json: "{}",
      status: "published",
    });
    expect(
      await env.DB.prepare(
        `SELECT snapshot_json FROM public_status_snapshots WHERE id = 1`
      ).first<{ snapshot_json: string }>()
    ).toEqual({ snapshot_json: "legacy-snapshot-marker" });
    const publication = await repository.getActivePublication();
    expect(publication).not.toBeNull();
    expect(JSON.parse(publication?.payloadJson ?? "{}")).toMatchObject({
      title: "canonical-status-after",
      monitors: [{ id: monitorId, name: "canonical-status-monitor" }],
      agents: [{ id: agentId, name: "canonical-status-agent" }],
    });
    expect(publication?.payloadJson).not.toContain("canonical-hidden-agent");
    const metricPublication = await repository.getActiveMetricPublication(agentId);
    expect(metricPublication).not.toBeNull();
    expect(JSON.parse(metricPublication?.payloadJson ?? "{}")).toMatchObject({
      success: true,
      agent: [{ timestamp: recentMetricAt, cpu_usage: 22 }],
    });
    expect(metricPublication?.payloadJson).not.toContain(expiredMetricAt);
    expect(metricPublication?.generatedAt).toBe(publication?.generatedAt);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM status_metric_publications metric
         JOIN status_publication_state state
           ON state.active_publication_id = metric.status_publication_id
         WHERE metric.agent_id = ?`
      )
        .bind(hiddenAgentId)
        .first<{ count: number }>()
    ).toEqual({ count: 0 });
  });
});
