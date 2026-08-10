import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Bindings } from "../src/models/db";
import { contractSchemaStatements } from "../src/platform/compatibility/ContractSchemaPlan";
import { sha256Hex } from "../src/utils/crypto";
import { createMonitorUseCases } from "../src/modules/monitors/composition";
import {
  queryMonitorDailyStats,
  queryMonitorHistory,
} from "../src/modules/monitors/persistence/D1LegacyMonitorFacade";
import {
  importLegacyAgents,
} from "../src/modules/agents/persistence/D1LegacyAgentFacade";
import { authenticateAgentToken } from "../src/modules/agents/persistence/D1AgentCredentialStore";
import { issueAgentEnrollmentToken } from "../src/modules/agents/persistence/D1AgentCredentialStore";
import { D1NotificationRepository } from "../src/modules/notifications/persistence/D1NotificationRepository";
import { D1StatusRepository } from "../src/modules/status/persistence/D1StatusRepository";
import { D1ReleaseReadinessQuery } from "../src/modules/operations/persistence/D1ReleaseReadinessQuery";
import worker from "../src/worker";
import type { XugouQueueMessage } from "../src/contracts/queue";

describe("independent Contract schema", () => {
  it("preserves facts and runs the single Worker after legacy tables and columns are removed", async () => {
    const contractEnv = {
      ...(env as Bindings),
      DATA_COMPATIBILITY_MODE: "contract",
    };
    const fixtureAgentId = 99701;
    const fixtureMonitorId = 99702;
    const fixtureAdminId = 99703;
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users(id, username, password, email, created_at, updated_at)
         VALUES (?, 'contract-fixture-admin', 'fixture-only', NULL, ?, ?)`
      ).bind(fixtureAdminId, now, now),
      env.DB.prepare(
        `INSERT INTO agents(id, name, token, status, created_at, updated_at)
         VALUES (?, 'legacy-anchor-agent', ?, 'inactive', ?, ?)`
      ).bind(fixtureAgentId, `legacy-anchor-token-${fixtureAgentId}`, now, now),
      env.DB.prepare(
        `INSERT INTO agent_nodes
         (id, name, collect_interval_ms, report_interval_ms, group_name,
          tags_json, auto_renewal, is_hidden, traffic_reset_day,
          traffic_calc_type, auto_update, sort_order, created_at_ms,
          updated_at_ms, deleted_at_ms)
         VALUES (?, 'preserved-agent', 60000, 300000, NULL, '[]', 0, 0, 1,
          'sum', 0, 0, ?, ?, NULL)`
      ).bind(fixtureAgentId, nowMs, nowMs),
      env.DB.prepare(
        `INSERT INTO agent_runtime
         (agent_id, status, ip_addresses_json, version, created_at_ms, updated_at_ms)
         VALUES (?, 'inactive', '[]', 0, ?, ?)`
      ).bind(fixtureAgentId, nowMs, nowMs),
      env.DB.prepare(
        `INSERT INTO agent_credentials
         (agent_id, token_digest, token_hint, created_at, updated_at)
         VALUES (?, ?, 'fixture', ?, ?)`
      ).bind(fixtureAgentId, `fixture-digest-${fixtureAgentId}`, now, now),
      env.DB.prepare(
        `INSERT INTO agent_reports
         (report_id, agent_id, payload_digest, payload_json, sample_count,
          status, received_at, processed_at, created_at, updated_at)
         VALUES (?, ?, 'fixture', '{}', 1, 'processed', ?, ?, ?, ?)`
      ).bind(`fixture-report-${fixtureAgentId}`, fixtureAgentId, now, now, now, now),
      env.DB.prepare(
        `INSERT INTO agent_report_samples
         (report_id, sample_index, agent_id, collected_at, metrics_json, created_at)
         VALUES (?, 0, ?, ?, ?, ?)`
      ).bind(
        `fixture-report-${fixtureAgentId}`,
        fixtureAgentId,
        now,
        JSON.stringify({ collected_at: now, cpu: { usage: 5 } }),
        now
      ),
      env.DB.prepare(
        `INSERT INTO monitors
         (id, name, url, method, interval, timeout, timeout_ms,
          expected_status, headers, active, status, created_at, updated_at)
         VALUES (?, 'legacy-anchor-monitor', 'https://legacy.example.test',
          'GET', 300, 30, 30000, 200, '{}', 1, 'up', ?, ?)`
      ).bind(fixtureMonitorId, now, now),
      env.DB.prepare(
        `INSERT INTO monitor_definitions
         (id, name, url, method, headers_json, body, interval_ms, timeout_ms,
          expected_status, active, sort_order, created_at_ms, updated_at_ms,
          deleted_at_ms)
         VALUES (?, 'preserved-monitor', 'https://canonical.example.test',
          'GET', '{}', NULL, 300000, 30000, 200, 1, 0, ?, ?, NULL)`
      ).bind(fixtureMonitorId, nowMs, nowMs),
      env.DB.prepare(
        `INSERT INTO monitor_runtime
         (monitor_id, status, response_time_ms, last_checked_at_ms,
          next_due_at_ms, version, created_at_ms, updated_at_ms)
         VALUES (?, 'up', 12, ?, ?, 1, ?, ?)`
      ).bind(fixtureMonitorId, nowMs, nowMs + 300000, nowMs, nowMs),
      env.DB.prepare(
        `INSERT INTO monitor_check_samples
         (job_id, monitor_id, scheduled_for_ms, checked_at, status,
          response_time_ms, status_code, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'up', 12, 200, NULL, ?, ?)`
      ).bind(
        `fixture-check-${fixtureMonitorId}`,
        fixtureMonitorId,
        nowMs,
        now,
        now,
        now
      ),
      env.DB.prepare(
        `INSERT INTO notification_template_definitions
         (id, name, type, current_version, is_default, deleted_at_ms,
          created_at_ms, updated_at_ms)
         SELECT id, name, type, 1, is_default,
                CASE WHEN deleted_at IS NULL THEN NULL
                     ELSE CAST(strftime('%s', deleted_at) AS INTEGER) * 1000 END,
                CAST(strftime('%s', created_at) AS INTEGER) * 1000,
                CAST(strftime('%s', updated_at) AS INTEGER) * 1000
         FROM notification_templates`
      ),
      env.DB.prepare(
        `INSERT INTO notification_template_versions
         (template_id, version, subject, content, created_at_ms)
         SELECT id, 1, subject, content,
                CAST(strftime('%s', created_at) AS INTEGER) * 1000
         FROM notification_templates`
      ),
      env.DB.prepare(
        `INSERT INTO status_pages
         (id, singleton_key, title, description, logo_url, custom_css, theme,
          created_at_ms, updated_at_ms)
         SELECT id, 1, title, description, logo_url, custom_css, theme,
                CAST(strftime('%s', created_at) AS INTEGER) * 1000,
                CAST(strftime('%s', updated_at) AS INTEGER) * 1000
         FROM status_page_config`
      ),
    ]);

    await env.DB.exec(
      [`PRAGMA defer_foreign_keys = on;`, ...contractSchemaStatements([]),
       `PRAGMA defer_foreign_keys = off;`].join("\n")
    );

    const conservationKeys = [
      "agent-history",
      "agent-model",
      "agent-current-metrics",
      "monitor-history",
      "monitor-model",
      "monitor-daily-stats",
      "notification-history",
      "status-page",
      "notification-rules",
      "notification-templates",
    ];
    const bundleText = JSON.stringify({
      formatVersion: 2,
      status: "ready",
      gates: {
        sqliteIntegrity: true,
        foreignKeys: true,
        credentialsAndSecrets: true,
        managementV1Sunset: true,
        agentV1Sunset: true,
        queuesAndPublications: true,
        allDataConserved: true,
      },
      conservation: conservationKeys.map((key) => ({
        key,
        sourceRows: 1,
        migratedRows: 1,
        deduplicatedRows: 0,
        archivedRows: 0,
        anomalyRows: 0,
        conserved: true,
      })),
      readinessSnapshot: { contract_worker_ready: true },
    });
    const bundleSha256 = await sha256Hex(bundleText);
    const evidenceId = `contract:${bundleSha256}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO contract_release_evidence
         (id, bundle_sha256, release_version, git_sha, bundle_json,
          prepared_at, created_at, updated_at)
         VALUES (?, ?, 'contract-fixture', ?, ?, ?, ?, ?)`
      ).bind(
        evidenceId,
        bundleSha256,
        "0123456789abcdef0123456789abcdef01234567",
        bundleText,
        now,
        now,
        now
      ),
      env.DB.prepare(
        `INSERT INTO contract_release_state
         (singleton_key, active_evidence_id, phase, activated_at, updated_at)
         VALUES (1, ?, 'active', ?, ?)`
      ).bind(evidenceId, now, now),
    ]);

    const agentColumns = (
      await env.DB.prepare(`SELECT name FROM pragma_table_info('agents')`).all<{
        name: string;
      }>()
    ).results.map((row) => row.name);
    expect(agentColumns).toEqual(["id", "anchor_nonce", "created_at", "updated_at"]);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'table' AND name IN (
           'status_page_config', 'notification_history',
           'agent_metrics_history', 'monitor_daily_stats'
         )`
      ).first<{ count: number }>()
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM pragma_foreign_key_check`
      ).first<{ count: number }>()
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM agent_report_samples WHERE agent_id = ?`
      )
        .bind(fixtureAgentId)
        .first<{ count: number }>()
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM monitor_check_samples WHERE monitor_id = ?`
      )
        .bind(fixtureMonitorId)
        .first<{ count: number }>()
    ).toEqual({ count: 1 });

    const enrollment = await issueAgentEnrollmentToken(
      contractEnv,
      fixtureAdminId
    );
    const registerContext = createExecutionContext();
    const registerResponse = await worker.fetch(
      new Request("https://runtime.test/api/v2/agents/register", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${enrollment.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "post-contract-enrolled-agent",
          hostname: "post-contract-host",
          ip_addresses: ["192.0.2.44"],
          os: "linux",
          version: "v0.2.0",
        }),
      }),
      contractEnv,
      registerContext
    );
    await waitOnExecutionContext(registerContext);
    expect(registerResponse.status).toBe(201);
    const registered = await registerResponse.json<{
      data: { agent_id: number; created: boolean };
    }>();
    expect(registered.data).toMatchObject({ created: true });
    await expect(
      authenticateAgentToken(contractEnv, enrollment.token)
    ).resolves.toMatchObject({ id: registered.data.agent_id });

    const scheduledContext = createExecutionContext();
    const scheduledAt = new Date(nowMs + 60_000);
    await expect(
      worker.scheduled(
        createScheduledController({
          scheduledTime: scheduledAt,
          cron: "* * * * *",
        }),
        contractEnv,
        scheduledContext
      )
    ).resolves.toBeUndefined();
    await waitOnExecutionContext(scheduledContext);

    const monitor = await createMonitorUseCases(contractEnv).create({
      name: "post-contract-monitor",
      url: "https://post-contract.example.test",
      method: "GET",
      interval_seconds: 300,
      timeout_ms: 30000,
      expected_status: 200,
      headers: {},
      body: null,
      active: true,
    });
    expect(monitor.name).toBe("post-contract-monitor");
    expect(
      await env.DB.prepare(`SELECT * FROM monitors WHERE id = ?`)
        .bind(monitor.id)
        .first<Record<string, unknown>>()
    ).toMatchObject({
      id: monitor.id,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });

    const token = `post-contract-agent-token-${crypto.randomUUID()}`;
    await expect(
      importLegacyAgents(contractEnv, [
        { name: "post-contract-agent", token },
      ])
    ).resolves.toMatchObject({ created: 1, skipped: 0 });
    const agent = await env.DB.prepare(
      `SELECT id FROM agent_nodes WHERE name = 'post-contract-agent'`
    ).first<{ id: number }>();
    expect(agent).not.toBeNull();
    expect(
      await env.DB.prepare(`SELECT anchor_nonce FROM agents WHERE id = ?`)
        .bind(agent?.id)
        .first<{ anchor_nonce: string }>()
    ).toMatchObject({ anchor_nonce: expect.stringMatching(/^contract-anchor:/) });
    await expect(authenticateAgentToken(contractEnv, token)).resolves.toMatchObject({
      id: agent?.id,
    });

    const notifications = new D1NotificationRepository(contractEnv);
    const template = await notifications.createTemplate({
      name: "post-contract-template",
      type: "monitor",
      subject: "Canonical subject",
      content: "Canonical content",
      is_default: false,
    });
    expect(template.success).toBe(true);
    await expect(notifications.getTemplate(template.id ?? 0)).resolves.toMatchObject({
      subject: "Canonical subject",
      content: "Canonical content",
    });

    const status = new D1StatusRepository(contractEnv);
    await status.saveConfig({
      title: "Post Contract Status",
      description: "canonical only",
      logoUrl: "",
      customCss: "",
      theme: "mono",
      monitors: [monitor.id],
      agents: [agent?.id ?? 0],
    });
    const statusEvent = await env.DB.prepare(
      `SELECT event_id FROM domain_outbox
       WHERE event_type = 'status.rebuild.requested'
       ORDER BY created_at DESC, event_id DESC LIMIT 1`
    ).first<{ event_id: string }>();
    expect(statusEvent).not.toBeNull();
    const queueBatch = createMessageBatch<XugouQueueMessage>("xugou-jobs", [
      {
        id: `post-contract-outbox-message:${crypto.randomUUID()}`,
        timestamp: new Date(),
        attempts: 1,
        body: {
          version: 1,
          kind: "outbox",
          event_id: statusEvent?.event_id ?? "missing",
        },
      },
    ]);
    const queueContext = createExecutionContext();
    await worker.queue(queueBatch, contractEnv, queueContext);
    const queueResult = await getQueueResult(queueBatch, queueContext);
    expect(queueResult.retryMessages).toEqual([]);
    expect(queueResult.explicitAcks).toHaveLength(1);
    expect(
      await env.DB.prepare(`SELECT status FROM domain_outbox WHERE event_id = ?`)
        .bind(statusEvent?.event_id)
        .first<{ status: string }>()
    ).toEqual({ status: "processed" });
    await expect(queryMonitorHistory(contractEnv, fixtureMonitorId)).resolves.toHaveLength(1);
    await expect(queryMonitorDailyStats(contractEnv, fixtureMonitorId)).resolves.toEqual([]);

    const readiness = await new D1ReleaseReadinessQuery(contractEnv).get();
    expect(readiness).toMatchObject({
      data_compatibility_mode: "contract",
      contract_worker_ready: true,
      contract_evidence: { digest_valid: true },
      credential_contract_ready: true,
    });
    expect(readiness.checks.find((item) => item.key === "contract_evidence_active"))
      .toMatchObject({ ready: true });
  });
});
