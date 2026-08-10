import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  runMigrationPreflight,
  runMigrationPreflightSqlExport,
} from "../tooling/migrations/preflight";

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(backendRoot, "drizzle");
const tempDir = mkdtempSync(join(tmpdir(), "xugou-migrations-"));
const databasePath = join(tempDir, "fixture.sqlite");

function sqlite(sql: string): string {
  return execFileSync("sqlite3", [databasePath], {
    encoding: "utf8",
    input: sql,
  }).trim();
}

const legacySensitiveFixture = `
  INSERT INTO notification_channels(
    id, name, type, config, enabled, created_at, updated_at
  ) VALUES (
    1,
    '测试Bot(https://t.me/xugou_bot)',
    'telegram',
    '{"botToken":"8538953065:FIXTURE_ONLY","chatId":"1"}',
    1,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );
  INSERT OR REPLACE INTO public_status_snapshots(
    id, snapshot_json, etag, generated_at, expires_at, refreshing
  ) VALUES (
    1,
    '{"monitors":[{"id":1,"url":"https://private.example"}],"agents":[]}',
    'legacy',
    '2026-01-01T00:00:00.000Z',
    '2099-01-01T00:00:00.000Z',
    0
  );
`;

const legacyMultiTenantFixture = `
  INSERT INTO users(id, username, password, email, role, created_at, updated_at)
  VALUES
    (1, 'admin', 'fixture-admin-hash', NULL, 'admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    (2, 'legacy-user', 'fixture-user-hash', NULL, 'user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  INSERT INTO monitors(
    id, name, url, method, interval, timeout, expected_status, headers,
    created_by, active, created_at, updated_at
  ) VALUES
    (1, 'admin-monitor', 'https://admin.example', 'GET', 60, 5000, 200, '{}', 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    (2, 'legacy-monitor', 'https://legacy.example', 'GET', 60, 5000, 200, '{}', 2, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  INSERT INTO agents(id, name, token, created_by, status, created_at, updated_at)
  VALUES
    (1, 'admin-agent', 'legacy-token-admin', 1, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    (2, 'legacy-agent', 'legacy-token-user', 2, 'inactive', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  INSERT INTO notification_settings(id, user_id, target_type, enabled)
  VALUES (1, 1, 'global-monitor', 1), (2, 2, 'global-monitor', 1);
  INSERT INTO status_page_config(id, user_id, title)
  VALUES (10, 2, 'legacy-status'), (20, 1, 'admin-status');
  INSERT INTO status_page_monitors(config_id, monitor_id)
  VALUES (10, 2), (20, 1);
  INSERT INTO status_page_agents(config_id, agent_id)
  VALUES (10, 2), (20, 1);
  INSERT INTO public_status_snapshots(
    user_id, snapshot_json, etag, generated_at, expires_at, refreshing
  ) VALUES
    (1, '{"title":"admin"}', 'admin', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 0),
    (2, '{"title":"legacy"}', 'legacy', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 0);
`;

// Production-shaped rows exercise both CASCADE and NO ACTION children of the
// parent tables rebuilt by 0017. An empty fixture hides SQLite's deferred
// foreign-key counter and the data loss caused by ON DELETE CASCADE.
const legacyReferencedRowsFixture = `
  INSERT INTO agent_latest_metrics(
    agent_id, metrics_json, reported_at, updated_at
  ) VALUES (
    1, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
  );
  INSERT INTO agent_metric_rollups(
    id, agent_id, bucket_start, bucket_size_seconds, created_at
  ) VALUES (
    9101, 1, '2026-01-01T00:00:00.000Z', 300,
    '2026-01-01T00:00:00.000Z'
  );
  INSERT INTO agent_metrics_24h(id, agent_id)
  VALUES (9102, 1);
  INSERT INTO monitor_check_rollups(
    id, monitor_id, bucket_start, bucket_size_seconds, created_at, updated_at
  ) VALUES (
    9103, 1, '2026-01-01T00:00:00.000Z', 300,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
  );
  INSERT INTO monitor_daily_stats(
    id, monitor_id, date, created_at
  ) VALUES (
    9104, 1, '2026-01-01', '2026-01-01T00:00:00.000Z'
  );
  INSERT INTO monitor_incidents(
    id, monitor_id, to_status, started_at, created_at, updated_at
  ) VALUES (
    9105, 1, 'down', '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
  );
  INSERT INTO monitor_status_history_24h(id, monitor_id, status)
  VALUES (9106, 1, 'up');
  INSERT INTO notification_channels(
    id, name, type, config, enabled, created_by, created_at, updated_at
  ) VALUES (
    91, 'fixture-channel', 'webhook', '{}', 1, 1,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
  );
  INSERT INTO notification_templates(
    id, name, type, subject, content, is_default, created_by,
    created_at, updated_at
  ) VALUES (
    91, 'fixture-template', 'monitor', 'subject', 'content', 0, 1,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
  );
  INSERT INTO notification_history(
    id, type, channel_id, template_id, status, content
  ) VALUES (
    9107, 'monitor', 91, 91, 'sent', 'fixture'
  );
`;

try {
  const migrations = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();

  sqlite(
    "CREATE TABLE migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, timestamp TEXT);"
  );

  for (const migration of migrations) {
    if (migration.startsWith("0017_")) {
      sqlite(`
        PRAGMA foreign_keys = ON;
        BEGIN IMMEDIATE;
        ${legacyMultiTenantFixture}
        ${legacyReferencedRowsFixture}
        COMMIT;
      `);
    }
    if (migration.startsWith("0018_")) {
      sqlite(legacySensitiveFixture);
    }
    sqlite(`
      PRAGMA foreign_keys = ON;
      BEGIN IMMEDIATE;
      ${readFileSync(join(migrationsDir, migration), "utf8")}
      COMMIT;
    `);
    if (migration.startsWith("0017_")) {
      assert.equal(
        sqlite("PRAGMA foreign_key_check;"),
        "",
        "0017 must leave every foreign-key relationship valid"
      );
      for (const [table, predicate] of [
        ["agent_latest_metrics", "agent_id = 1"],
        ["agent_metric_rollups", "id = 9101"],
        ["agent_metrics_24h", "id = 9102"],
        ["monitor_check_rollups", "id = 9103"],
        ["monitor_daily_stats", "id = 9104"],
        ["monitor_incidents", "id = 9105"],
        ["monitor_status_history_24h", "id = 9106"],
        ["notification_history", "id = 9107"],
        ["status_page_agents", "config_id = 20 AND agent_id = 1"],
        ["status_page_monitors", "config_id = 20 AND monitor_id = 1"],
      ] as const) {
        assert.equal(
          sqlite(`SELECT count(*) FROM ${table} WHERE ${predicate};`),
          "1",
          `0017 must preserve production-shaped ${table} rows`
        );
      }
      assert.equal(
        sqlite(
          "SELECT count(*) FROM sqlite_master WHERE name LIKE '__preserve_0017_%';"
        ),
        "0",
        "0017 must remove every transactional preservation table"
      );
      // These marker rows have served their 0017 regression purpose. Keep the
      // downstream Contract-conservation fixture focused on its own explicit
      // backfill mappings instead of treating test-only history as production
      // work still awaiting migration.
      sqlite(`
        PRAGMA foreign_keys = ON;
        BEGIN IMMEDIATE;
        DELETE FROM notification_history WHERE id = 9107;
        DELETE FROM notification_channels WHERE id = 91;
        DELETE FROM notification_templates WHERE id = 91;
        DELETE FROM agent_latest_metrics WHERE agent_id = 1;
        DELETE FROM agent_metric_rollups WHERE id = 9101;
        DELETE FROM agent_metrics_24h WHERE id = 9102;
        DELETE FROM monitor_check_rollups WHERE id = 9103;
        DELETE FROM monitor_daily_stats WHERE id = 9104;
        DELETE FROM monitor_incidents WHERE id = 9105;
        DELETE FROM monitor_status_history_24h WHERE id = 9106;
        COMMIT;
      `);
    }
    sqlite(
      `INSERT INTO migrations(name, timestamp) VALUES ('${migration}', '2026-01-01T00:00:00.000Z');`
    );
  }

  assert.equal(
    sqlite(
      "SELECT name || '|' || config || '|' || enabled FROM notification_channels WHERE id = 1;"
    ),
    "旧默认 Telegram 渠道（凭据已清除）|{}|0"
  );
  assert.equal(
    sqlite("SELECT count(*) FROM public_status_snapshots;"),
    "0",
    "legacy public snapshots must be invalidated"
  );
  assert.equal(
    sqlite("SELECT count(*) FROM monitors;"),
    "2",
    "single-instance migration must preserve monitors owned by legacy users"
  );
  assert.equal(
    sqlite("SELECT count(*) FROM agents;"),
    "2",
    "single-instance migration must preserve Agents owned by legacy users"
  );
  assert.equal(
    sqlite("SELECT title FROM status_page_config;"),
    "admin-status",
    "single-instance migration must retain the primary admin status page"
  );
  assert.equal(
    sqlite("SELECT count(*) FROM notification_settings;"),
    "2",
    "single-instance defaults must contain one global setting per resource type"
  );
  assert.equal(
    sqlite("SELECT count(*) FROM users;"),
    "1",
    "single-instance data migration must retain only the primary admin"
  );
  assert.equal(
    sqlite(
      "SELECT count(*) FROM pragma_table_info('agents') WHERE name = 'created_by';"
    ),
    "0",
    "single-instance Agent rows must no longer carry ownership columns"
  );
  assert.equal(
    sqlite(
      "SELECT count(*) FROM pragma_table_info('monitors') WHERE name = 'timeout_ms';"
    ),
    "1",
    "Monitor timeout_ms compatibility column must be present"
  );
  assert.equal(
    sqlite("SELECT count(*) FROM monitors WHERE timeout_ms = timeout * 1000;"),
    "2",
    "legacy Monitor timeout seconds must be preserved as milliseconds"
  );
  assert.equal(
    sqlite(
      "SELECT count(*) FROM notification_templates WHERE is_default = 1 AND type IN ('monitor', 'agent');"
    ),
    "2",
    "default notification templates must be created by data migration"
  );
  sqlite(`
    CREATE TABLE IF NOT EXISTS migrations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    INSERT INTO migrations(name) VALUES ('wrangler-ledger-bridge-fixture.sql');
  `);
  assert.equal(
    sqlite(
      "SELECT count(*) FROM migrations WHERE name = 'wrangler-ledger-bridge-fixture.sql';"
    ),
    "1",
    "Wrangler must be able to append to the legacy runtime migration ledger"
  );
  sqlite(
    "DELETE FROM migrations WHERE name = 'wrangler-ledger-bridge-fixture.sql';"
  );
  assert.match(
    sqlite(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'admin_sessions';"
    ),
    /token_digest[\s\S]*user_id[\s\S]*expires_at[\s\S]*revoked_at/,
    "opaque admin session table must be present"
  );
  assert.equal(
    sqlite(
      "SELECT count(*) FROM pragma_index_list('admin_sessions') WHERE name IN ('admin_sessions_user_expires_at_idx', 'admin_sessions_expires_at_idx');"
    ),
    "2",
    "admin session lookup and expiry indexes must be present"
  );
  assert.equal(
    sqlite(
      "SELECT count(*) FROM pragma_table_info('agents') WHERE name = 'deleted_at';"
    ),
    "1",
    "agents must support soft deletion"
  );
  assert.match(
    sqlite(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_credentials';"
    ),
    /token_digest[\s\S]*token_hint[\s\S]*revoked_at/,
    "Agent credential digest table must be present"
  );
  assert.match(
    sqlite(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_enrollment_tokens';"
    ),
    /token_digest[\s\S]*expires_at[\s\S]*used_at[\s\S]*revoked_at/,
    "Agent enrollment state table must be present"
  );
  assert.equal(
    sqlite(
      "SELECT count(*) FROM pragma_index_list('agent_credentials') WHERE name = 'agent_credentials_token_digest_unique_idx';"
    ),
    "1",
    "Agent credential digests must be unique"
  );
  assert.match(
    sqlite(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_endpoints';"
    ),
    /channel_id[\s\S]*public_config_json/,
    "notification endpoint projection must be present"
  );
  assert.match(
    sqlite(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_secrets';"
    ),
    /ciphertext[\s\S]*wrapped_dek[\s\S]*key_version/,
    "notification envelope encryption table must be present"
  );
  assert.match(
    sqlite(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'security_rate_limits';"
    ),
    /key_digest[\s\S]*attempts[\s\S]*blocked_until/,
    "atomic persistent rate limit table must be present"
  );
  assert.match(
    sqlite(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'security_audit_events';"
    ),
    /event_type[\s\S]*actor_type[\s\S]*ip_digest[\s\S]*metadata_json/,
    "structured security audit table must be present"
  );
  assert.equal(
    sqlite(
      "SELECT count(*) FROM pragma_index_list('security_audit_events') WHERE name IN ('security_audit_events_created_at_idx', 'security_audit_events_event_created_at_idx');"
    ),
    "2",
    "security audit lookup indexes must be present"
  );
  assert.equal(
    sqlite(
      "SELECT count(*) FROM pragma_index_list('security_rate_limits') WHERE name = 'security_rate_limits_scope_blocked_idx';"
    ),
    "1",
    "security rate limit cleanup index must be present"
  );
  assert.match(
    sqlite(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_reports';"
    ),
    /report_id[\s\S]*payload_digest[\s\S]*payload_json[\s\S]*status/,
    "Agent report idempotency envelope must be present"
  );
  assert.equal(
    sqlite(
      "SELECT count(*) FROM pragma_index_list('async_jobs') WHERE name = 'async_jobs_dedup_key_unique_idx';"
    ),
    "1",
    "async jobs must enforce a unique business deduplication key"
  );
  assert.match(
    sqlite(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'domain_outbox';"
    ),
    /event_id[\s\S]*event_type[\s\S]*payload_json[\s\S]*status/,
    "persistent domain outbox must be present"
  );
  assert.match(
    sqlite(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'processed_events';"
    ),
    /PRIMARY KEY\(`consumer`, `event_id`\)/,
    "processed event inbox must be idempotent per consumer"
  );
  assert.equal(
    sqlite(
      "SELECT count(*) FROM pragma_index_list('monitor_check_samples') WHERE name = 'sqlite_autoindex_monitor_check_samples_1';"
    ),
    "1",
    "monitor check samples must deduplicate by job_id"
  );
  for (const table of [
    "notification_events",
    "notification_messages",
    "notification_attempts",
    "notification_cooldowns",
    "status_publications",
    "status_publication_state",
    "queue_failures",
  ]) {
    assert.equal(
      sqlite(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '${table}';`),
      "1",
      `${table} migration table must be present`
    );
  }
  assert.equal(
    sqlite(
      "SELECT count(*) FROM pragma_index_list('notification_messages') WHERE name = 'notification_messages_event_channel_unique_idx';"
    ),
    "1",
    "notification messages must deduplicate each event/channel delivery"
  );
  assert.equal(
    sqlite(
      "SELECT count(*) FROM pragma_index_list('status_publications') WHERE name = 'status_publications_source_event_id_unique_idx';"
    ),
    "1",
    "status publication rebuilds must be idempotent by source event"
  );
  const preflight = runMigrationPreflight(databasePath);
  assert.equal(preflight.readyForExpand, true);
  assert.equal(preflight.blockers.length, 0);
  assert.equal(preflight.counts.foreignKeyViolations, 0);
  assert.equal(preflight.schema.tables.includes("security_audit_events"), true);
  sqlite("UPDATE notification_channels SET config = 'not-json' WHERE id = 1;");
  const blockedPreflight = runMigrationPreflight(databasePath);
  assert.equal(blockedPreflight.readyForExpand, false);
  assert.equal(blockedPreflight.counts.invalidNotificationConfigJson, 1);
  sqlite("UPDATE notification_channels SET config = '{}' WHERE id = 1;");
  const sqlExportPath = join(tempDir, "fixture-export.sql");
  writeFileSync(
    sqlExportPath,
    execFileSync("sqlite3", [databasePath, ".dump"], { encoding: "utf8" })
  );
  const exportedPreflight = runMigrationPreflightSqlExport(sqlExportPath);
  assert.equal(exportedPreflight.readyForExpand, true);
  assert.equal(exportedPreflight.database, sqlExportPath);

  sqlite(`
    INSERT INTO agent_credentials(
      agent_id, token_digest, token_hint, created_at, updated_at
    )
    SELECT id, 'fixture-digest-' || id, 'fixture',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    FROM agents;
    INSERT INTO notification_endpoints(
      channel_id, public_config_json, created_at, updated_at
    )
    SELECT id, '{}', '2026-01-01T00:00:00.000Z',
           '2026-01-01T00:00:00.000Z'
    FROM notification_channels;
    INSERT INTO agent_nodes(
      id, name, collect_interval_ms, report_interval_ms, group_name, tags_json,
      price, currency, billing_cycle, expire_date, auto_renewal, is_hidden,
      traffic_limit_gb, traffic_reset_day, traffic_calc_type, auto_update,
      sort_order, created_at_ms, updated_at_ms, deleted_at_ms
    )
    SELECT id, name, COALESCE(collect_interval, 60) * 1000,
           COALESCE(report_interval, 300) * 1000, group_name, '[]', price,
           currency, billing_cycle, expire_date, COALESCE(auto_renewal, 0),
           COALESCE(is_hidden, 0), traffic_limit_gb,
           COALESCE(traffic_reset_day, 1), COALESCE(traffic_calc_type, 'sum'),
           COALESCE(auto_update, 0), COALESCE(sort_order, 0),
           CAST(strftime('%s', created_at) AS INTEGER) * 1000,
           CAST(strftime('%s', updated_at) AS INTEGER) * 1000,
           CASE WHEN deleted_at IS NULL THEN NULL
                ELSE CAST(strftime('%s', deleted_at) AS INTEGER) * 1000 END
    FROM agents;
    INSERT INTO agent_runtime(
      agent_id, status, hostname, ip_addresses_json, os, agent_version,
      keepalive_seconds, boot_time, last_seen_at_ms, last_state_changed_at_ms,
      next_offline_at_ms, region, geo_latitude, geo_longitude, geo_city,
      geo_region_name, version, created_at_ms, updated_at_ms
    )
    SELECT id, COALESCE(status, 'inactive'), hostname,
           COALESCE(ip_addresses, '[]'), os, version, CAST(keepalive AS INTEGER),
           boot_time,
           CASE WHEN last_seen_at IS NULL THEN NULL
                ELSE CAST(strftime('%s', last_seen_at) AS INTEGER) * 1000 END,
           CASE WHEN last_state_changed_at IS NULL THEN NULL
                ELSE CAST(strftime('%s', last_state_changed_at) AS INTEGER) * 1000 END,
           CASE WHEN next_offline_at IS NULL THEN NULL
                ELSE CAST(strftime('%s', next_offline_at) AS INTEGER) * 1000 END,
           region, geo_latitude, geo_longitude, geo_city, geo_region_name, 0,
           COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000,
                    1767225600000),
           COALESCE(CAST(strftime('%s', updated_at) AS INTEGER) * 1000,
                    1767225600000)
    FROM agents;
    INSERT INTO legacy_id_map(
      source_table, source_id, target_table, target_id, payload_checksum,
      created_at, updated_at
    )
    SELECT 'agents', CAST(id AS TEXT), 'agent_nodes', CAST(id AS TEXT),
           'fixture-agent-checksum',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    FROM agents;
    INSERT INTO monitor_definitions(
      id, name, url, method, headers_json, body, interval_ms, timeout_ms,
      expected_status, active, sort_order, created_at_ms, updated_at_ms,
      deleted_at_ms
    )
    SELECT id, name, url, method, headers, body, interval * 1000, timeout_ms,
           expected_status, active, COALESCE(sort_order, 0),
           CAST(strftime('%s', created_at) AS INTEGER) * 1000,
           CAST(strftime('%s', updated_at) AS INTEGER) * 1000,
           NULL
    FROM monitors;
    INSERT INTO monitor_runtime(
      monitor_id, status, response_time_ms, last_checked_at_ms, next_due_at_ms,
      version, created_at_ms, updated_at_ms
    )
    SELECT id, COALESCE(status, 'pending'), COALESCE(response_time, 0),
           CASE WHEN last_checked IS NULL THEN NULL
                ELSE CAST(strftime('%s', last_checked) AS INTEGER) * 1000 END,
           CASE WHEN next_check_at IS NULL THEN NULL
                ELSE CAST(strftime('%s', next_check_at) AS INTEGER) * 1000 END,
           0, CAST(strftime('%s', created_at) AS INTEGER) * 1000,
           CAST(strftime('%s', updated_at) AS INTEGER) * 1000
    FROM monitors;
    INSERT INTO legacy_id_map(
      source_table, source_id, target_table, target_id, payload_checksum,
      created_at, updated_at
    )
    SELECT 'monitors', CAST(id AS TEXT), 'monitor_definitions', CAST(id AS TEXT),
           'fixture-monitor-checksum',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    FROM monitors;
    INSERT INTO status_pages(
      id, singleton_key, title, description, logo_url, custom_css, theme,
      created_at_ms, updated_at_ms
    )
    SELECT id, singleton_key, title, description, logo_url, custom_css,
           COALESCE(theme, 'mono'),
           COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000,
                    1767225600000),
           COALESCE(CAST(strftime('%s', updated_at) AS INTEGER) * 1000,
                    1767225600000)
    FROM status_page_config;
    INSERT INTO status_components(
      page_id, component_type, component_id, sort_order,
      created_at_ms, updated_at_ms
    )
    SELECT relation.config_id, 'monitor', relation.monitor_id,
           ROW_NUMBER() OVER (
             PARTITION BY relation.config_id ORDER BY relation.monitor_id
           ) - 1,
           COALESCE(CAST(strftime('%s', config.created_at) AS INTEGER) * 1000,
                    1767225600000),
           COALESCE(CAST(strftime('%s', config.updated_at) AS INTEGER) * 1000,
                    1767225600000)
    FROM status_page_monitors relation
    JOIN status_page_config config ON config.id = relation.config_id;
    INSERT INTO status_components(
      page_id, component_type, component_id, sort_order,
      created_at_ms, updated_at_ms
    )
    SELECT relation.config_id, 'agent', relation.agent_id,
           ROW_NUMBER() OVER (
             PARTITION BY relation.config_id ORDER BY relation.agent_id
           ) - 1,
           COALESCE(CAST(strftime('%s', config.created_at) AS INTEGER) * 1000,
                    1767225600000),
           COALESCE(CAST(strftime('%s', config.updated_at) AS INTEGER) * 1000,
                    1767225600000)
    FROM status_page_agents relation
    JOIN status_page_config config ON config.id = relation.config_id;
    INSERT INTO legacy_id_map(
      source_table, source_id, target_table, target_id, payload_checksum,
      created_at, updated_at
    )
    SELECT 'status_page_config', CAST(id AS TEXT), 'status_pages',
           CAST(id AS TEXT), 'fixture-status-page',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    FROM status_page_config;
    INSERT INTO legacy_id_map(
      source_table, source_id, target_table, target_id, payload_checksum,
      created_at, updated_at
    )
    SELECT 'status_page_monitors', CAST(config_id AS TEXT) || ':' ||
           CAST(monitor_id AS TEXT), 'status_components',
           CAST(config_id AS TEXT) || ':monitor:' || CAST(monitor_id AS TEXT),
           'fixture-status-monitor',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    FROM status_page_monitors;
    INSERT INTO legacy_id_map(
      source_table, source_id, target_table, target_id, payload_checksum,
      created_at, updated_at
    )
    SELECT 'status_page_agents', CAST(config_id AS TEXT) || ':' ||
           CAST(agent_id AS TEXT), 'status_components',
           CAST(config_id AS TEXT) || ':agent:' || CAST(agent_id AS TEXT),
           'fixture-status-agent',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    FROM status_page_agents;
    INSERT INTO notification_rules(
      id, target_type, target_id, enabled, on_down, on_recovery, on_offline,
      on_cpu_threshold, cpu_threshold, on_memory_threshold, memory_threshold,
      on_disk_threshold, disk_threshold, cooldown_minutes,
      created_at_ms, updated_at_ms
    )
    SELECT id, target_type, target_id, enabled, on_down, on_recovery, on_offline,
           on_cpu_threshold, cpu_threshold, on_memory_threshold, memory_threshold,
           on_disk_threshold, disk_threshold, cooldown_minutes,
           COALESCE(unixepoch(created_at) * 1000, 0),
           COALESCE(unixepoch(updated_at) * 1000, 0)
    FROM notification_settings;
    INSERT INTO notification_rule_endpoints(
      rule_id, channel_id, sort_order, created_at_ms, updated_at_ms
    )
    SELECT setting.id, CAST(channel.value AS INTEGER),
           CAST(channel.key AS INTEGER),
           COALESCE(unixepoch(setting.created_at) * 1000, 0),
           COALESCE(unixepoch(setting.updated_at) * 1000, 0)
    FROM notification_settings setting
    JOIN json_each(setting.channels) channel
    WHERE channel.type = 'integer';
    INSERT INTO legacy_id_map(
      source_table, source_id, target_table, target_id, payload_checksum,
      created_at, updated_at
    )
    SELECT 'notification_settings', CAST(id AS TEXT), 'notification_rules',
           CAST(id AS TEXT), 'fixture-notification-rule',
           updated_at, updated_at
    FROM notification_settings;
    INSERT INTO legacy_id_map(
      source_table, source_id, target_table, target_id, payload_checksum,
      created_at, updated_at
    )
    SELECT 'notification_settings_channels', CAST(setting.id AS TEXT) || ':' ||
           CAST(channel.key AS TEXT), 'notification_rule_endpoints',
           CAST(setting.id AS TEXT) || ':' || CAST(channel.value AS TEXT),
           'fixture-notification-endpoint', setting.updated_at, setting.updated_at
    FROM notification_settings setting
    JOIN json_each(setting.channels) channel
    WHERE channel.type = 'integer';
    INSERT INTO notification_template_definitions(
      id, name, type, current_version, is_default, deleted_at_ms,
      created_at_ms, updated_at_ms
    )
    SELECT id, name, type, 1, is_default,
           CASE WHEN deleted_at IS NULL THEN NULL
                ELSE COALESCE(unixepoch(deleted_at) * 1000, 0) END,
           COALESCE(unixepoch(created_at) * 1000, 0),
           COALESCE(unixepoch(updated_at) * 1000, 0)
    FROM notification_templates;
    INSERT INTO notification_template_versions(
      template_id, version, subject, content, created_at_ms
    )
    SELECT id, 1, subject, content,
           COALESCE(unixepoch(updated_at) * 1000, 0)
    FROM notification_templates;
    INSERT INTO legacy_id_map(
      source_table, source_id, target_table, target_id, payload_checksum,
      created_at, updated_at
    )
    SELECT 'notification_templates', CAST(id AS TEXT),
           'notification_template_definitions', CAST(id AS TEXT),
           'fixture-notification-template', updated_at, updated_at
    FROM notification_templates;
  `);
  const contractPreflight = runMigrationPreflight(databasePath);
  assert.equal(contractPreflight.readyForCredentialContract, true);
  assert.equal(
    contractPreflight.conservation.every((item) => item.conserved),
    true,
    "every migration domain must satisfy the explicit conservation equation"
  );
  assert.equal(contractPreflight.schema.quickCheck, "ok");
  assert.equal(contractPreflight.schema.integrityCheck, "ok");
  assert.equal(contractPreflight.counts.unverifiedRawSampleArchiveBatches, 0);
  assert.equal(
    contractPreflight.counts.rawSampleArchiveMembersOnUnverifiedBatches,
    0
  );

  sqlite(`
    INSERT INTO raw_sample_archive_batches(
      id, domain, object_key, content_sha256, object_size_bytes, source_rows,
      range_start, range_end, status, attempts, created_at, updated_at
    ) VALUES (
      'agent:pending-fixture', 'agent',
      'raw-samples/v1/agent/2026/01/01/pending-fixture.jsonl',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      10, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      'pending', 1, '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );
  `);
  const pendingArchivePreflight = runMigrationPreflight(databasePath);
  assert.equal(pendingArchivePreflight.readyForCredentialContract, false);
  assert.equal(
    pendingArchivePreflight.counts.unverifiedRawSampleArchiveBatches,
    1
  );
  sqlite(`
    UPDATE raw_sample_archive_batches
    SET status = 'verified', verified_at = updated_at
    WHERE id = 'agent:pending-fixture';
  `);
  assert.equal(
    runMigrationPreflight(databasePath).readyForCredentialContract,
    true
  );

  // A surplus mapping used to be hidden by max(0, source - mapped - anomaly).
  // The final Contract gate must also reject target/map inflation.
  sqlite(`
    INSERT INTO legacy_id_map(
      source_table, source_id, target_table, target_id, payload_checksum,
      created_at, updated_at
    ) VALUES (
      'notification_history', 'surplus-fixture', 'notification_messages',
      'surplus-fixture', 'fixture-surplus',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `);
  const surplusMappingPreflight = runMigrationPreflight(databasePath);
  assert.equal(surplusMappingPreflight.readyForCredentialContract, false);
  assert.deepEqual(
    surplusMappingPreflight.conservation.find(
      (item) => item.key === "notification-history"
    ),
    {
      key: "notification-history",
      sourceRows: 0,
      migratedRows: 1,
      deduplicatedRows: 0,
      archivedRows: 0,
      anomalyRows: 0,
      difference: -1,
      conserved: false,
    }
  );
  sqlite(
    "DELETE FROM legacy_id_map WHERE source_table = 'notification_history' AND source_id = 'surplus-fixture';"
  );
  sqlite(`
    INSERT INTO migration_checkpoints(
      migration_key, phase, status, rows_read, rows_written, rows_skipped,
      anomaly_rows, started_at, created_at, updated_at
    ) VALUES (
      'fixture-backfill', 'backfill', 'running', 1, 0, 0, 1,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO migration_anomalies(
      migration_key, source_table, source_pk, error_code, raw_value_json,
      status, first_seen_at, created_at, updated_at
    ) VALUES (
      'fixture-backfill', 'agents', '1', 'fixture_error', '{}', 'open',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );
  `);
  const ledgerBlockedPreflight = runMigrationPreflight(databasePath);
  assert.equal(ledgerBlockedPreflight.readyForExpand, true);
  assert.equal(ledgerBlockedPreflight.readyForCredentialContract, false);
  assert.equal(ledgerBlockedPreflight.counts.openMigrationAnomalies, 1);
  assert.equal(ledgerBlockedPreflight.counts.incompleteMigrationCheckpoints, 1);
  sqlite(`
    UPDATE migration_checkpoints
    SET status = 'completed_with_anomalies', completed_at = updated_at
    WHERE migration_key = 'fixture-backfill';
    UPDATE migration_anomalies
    SET status = 'ignored', resolved_at = updated_at
    WHERE migration_key = 'fixture-backfill';
  `);
  const acceptedLedgerPreflight = runMigrationPreflight(databasePath);
  assert.equal(acceptedLedgerPreflight.readyForCredentialContract, true);
  assert.equal(acceptedLedgerPreflight.counts.openMigrationAnomalies, 0);
  assert.equal(acceptedLedgerPreflight.counts.incompleteMigrationCheckpoints, 0);
  assert.equal(
    acceptedLedgerPreflight.counts.completedMigrationCheckpointsWithAnomalies,
    1
  );
  sqlite(`
    INSERT INTO notification_secrets(
      channel_id, ciphertext, iv, wrapped_dek, wrap_iv, key_version,
      created_at, updated_at
    ) VALUES (
      1, 'fixture', 'fixture', 'fixture', 'fixture', 2,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `);
  const oldKekPreflight = runMigrationPreflight(databasePath, {
    notificationKekVersion: 1,
  });
  assert.equal(oldKekPreflight.readyForCredentialContract, false);
  assert.equal(oldKekPreflight.counts.notificationSecretsOutsideTargetKek, 1);
  assert.equal(
    runMigrationPreflight(databasePath, { notificationKekVersion: 2 })
      .readyForCredentialContract,
    true
  );

  // 规模门禁：一百万条旧历史样本 + 动态轮换表必须进入同一只读清单，
  // Preflight 不加载样本内容，耗时预算覆盖普通 CI runner。
  sqlite(`
    WITH RECURSIVE seq(value) AS (
      SELECT 0 UNION ALL SELECT value + 1 FROM seq WHERE value < 999
    )
    INSERT INTO agent_metrics_history(id, agent_id, timestamp, cpu_usage)
    SELECT left_seq.value * 1000 + right_seq.value + 1, 1,
           '2026-01-01T00:00:00.000Z', 50.0
    FROM seq left_seq CROSS JOIN seq right_seq;
    CREATE TABLE agent_metrics_history_old AS
      SELECT * FROM agent_metrics_history WHERE id <= 10;
  `);
  const scaleStartedAt = performance.now();
  const scalePreflight = runMigrationPreflight(databasePath);
  const scaleDurationMs = performance.now() - scaleStartedAt;
  assert.equal(scalePreflight.counts.agentMetricsHistoryRows, 1_000_000);
  assert.equal(scalePreflight.counts.legacyAgentMetricsHistoryRows, 10);
  assert.equal(scalePreflight.counts.agentHistoricalRowsTotal, 1_000_010);
  assert.equal(scalePreflight.counts.unconservedLegacyAgentHistoryRows, 1_000_010);
  assert.equal(scalePreflight.readyForCredentialContract, false);
  assert.deepEqual(scalePreflight.schema.legacyHistoryTables, [
    "agent_metrics_history_old",
  ]);
  assert.ok(
    scaleDurationMs < 30_000,
    `million-row migration preflight exceeded budget: ${scaleDurationMs.toFixed(0)}ms`
  );

  const emptyDatabasePath = join(tempDir, "empty.sqlite");
  execFileSync("sqlite3", [emptyDatabasePath, "PRAGMA user_version;"]);
  assert.equal(
    runMigrationPreflight(emptyDatabasePath, { allowEmpty: true }).readyForExpand,
    true
  );
  assert.equal(sqlite("PRAGMA foreign_key_check;"), "");
  assert.equal(sqlite("PRAGMA integrity_check;"), "ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
