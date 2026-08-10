import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/models/db";
import {
  DASHBOARD_PREVIEW_LIMIT,
  queryDashboard,
} from "../src/modules/dashboard/persistence/D1DashboardQuery";
import { createMonitorUseCases } from "../src/modules/monitors/composition";
import { createAgentUseCases } from "../src/modules/agents/composition";
import { D1StatusRepository } from "../src/modules/status/persistence/D1StatusRepository";
import { createNotificationUseCases } from "../src/modules/notifications/composition";
import {
  AgentCredentialLimitError,
  listAgentCredentialMetadata,
  revokeAgentCredential,
  rotateAgentCredential,
} from "../src/modules/agents/persistence/D1AgentCredentialStore";

describe("bounded dashboard projection", () => {
  it("returns exact global aggregates while capping card previews", async () => {
    const total = DASHBOARD_PREVIEW_LIMIT + 305;
    const nowMs = Date.parse("2026-08-09T00:00:00.000Z");
    await env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE seq(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
         )
         INSERT INTO monitor_definitions
         (id, name, url, method, headers_json, body, interval_ms, timeout_ms,
          expected_status, active, sort_order, created_at_ms, updated_at_ms)
         SELECT 10000 + n, 'monitor-' || n, 'https://monitor-' || n || '.test',
                'GET', '{}', NULL, 300000, 5000, 200, 1, n, ?, ?
         FROM seq`
      ).bind(total, nowMs, nowMs),
      env.DB.prepare(
        `WITH RECURSIVE seq(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
         )
         INSERT INTO monitor_runtime
         (monitor_id, status, response_time_ms, last_checked_at_ms,
          next_due_at_ms, version, created_at_ms, updated_at_ms)
         SELECT 10000 + n,
                CASE n % 3 WHEN 0 THEN 'up' WHEN 1 THEN 'down' ELSE 'pending' END,
                n, ?, ?, 0, ?, ?
         FROM seq`
      ).bind(total, nowMs, nowMs + 300000, nowMs, nowMs),
      env.DB.prepare(
        `WITH RECURSIVE seq(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
         )
         INSERT INTO agent_nodes
         (id, name, collect_interval_ms, report_interval_ms, group_name,
          tags_json, auto_renewal, is_hidden, traffic_reset_day,
          traffic_calc_type, auto_update, sort_order, created_at_ms, updated_at_ms)
         SELECT 20000 + n, 'agent-' || n, 300000, 300000, NULL, '[]', 0, 0, 1,
                CASE n % 3 WHEN 0 THEN 'rx' WHEN 1 THEN 'tx' ELSE 'sum' END,
                0, n, ?, ?
         FROM seq`
      ).bind(total, nowMs, nowMs),
      env.DB.prepare(
        `WITH RECURSIVE seq(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
         )
         INSERT INTO agent_runtime
         (agent_id, status, ip_addresses_json, version, created_at_ms, updated_at_ms)
         SELECT 20000 + n, CASE WHEN n % 2 = 0 THEN 'active' ELSE 'inactive' END,
                '[]', 0, ?, ?
         FROM seq`
      ).bind(total, nowMs, nowMs),
      env.DB.prepare(
        `WITH RECURSIVE seq(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
         )
         INSERT INTO agent_current_metrics
         (agent_id, metrics_json, collected_at_ms, reported_at_ms,
          network_rx_speed, network_tx_speed, month_rx, month_tx,
          version, created_at_ms, updated_at_ms)
         SELECT 20000 + n,
                json_object('timestamp', '2026-08-09T00:00:00.000Z',
                            'month_rx', n, 'month_tx', n * 2,
                            'network_rx_speed', n, 'network_tx_speed', n * 2),
                ?, ?, n, n * 2, n, n * 2, 0, ?, ?
         FROM seq`
      ).bind(total, nowMs, nowMs, nowMs, nowMs),
      env.DB.prepare(
        `UPDATE monitor_definitions SET sort_order = 0
         WHERE id IN (10002, 10005)`
      ),
      env.DB.prepare(
        `UPDATE monitor_definitions SET sort_order = 500 WHERE id = 10001`
      ),
      env.DB.prepare(
        `UPDATE agent_nodes SET sort_order = 0 WHERE id IN (20002, 20005)`
      ),
      env.DB.prepare(
        `UPDATE agent_nodes SET sort_order = 500 WHERE id = 20001`
      ),
      env.DB.prepare(
        `INSERT INTO status_pages
         (id, singleton_key, title, description, logo_url, custom_css, theme,
          created_at_ms, updated_at_ms)
         VALUES (1, 1, 'Status', '', '', '', 'mono', ?, ?)
         ON CONFLICT(singleton_key) DO NOTHING`
      ).bind(nowMs, nowMs),
      env.DB.prepare(
        `INSERT INTO status_components
         (page_id, component_type, component_id, sort_order, created_at_ms, updated_at_ms)
         SELECT 1, 'monitor', id, sort_order, ?, ? FROM monitor_definitions`
      ).bind(nowMs, nowMs),
      env.DB.prepare(
        `INSERT INTO status_components
         (page_id, component_type, component_id, sort_order, created_at_ms, updated_at_ms)
         SELECT 1, 'agent', id, sort_order, ?, ? FROM agent_nodes`
      ).bind(nowMs, nowMs),
    ]);

    const contractEnv = {
      ...(env as Bindings),
      DATA_COMPATIBILITY_MODE: "contract",
      AGENT_TOKEN_PEPPER: "runtime-fixture-agent-pepper-with-at-least-32-chars",
    };
    const projection = await queryDashboard(contractEnv);
    let expectedTraffic = 0;
    let expectedRxSpeed = 0;
    let expectedTxSpeed = 0;
    let expectedMonitorsUp = 0;
    let expectedMonitorsDown = 0;
    let expectedMonitorsPending = 0;
    let responseTimeSum = 0;
    for (let n = 1; n <= total; n += 1) {
      if (n % 3 === 0) {
        expectedMonitorsUp += 1;
        responseTimeSum += n;
      } else if (n % 3 === 1) {
        expectedMonitorsDown += 1;
      } else {
        expectedMonitorsPending += 1;
      }
    }
    for (let n = 2; n <= total; n += 2) {
      expectedRxSpeed += n;
      expectedTxSpeed += n * 2;
      expectedTraffic += n % 3 === 0 ? n : n % 3 === 1 ? n * 2 : n * 3;
    }

    expect(projection.monitors).toHaveLength(DASHBOARD_PREVIEW_LIMIT);
    expect(projection.agents).toHaveLength(DASHBOARD_PREVIEW_LIMIT);
    expect(projection.monitors_has_more).toBe(true);
    expect(projection.agents_has_more).toBe(true);
    expect(projection.summary).toEqual({
      monitors_total: total,
      monitors_up: expectedMonitorsUp,
      monitors_down: expectedMonitorsDown,
      monitors_pending: expectedMonitorsPending,
      monitors_avg_response_time_ms: Math.round(
        responseTimeSum / expectedMonitorsUp
      ),
      agents_total: total,
      agents_online: Math.floor(total / 2),
      agents_offline: Math.ceil(total / 2),
      total_traffic_bytes: expectedTraffic,
      network_rx_speed_bps: expectedRxSpeed,
      network_tx_speed_bps: expectedTxSpeed,
    });

    const monitorFirst = await createMonitorUseCases(contractEnv).list({ limit: 2 });
    expect(monitorFirst.data.map((row) => row.id)).toEqual([10002, 10005]);
    expect(monitorFirst.next_cursor).toBe("0:10005");
    const monitorSecond = await createMonitorUseCases(contractEnv).list({
      cursor: monitorFirst.next_cursor!,
      limit: 2,
    });
    expect(monitorSecond.data.map((row) => row.id)).toEqual([10003, 10004]);

    const agentFirst = await createAgentUseCases(contractEnv).list({ limit: 2 });
    expect(agentFirst.data.map((row) => row.id)).toEqual([20002, 20005]);
    expect(agentFirst.next_cursor).toBe("0:20005");
    const agentSecond = await createAgentUseCases(contractEnv).list({
      cursor: agentFirst.next_cursor!,
      limit: 2,
    });
    expect(agentSecond.data.map((row) => row.id)).toEqual([20003, 20004]);

    const statusRepository = new D1StatusRepository(contractEnv);
    const statusConfig = await statusRepository.getConfig();
    expect(statusConfig.monitors).toHaveLength(500);
    expect(statusConfig.agents).toHaveLength(500);
    expect(statusConfig.monitors_has_more).toBe(true);
    expect(statusConfig.agents_has_more).toBe(true);
    const publication = (await statusRepository.buildPublicData()) as {
      monitors: unknown[];
      agents: unknown[];
    };
    expect(publication.monitors).toHaveLength(100);
    expect(publication.agents).toHaveLength(100);

    const notifications = createNotificationUseCases(contractEnv);
    const monitorRulesFirst = await notifications.listResourceSettings({
      target_type: "monitor",
      limit: 2,
    });
    expect(monitorRulesFirst.data.map((row) => row.id)).toEqual([10002, 10005]);
    expect(monitorRulesFirst.next_cursor).toBe("0:10005");
    const monitorRulesSecond = await notifications.listResourceSettings({
      target_type: "monitor",
      cursor: monitorRulesFirst.next_cursor!,
      limit: 2,
    });
    expect(monitorRulesSecond.data.map((row) => row.id)).toEqual([10003, 10004]);

    await env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE seq(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 105
         )
         INSERT INTO notification_channels
         (id, name, type, config, enabled, created_at, updated_at)
         SELECT 60000 + n, 'channel-' || n, 'webhook', '{}', 1,
                '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
         FROM seq`
      ),
      env.DB.prepare(
        `INSERT INTO notification_endpoints
         (channel_id, public_config_json, created_at, updated_at)
         SELECT id, '{}', '2026-08-09T00:00:00.000Z',
                '2026-08-09T00:00:00.000Z'
         FROM notification_channels WHERE id BETWEEN 60001 AND 60105`
      ),
      env.DB.prepare(
        `WITH RECURSIVE seq(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 105
         )
         INSERT INTO notification_templates
         (id, name, type, subject, content, is_default, created_at, updated_at)
         SELECT 70000 + n, 'template-' || n, 'monitor', '', '', 0,
                '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
         FROM seq`
      ),
      env.DB.prepare(
        `INSERT INTO notification_template_definitions
         (id, name, type, current_version, is_default, deleted_at_ms,
          created_at_ms, updated_at_ms)
         SELECT id, name, type, 1, is_default, NULL, ?, ?
         FROM notification_templates WHERE id BETWEEN 70001 AND 70105`
      ).bind(nowMs, nowMs),
      env.DB.prepare(
        `INSERT INTO notification_template_versions
         (template_id, version, subject, content, created_at_ms)
         SELECT id, 1, 'subject-' || id, 'content-' || id, ?
         FROM notification_templates WHERE id BETWEEN 70001 AND 70105`
      ).bind(nowMs),
    ]);
    const notificationConfig = (await notifications.getConfig()) as {
      channels: unknown[];
      templates: unknown[];
      channels_has_more: boolean;
      templates_has_more: boolean;
    };
    expect(notificationConfig.channels).toHaveLength(100);
    expect(notificationConfig.templates).toHaveLength(100);
    expect(notificationConfig.channels_has_more).toBe(true);
    expect(notificationConfig.templates_has_more).toBe(true);
    await expect(
      notifications.createChannel({
        name: "over-limit",
        type: "webhook",
        config: "{}",
        enabled: true,
      })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      notifications.createTemplate({
        name: "over-limit",
        type: "monitor",
        subject: "subject",
        content: "content",
        is_default: false,
      })
    ).rejects.toMatchObject({ status: 409 });

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agents
         (id, name, token, status, created_at, updated_at)
         VALUES (20002, 'credential-anchor', 'credential-anchor-20002',
                 'inactive', '2026-08-09T00:00:00.000Z',
                 '2026-08-09T00:00:00.000Z')`
      ),
      env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 30
       )
       INSERT INTO agent_credentials
       (agent_id, token_digest, token_hint, last_used_at, revoked_at,
        created_at, updated_at)
       SELECT 20002, 'credential-fixture-' || n, 'xga_…' || n,
              '2026-08-09T00:00:00.000Z',
              CASE WHEN n <= 25 THEN '2026-08-09T00:00:01.000Z' ELSE NULL END,
              '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
       FROM seq`
      ),
    ]);
    const credentialFirst = await listAgentCredentialMetadata(
      contractEnv,
      20002,
      { limit: 25 }
    );
    expect(credentialFirst?.data).toHaveLength(25);
    expect(credentialFirst?.has_more).toBe(true);
    const credentialSecond = await listAgentCredentialMetadata(
      contractEnv,
      20002,
      { cursor: Number(credentialFirst?.next_cursor), limit: 25 }
    );
    expect(credentialSecond?.data).toHaveLength(5);
    expect(credentialSecond?.has_more).toBe(false);
    await expect(rotateAgentCredential(contractEnv, 20002)).rejects.toBeInstanceOf(
      AgentCredentialLimitError
    );
    const activeCredential = credentialFirst?.data.find(
      (credential) => credential.revoked_at === null
    );
    expect(activeCredential).toBeDefined();
    await expect(
      revokeAgentCredential(contractEnv, 20002, activeCredential!.id)
    ).resolves.toMatchObject({ success: true });
    await expect(rotateAgentCredential(contractEnv, 20002)).resolves.toMatchObject({
      token: expect.stringMatching(/^xga_/),
    });
  });
});
