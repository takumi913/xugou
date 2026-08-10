import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AgentReportProcessor } from "../src/modules/agents/queue/AgentReportProcessor";
import { MonitorCheckProcessor } from "../src/modules/monitors/queue/MonitorCheckProcessor";
import { NotificationOutboxConsumer } from "../src/modules/notifications/queue/NotificationOutboxConsumer";
import { captureDeadLetters } from "../src/platform/queues/DlqHandler";
import { dispatchQueueBatch } from "../src/platform/queues/QueueDispatcher";
import type { Bindings } from "../src/models/db";

class PreparedStatementFixture {
  private parameters: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string
  ) {}

  bind(...parameters: SQLInputValue[]) {
    const statement = new PreparedStatementFixture(this.database, this.sql);
    statement.parameters = parameters;
    return statement;
  }

  first<T>() {
    return (this.database.prepare(this.sql).get(...this.parameters) ?? null) as T | null;
  }

  all<T>() {
    return { results: this.database.prepare(this.sql).all(...this.parameters) as T[] };
  }

  run() {
    return this.database.prepare(this.sql).run(...this.parameters);
  }
}

class D1Fixture {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string) {
    return new PreparedStatementFixture(this.database, sql);
  }

  batch(statements: PreparedStatementFixture[]) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
  CREATE TABLE agents (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL,
    status TEXT, hostname TEXT, ip_addresses TEXT, os TEXT, version TEXT,
    boot_time INTEGER, keepalive TEXT, last_seen_at TEXT, next_offline_at TEXT,
    last_state_changed_at TEXT, traffic_reset_day INTEGER DEFAULT 1,
    deleted_at TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE agent_nodes (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, collect_interval_ms INTEGER NOT NULL,
    report_interval_ms INTEGER NOT NULL, group_name TEXT, tags_json TEXT NOT NULL,
    price REAL, currency TEXT, billing_cycle TEXT, expire_date TEXT,
    auto_renewal INTEGER NOT NULL, is_hidden INTEGER NOT NULL,
    traffic_limit_gb REAL, traffic_reset_day INTEGER NOT NULL,
    traffic_calc_type TEXT NOT NULL, auto_update INTEGER NOT NULL,
    sort_order INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL, deleted_at_ms INTEGER
  );
  CREATE TABLE agent_runtime (
    agent_id INTEGER PRIMARY KEY, status TEXT NOT NULL, hostname TEXT,
    ip_addresses_json TEXT NOT NULL, os TEXT, agent_version TEXT,
    keepalive_seconds INTEGER, boot_time INTEGER, last_seen_at_ms INTEGER,
    last_state_changed_at_ms INTEGER, next_offline_at_ms INTEGER, region TEXT,
    geo_latitude REAL, geo_longitude REAL, geo_city TEXT, geo_region_name TEXT,
    version INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
  CREATE TABLE legacy_id_map (
    source_table TEXT NOT NULL, source_id TEXT NOT NULL, target_table TEXT NOT NULL,
    target_id TEXT NOT NULL, payload_checksum TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY(source_table, source_id)
  );
  CREATE TABLE migration_anomalies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, migration_key TEXT NOT NULL,
    source_table TEXT NOT NULL, source_pk TEXT NOT NULL, error_code TEXT NOT NULL,
    raw_value_json TEXT NOT NULL, status TEXT NOT NULL
  );
  CREATE TABLE agent_reports (
    report_id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, payload_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL, sample_count INTEGER NOT NULL, status TEXT NOT NULL,
    received_at TEXT NOT NULL, processed_at TEXT, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE agent_report_samples (
    report_id TEXT NOT NULL, sample_index INTEGER NOT NULL, agent_id INTEGER NOT NULL,
    collected_at TEXT NOT NULL, metrics_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(report_id, sample_index)
  );
  CREATE TABLE agent_metric_rollups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL,
    bucket_start TEXT NOT NULL, bucket_size_seconds INTEGER NOT NULL,
    sample_count INTEGER NOT NULL, cpu_avg REAL, cpu_min REAL, cpu_max REAL,
    cpu_p95 REAL, memory_avg REAL, memory_min REAL, memory_max REAL,
    memory_p95 REAL, disk_max REAL, load_avg REAL, network_delta_json TEXT,
    threshold_events_json TEXT, created_at TEXT NOT NULL,
    UNIQUE(agent_id, bucket_start, bucket_size_seconds)
  );
  CREATE TABLE async_jobs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, dedup_key TEXT NOT NULL,
    aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
    available_at TEXT NOT NULL, lease_token TEXT, lease_expires_at TEXT, last_error TEXT,
    completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE agent_latest_metrics (
    agent_id INTEGER PRIMARY KEY, metrics_json TEXT NOT NULL, collected_at TEXT,
    reported_at TEXT NOT NULL, cpu_usage REAL, memory_usage_rate REAL,
    disk_usage_rate REAL, swap_total INTEGER, swap_used INTEGER,
    process_count INTEGER, tcp_connections INTEGER, udp_connections INTEGER,
    ping_json TEXT, ipv4_reachable INTEGER, ipv6_reachable INTEGER,
    network_rx_speed REAL, network_tx_speed REAL,
    month_rx INTEGER, month_tx INTEGER, last_total_rx INTEGER, last_total_tx INTEGER,
    month_reset_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE agent_current_metrics (
    agent_id INTEGER PRIMARY KEY, metrics_json TEXT NOT NULL,
    collected_at_ms INTEGER, reported_at_ms INTEGER NOT NULL, cpu_usage REAL,
    memory_usage_rate REAL, disk_usage_rate REAL, swap_total INTEGER,
    swap_used INTEGER, process_count INTEGER, tcp_connections INTEGER,
    udp_connections INTEGER, ping_json TEXT, ipv4_reachable INTEGER,
    ipv6_reachable INTEGER, network_rx_speed REAL, network_tx_speed REAL,
    month_rx INTEGER NOT NULL, month_tx INTEGER NOT NULL, last_total_rx INTEGER,
    last_total_tx INTEGER, traffic_period_start TEXT, version INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
  );
  CREATE TABLE domain_outbox (
    event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
    attempts INTEGER NOT NULL, available_at TEXT NOT NULL, published_at TEXT,
    processed_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE processed_events (
    consumer TEXT NOT NULL, event_id TEXT NOT NULL, processed_at TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(consumer, event_id)
  );
  CREATE TABLE monitors (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, method TEXT NOT NULL,
    headers TEXT NOT NULL, body TEXT, timeout INTEGER NOT NULL, timeout_ms INTEGER NOT NULL,
    expected_status INTEGER NOT NULL, active INTEGER NOT NULL, status TEXT,
    response_time INTEGER, last_checked TEXT, next_check_at TEXT,
    deleted_at TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE monitor_definitions (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
    method TEXT NOT NULL, headers_json TEXT NOT NULL, body TEXT,
    interval_ms INTEGER NOT NULL, timeout_ms INTEGER NOT NULL,
    expected_status INTEGER NOT NULL, active INTEGER NOT NULL,
    sort_order INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL, deleted_at_ms INTEGER
  );
  CREATE TABLE monitor_runtime (
    monitor_id INTEGER PRIMARY KEY, status TEXT NOT NULL,
    response_time_ms INTEGER NOT NULL, last_checked_at_ms INTEGER,
    next_due_at_ms INTEGER, version INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
  );
  CREATE TABLE monitor_check_samples (
    job_id TEXT PRIMARY KEY, monitor_id INTEGER NOT NULL, scheduled_for_ms INTEGER NOT NULL,
    checked_at TEXT NOT NULL, status TEXT NOT NULL, response_time_ms INTEGER NOT NULL,
    status_code INTEGER, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE monitor_check_rollups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER NOT NULL,
    bucket_start TEXT NOT NULL, bucket_size_seconds INTEGER NOT NULL,
    total_checks INTEGER NOT NULL, up_checks INTEGER NOT NULL, down_checks INTEGER NOT NULL,
    last_status TEXT, response_time_avg INTEGER, response_time_min INTEGER NOT NULL DEFAULT 0,
    response_time_p95 INTEGER,
    response_time_max INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(monitor_id, bucket_start, bucket_size_seconds)
  );
  CREATE TABLE monitor_status_history_24h (
    id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER NOT NULL, status TEXT NOT NULL,
    timestamp TEXT, response_time INTEGER, status_code INTEGER, error TEXT
  );
  CREATE TABLE monitor_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER NOT NULL,
    from_status TEXT, to_status TEXT NOT NULL, started_at TEXT NOT NULL,
    ended_at TEXT, reason TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE public_status_snapshots (
    id INTEGER PRIMARY KEY, dirty_at TEXT, refresh_after TEXT, refreshing INTEGER NOT NULL
  );
  CREATE TABLE notification_channels (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
    config TEXT NOT NULL, enabled INTEGER NOT NULL, deleted_at TEXT
  );
  CREATE TABLE notification_templates (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
    subject TEXT NOT NULL, content TEXT NOT NULL, is_default INTEGER NOT NULL,
    deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE notification_template_definitions (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
    current_version INTEGER NOT NULL, is_default INTEGER NOT NULL,
    deleted_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
  );
  CREATE TABLE notification_template_versions (
    template_id INTEGER NOT NULL, version INTEGER NOT NULL,
    subject TEXT NOT NULL, content TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(template_id, version)
  );
  CREATE TABLE notification_settings (
    id INTEGER PRIMARY KEY, target_type TEXT NOT NULL, target_id INTEGER,
    enabled INTEGER NOT NULL, on_down INTEGER NOT NULL, on_recovery INTEGER NOT NULL,
    on_offline INTEGER NOT NULL, on_cpu_threshold INTEGER NOT NULL,
    cpu_threshold INTEGER NOT NULL, on_memory_threshold INTEGER NOT NULL,
    memory_threshold INTEGER NOT NULL, on_disk_threshold INTEGER NOT NULL,
    disk_threshold INTEGER NOT NULL, cooldown_minutes INTEGER NOT NULL, channels TEXT,
    created_at TEXT NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
    updated_at TEXT NOT NULL DEFAULT 'CURRENT_TIMESTAMP'
  );
  CREATE TABLE notification_rules (
    id INTEGER PRIMARY KEY, target_type TEXT NOT NULL, target_id INTEGER,
    enabled INTEGER NOT NULL, on_down INTEGER NOT NULL, on_recovery INTEGER NOT NULL,
    on_offline INTEGER NOT NULL, on_cpu_threshold INTEGER NOT NULL,
    cpu_threshold INTEGER NOT NULL, on_memory_threshold INTEGER NOT NULL,
    memory_threshold INTEGER NOT NULL, on_disk_threshold INTEGER NOT NULL,
    disk_threshold INTEGER NOT NULL, cooldown_minutes INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
  );
  CREATE TABLE notification_rule_endpoints (
    rule_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, sort_order INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY(rule_id, channel_id)
  );
  CREATE TABLE notification_events (
    event_id TEXT PRIMARY KEY, source_event_id TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
    target_id INTEGER, event_key TEXT NOT NULL, variables_json TEXT NOT NULL,
    status TEXT NOT NULL, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE notification_messages (
    message_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, channel_id INTEGER NOT NULL,
    template_id INTEGER NOT NULL, subject TEXT NOT NULL, content TEXT NOT NULL,
    cooldown_minutes INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL, available_at TEXT NOT NULL, lease_token TEXT,
    lease_expires_at TEXT, provider_status_code INTEGER, last_error TEXT, sent_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(event_id, channel_id)
  );
  CREATE TABLE notification_attempts (
    attempt_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
    started_at TEXT NOT NULL, completed_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
    success INTEGER NOT NULL, provider_status_code INTEGER, error_category TEXT,
    error TEXT, retryable INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(message_id, attempt_number)
  );
  CREATE TABLE notification_cooldowns (
    cooldown_key TEXT PRIMARY KEY, type TEXT NOT NULL, target_id INTEGER,
    channel_id INTEGER NOT NULL, event_key TEXT NOT NULL, last_sent_at TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE notification_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, target_id INTEGER,
    channel_id INTEGER NOT NULL, template_id INTEGER NOT NULL, status TEXT NOT NULL,
    content TEXT NOT NULL, error TEXT, sent_at TEXT
  );
  CREATE TABLE queue_failures (
    failure_id TEXT PRIMARY KEY, queue_name TEXT NOT NULL, message_id TEXT NOT NULL,
    message_json TEXT NOT NULL, source_kind TEXT, source_id TEXT,
    delivery_attempts INTEGER NOT NULL, last_error TEXT, status TEXT NOT NULL,
    replay_count INTEGER NOT NULL, replayed_at TEXT, terminated_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(queue_name, message_id)
  );
`);

const reportId = "018f47f2-60e5-7b47-a8ca-58c57e1be5d4";
const report = {
  protocol_version: 4,
  agent_version: "v0.2.0",
  report_id: reportId,
  hostname: "edge-1",
  ip_addresses: ["192.0.2.1"],
  os: "linux",
  version: "v4.0.0",
  keepalive_seconds: 300,
  samples: [
    {
      collected_at: "2026-08-01T00:00:00.000Z",
      cpu: { usage: 21.5, cores: 4 },
      memory: { usage_rate: 47 },
      disks: [{ device: "/dev/vda", usage_rate: 55 }],
    },
    {
      collected_at: "2026-08-01T00:01:00.000Z",
      cpu: { usage: 22.5, cores: 4 },
      memory: { usage_rate: 48 },
    },
  ],
};
const now = new Date().toISOString();
sqlite
  .prepare("INSERT INTO agents(id, name, token, status, updated_at) VALUES(1, 'edge-1', 'legacy', 'inactive', ?)")
  .run(now);
sqlite.prepare(`INSERT INTO agent_nodes
  (id, name, collect_interval_ms, report_interval_ms, tags_json, auto_renewal,
   is_hidden, traffic_reset_day, traffic_calc_type, auto_update, sort_order,
   created_at_ms, updated_at_ms)
  VALUES (1, 'edge-1', 60000, 300000, '[]', 0, 0, 1, 'sum', 0, 0, ?, ?)`)
  .run(Date.parse(now), Date.parse(now));
sqlite.prepare(`INSERT INTO agent_runtime
  (agent_id, status, ip_addresses_json, version, created_at_ms, updated_at_ms)
  VALUES (1, 'inactive', '[]', 0, ?, ?)`)
  .run(Date.parse(now), Date.parse(now));
sqlite.prepare(`INSERT INTO legacy_id_map
  (source_table, source_id, target_table, target_id, payload_checksum,
   created_at, updated_at)
  VALUES ('agents', '1', 'agent_nodes', '1', 'fixture', ?, ?)`)
  .run(now, now);
sqlite
  .prepare(`INSERT INTO agent_reports
    (report_id, agent_id, payload_digest, payload_json, sample_count, status,
     received_at, created_at, updated_at)
    VALUES (?, 1, 'digest', ?, 2, 'pending', ?, ?, ?)`)
  .run(reportId, JSON.stringify(report), now, now, now);
sqlite
  .prepare(`INSERT INTO async_jobs
    (id, kind, dedup_key, aggregate_type, aggregate_id, payload_json, status,
     attempts, max_attempts, available_at, created_at, updated_at)
    VALUES (?, 'agent.report.process', ?, 'agent_report', ?, '{}', 'pending', 0, 8, ?, ?, ?)`)
  .run(`agent-report:${reportId}`, `agent-report:${reportId}`, reportId, now, now, now);

const queued: unknown[] = [];
const env = {
  DB: new D1Fixture(sqlite),
  XUGOU_JOBS: {
    async send(body: unknown) {
      queued.push(body);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  },
};
const processor = new AgentReportProcessor(env as never);
assert.deepEqual(await processor.process(`agent-report:${reportId}`), {
  outcome: "completed",
});
assert.equal(
  sqlite.prepare("SELECT count(*) AS count FROM agent_report_samples").get()?.count,
  2
);
assert.deepEqual(
  {
    ...sqlite
      .prepare(
        `SELECT sample_count, cpu_avg, cpu_p95, cpu_max,
                memory_avg, memory_p95, memory_max
         FROM agent_metric_rollups WHERE agent_id = 1`
      )
      .get(),
  },
  {
    sample_count: 2,
    cpu_avg: 22,
    cpu_p95: 22.5,
    cpu_max: 22.5,
    memory_avg: 47.5,
    memory_p95: 48,
    memory_max: 48,
  }
);
assert.equal(
  sqlite.prepare("SELECT status FROM agent_reports WHERE report_id = ?").get(reportId)?.status,
  "processed"
);
assert.equal(
  sqlite.prepare("SELECT cpu_usage FROM agent_latest_metrics WHERE agent_id = 1").get()?.cpu_usage,
  22.5
);
assert.equal(
  sqlite.prepare("SELECT cpu_usage FROM agent_current_metrics WHERE agent_id = 1").get()?.cpu_usage,
  22.5
);
assert.equal(
  sqlite.prepare("SELECT status FROM async_jobs WHERE id = ?").get(`agent-report:${reportId}`)?.status,
  "completed"
);
assert.equal(
  sqlite.prepare("SELECT status FROM agent_runtime WHERE agent_id = 1").get()?.status,
  "active"
);
assert.deepEqual(queued, [
  { version: 1, kind: "outbox", event_id: `agent.report.processed:${reportId}` },
  { version: 1, kind: "outbox", event_id: `agent.metrics.observed:${reportId}` },
  { version: 1, kind: "outbox", event_id: `agent.status.changed:${reportId}` },
]);

assert.deepEqual(await processor.process(`agent-report:${reportId}`), {
  outcome: "ignored",
});
const monitorJobId = "monitor-check:1:1785542400000";
sqlite
  .prepare(`INSERT INTO monitors
    (id, name, url, method, headers, timeout, timeout_ms, expected_status,
     active, status, next_check_at, deleted_at, updated_at)
    VALUES (1, 'api', 'https://example.test/health', 'GET', '{}', 30, 1500,
            200, 1, 'down', ?, NULL, ?)`)
  .run(now, now);
sqlite.prepare(`INSERT INTO monitor_definitions
  (id, name, url, method, headers_json, body, interval_ms, timeout_ms,
   expected_status, active, sort_order, created_at_ms, updated_at_ms, deleted_at_ms)
  VALUES (1, 'api', 'https://example.test/health', 'GET', '{}', NULL,
          300000, 1500, 200, 1, 0, ?, ?, NULL)`).run(Date.parse(now), Date.parse(now));
sqlite.prepare(`INSERT INTO monitor_runtime
  (monitor_id, status, response_time_ms, last_checked_at_ms, next_due_at_ms,
   version, created_at_ms, updated_at_ms)
  VALUES (1, 'down', 0, NULL, ?, 0, ?, ?)`).run(
    Date.parse(now), Date.parse(now), Date.parse(now)
  );
sqlite.prepare("INSERT INTO public_status_snapshots(id, refreshing) VALUES(1, 0)").run();
sqlite.prepare("INSERT INTO notification_channels VALUES(1, 'fixture', 'webhook', '{}', 1, NULL)").run();
sqlite.prepare("INSERT INTO notification_templates VALUES(1, 'monitor', 'monitor', '${name}: ${status}', '${details}', 1, NULL, ?, ?)").run(now, now);
sqlite.prepare("INSERT INTO notification_templates VALUES(2, 'agent', 'agent', '${name}: ${status}', '${details}', 1, NULL, ?, ?)").run(now, now);
sqlite.prepare(`INSERT INTO notification_settings
  (id, target_type, target_id, enabled, on_down, on_recovery, on_offline,
   on_cpu_threshold, cpu_threshold, on_memory_threshold, memory_threshold,
   on_disk_threshold, disk_threshold, cooldown_minutes, channels)
  VALUES(1, 'monitor', 1, 1, 1, 1, 1, 0, 90, 0, 85, 0, 90, 30, '[1]')`).run();
sqlite.prepare(`INSERT INTO notification_settings
  (id, target_type, target_id, enabled, on_down, on_recovery, on_offline,
   on_cpu_threshold, cpu_threshold, on_memory_threshold, memory_threshold,
   on_disk_threshold, disk_threshold, cooldown_minutes, channels)
  VALUES(2, 'agent', 1, 1, 1, 1, 1, 1, 20, 1, 40, 1, 50, 30, '[1]')`).run();
sqlite
  .prepare(`INSERT INTO async_jobs
    (id, kind, dedup_key, aggregate_type, aggregate_id, payload_json, status,
     attempts, max_attempts, available_at, created_at, updated_at)
    VALUES (?, 'monitor.check', ?, 'monitor', '1', ?, 'pending', 0, 5, ?, ?, ?)`)
  .run(
    monitorJobId,
    monitorJobId,
    JSON.stringify({ monitor_id: 1, scheduled_for_ms: 1785542400000 }),
    now,
    now,
    now
  );
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(null, { status: 200 });
try {
  const monitorProcessor = new MonitorCheckProcessor(env as never);
  assert.deepEqual(await monitorProcessor.process(monitorJobId), {
    outcome: "completed",
  });
  assert.equal(sqlite.prepare("SELECT status FROM monitors WHERE id = 1").get()?.status, "up");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM monitor_check_samples").get()?.count, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM monitor_status_history_24h").get()?.count, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM monitor_check_rollups").get()?.count, 1);
  assert.equal(sqlite.prepare("SELECT status FROM async_jobs WHERE id = ?").get(monitorJobId)?.status, "completed");
  assert.deepEqual(await monitorProcessor.process(monitorJobId), { outcome: "ignored" });

  const outbox = sqlite
    .prepare("SELECT event_id, event_type, aggregate_type, aggregate_id, payload_json, status FROM domain_outbox WHERE event_id = ?")
    .get(`monitor.checked:${monitorJobId}`) as {
      event_id: string;
      event_type: string;
      aggregate_type: string;
      aggregate_id: string;
      payload_json: string;
      status: string;
    };
  let sends = 0;
  const notification = new NotificationOutboxConsumer(
    env as never,
    async () => {
      sends += 1;
      return { success: true };
    }
  );
  const agentOutboxes = sqlite
    .prepare(`SELECT event_id, event_type, aggregate_type, aggregate_id,
                    payload_json, status
              FROM domain_outbox
              WHERE event_type IN ('agent.status.changed', 'agent.metrics.observed')
              ORDER BY event_type`)
    .all() as Array<{
      event_id: string;
      event_type: string;
      aggregate_type: string;
      aggregate_id: string;
      payload_json: string;
      status: string;
    }>;
  assert.equal(agentOutboxes.length, 2);
  for (const agentOutbox of agentOutboxes) {
    await notification.process(agentOutbox);
    await notification.process(agentOutbox);
  }
  assert.equal(sends, 2);

  await notification.process(outbox);
  await notification.process(outbox);
  assert.equal(sends, 3);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM notification_messages").get()?.count, 3);
  assert.equal(sqlite.prepare("SELECT status FROM notification_messages").get()?.status, "sent");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM notification_attempts").get()?.count, 3);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM notification_cooldowns").get()?.count, 3);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM notification_history").get()?.count, 3);

  let acknowledged = false;
  await captureDeadLetters(
    {
      queue: "xugou-jobs-dlq",
      messages: [
        {
          id: "dlq-message-1",
          body: { version: 1, kind: "job", job_id: monitorJobId },
          attempts: 6,
          ack() { acknowledged = true; },
          retry() {},
        },
      ],
    },
    env as never
  );
  assert.equal(acknowledged, true);
  assert.equal(sqlite.prepare("SELECT status FROM queue_failures").get()?.status, "open");

  let retryDelaySeconds: number | undefined;
  await dispatchQueueBatch(
    {
      queue: "xugou-jobs",
      messages: [
        {
          id: "d1-maintenance-outbox-message",
          body: {
            version: 1,
            kind: "outbox",
            event_id: "agent.metrics.observed:d1-maintenance",
          },
          attempts: 1,
          ack() {},
          retry(options) {
            retryDelaySeconds = options?.delaySeconds;
          },
        },
      ],
    },
    {
      DB: {
        prepare() {
          throw new Error("D1 maintenance window");
        },
      },
    } as unknown as Bindings,
    "00000000-0000-4000-8000-000000000000"
  );
  assert.equal(
    retryDelaySeconds,
    2,
    "failure-ledger outages must preserve the per-message retry backoff"
  );
} finally {
  globalThis.fetch = originalFetch;
}

sqlite.close();
