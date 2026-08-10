import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MigrationManifest } from "../tooling/migrations/manifest";
import type {
  DataConservationCheck,
  MigrationPreflightReport,
} from "../tooling/migrations/preflight";
import type { MigrationPostflightReport } from "../tooling/migrations/postflight";
import {
  createContractReleaseBundle,
  writeContractReleaseBundle,
} from "../tooling/contract/prepare-release";
import { renderContractMigration } from "../tooling/contract/render-migration";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(backendRoot, "..");
const directory = mkdtempSync(join(tmpdir(), "xugou-contract-release-"));
const gitSha = "0123456789abcdef0123456789abcdef01234567";
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
const conservation: DataConservationCheck[] = conservationKeys.map((key) => ({
  key,
  sourceRows: 1,
  migratedRows: 1,
  deduplicatedRows: 0,
  archivedRows: 0,
  anomalyRows: 0,
  difference: 0,
  conserved: true,
}));

const sqlExportPath = join(directory, "xugou.sql");
const preflightPath = join(directory, "preflight.json");
const migrationManifestPath = join(directory, "migration-manifest.json");
const readinessPath = join(directory, "release-readiness.json");
const bookmarkPath = join(directory, "bookmark.json");
const postflightPath = join(directory, "postflight.json");
const postSqlExportPath = join(directory, "xugou-post.sql");
const postBookmarkPath = join(directory, "post-bookmark.json");
const outputPath = join(directory, "contract-release.json");
const cleanupPlanPath = join(backendRoot, "contract/cleanup-plan.json");
const retentionPolicyPath = join(backendRoot, "contract/retention-policy.json");

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

try {
  const sqlExport = "PRAGMA foreign_keys=OFF;\nCREATE TABLE fixture(id INTEGER);\n";
  writeFileSync(sqlExportPath, sqlExport);
  const bookmark = { bookmark: "fixture-bookmark" };
  writeFileSync(bookmarkPath, JSON.stringify(bookmark));
  const postBookmark = { bookmark: "fixture-post-bookmark" };
  writeFileSync(postBookmarkPath, JSON.stringify(postBookmark));
  const preflight: MigrationPreflightReport = {
    generatedAt: "2026-08-09T00:00:00.000Z",
    database: sqlExportPath,
    emptyDatabase: false,
    readyForExpand: true,
    readyForCredentialContract: true,
    blockers: [],
    warnings: [],
    counts: { foreignKeyViolations: 0 },
    conservation,
    schema: {
      tables: ["agents", "monitors", "notification_channels"],
      legacyHistoryTables: [
        "agent_metrics_history_old",
        "agent_metrics_history_123",
      ],
      latestEmbeddedMigration: "0040_neat_the_fury.sql",
      quickCheck: "ok",
      integrityCheck: "ok",
    },
  };
  writeFileSync(preflightPath, JSON.stringify(preflight));
  const postPreflight: MigrationPreflightReport = {
    ...structuredClone(preflight),
    generatedAt: "2026-08-09T00:01:00.000Z",
  };
  const postflight: MigrationPostflightReport = {
    generatedAt: "2026-08-09T00:01:30.000Z",
    mode: "contract",
    ready: true,
    blockers: [],
    coreCountDelta: {},
    conservationDelta: conservation.map((item) => ({
      key: item.key,
      before: item.difference,
      after: item.difference,
      regressed: false,
    })),
    preflight,
    postflight: postPreflight,
  };
  writeFileSync(postflightPath, JSON.stringify(postflight));
  const postSqlExport = `${sqlExport}-- post migration\n`;
  writeFileSync(postSqlExportPath, postSqlExport);
  const migrationManifest: MigrationManifest = {
    formatVersion: 2,
    generatedAt: "2026-08-09T00:01:00.000Z",
    gitSha,
    database: sqlExportPath,
    export: {
      path: sqlExportPath,
      bytes: Buffer.byteLength(sqlExport),
      sha256: sha256(sqlExport),
    },
    bookmark,
    preflight: {
      readyForExpand: true,
      readyForCredentialContract: true,
      blockers: [],
      warnings: [],
      counts: preflight.counts,
      conservation,
      schema: preflight.schema,
    },
    migrationResult: "No migrations to apply",
    postflight,
    postExport: {
      path: postSqlExportPath,
      bytes: Buffer.byteLength(postSqlExport),
      sha256: sha256(postSqlExport),
    },
    postBookmark,
  };
  writeFileSync(migrationManifestPath, JSON.stringify(migrationManifest));
  writeFileSync(
    readinessPath,
    JSON.stringify({
      data: {
        generated_at: "2026-08-09T00:02:00.000Z",
        release_version: "fixture-version",
        release_ready: true,
        contract_worker_ready: true,
        credential_contract_ready: true,
        management_v1_sunset_ready: true,
        agent_v1_sunset_ready: true,
        checks: [
          {
            key: "fixture",
            ready: true,
            actual: 0,
            threshold: 0,
            direction: "maximum",
          },
        ],
      },
    })
  );

  const input = {
    preflightPath,
    migrationManifestPath,
    readinessPath,
    bookmarkPath,
    sqlExportPath,
    postflightPath,
    postBookmarkPath,
    postSqlExportPath,
    cleanupPlanPath,
    retentionPolicyPath,
    gitSha,
    generatedAt: new Date("2026-08-09T00:03:00.000Z"),
  };
  const expandPostflight: MigrationPostflightReport = {
    ...structuredClone(postflight),
    mode: "expand",
  };
  writeFileSync(postflightPath, JSON.stringify(expandPostflight));
  writeFileSync(
    migrationManifestPath,
    JSON.stringify({ ...migrationManifest, postflight: expandPostflight })
  );
  assert.throws(
    () => createContractReleaseBundle(input),
    /Contract-mode postflight/,
    "an Expand postflight must never authorize destructive Contract SQL"
  );
  writeFileSync(postflightPath, JSON.stringify(postflight));
  writeFileSync(migrationManifestPath, JSON.stringify(migrationManifest));
  const bundle = createContractReleaseBundle(input);
  assert.equal(bundle.formatVersion, 2);
  assert.equal(bundle.status, "ready");
  assert.equal(bundle.architecture, "single-worker-modular-monolith");
  assert.equal(bundle.gates.allDataConserved, true);
  assert.deepEqual(bundle.cleanup.dynamicLegacyTables, [
    "agent_metrics_history_old",
    "agent_metrics_history_123",
  ]);
  assert.equal(bundle.evidence.sqlExport.sha256, sha256(sqlExport));
  assert.equal(bundle.evidence.postSqlExport.sha256, sha256(postSqlExport));
  assert.equal(bundle.retention.sqlExportMinimumDays, 400);
  assert.equal(bundle.readinessSnapshot.release_version, "fixture-version");

  const bundleText = `${JSON.stringify(bundle, null, 2)}\n`;
  const contractSql = renderContractMigration({
    bundleText,
    activatedAt: new Date("2026-08-09T00:04:00.000Z"),
  });
  assert.match(contractSql, /ALTER TABLE agents RENAME COLUMN token TO anchor_nonce/);
  assert.match(contractSql, /DROP TABLE IF EXISTS "agent_metrics_history_old"/);
  assert.match(contractSql, /INSERT INTO contract_release_evidence/);
  assert.doesNotMatch(contractSql, /BEGIN TRANSACTION|COMMIT;/);
  const unsafeBundle = structuredClone(bundle);
  unsafeBundle.cleanup.dynamicLegacyTables = ["agents; DROP TABLE agents"];
  assert.throws(
    () =>
      renderContractMigration({
        bundleText: JSON.stringify(unsafeBundle),
        activatedAt: new Date("2026-08-09T00:04:00.000Z"),
      }),
    /unsafe dynamic table/
  );

  const persistTo = join(directory, "wrangler-state");
  const setupPath = join(directory, "contract-setup.sql");
  const contractSqlPath = join(directory, "contract.sql");
  const commandEnvironment = { ...process.env, CI: "1", NO_COLOR: "1" };
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--persist-to",
      persistTo,
    ],
    {
      cwd: repositoryRoot,
      env: commandEnvironment,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  writeFileSync(
    setupPath,
    `INSERT INTO notification_template_definitions
     (id, name, type, current_version, is_default, deleted_at_ms,
      created_at_ms, updated_at_ms)
     SELECT id, name, type, 1, is_default,
            CASE WHEN deleted_at IS NULL THEN NULL
                 ELSE CAST(strftime('%s', deleted_at) AS INTEGER) * 1000 END,
            CAST(strftime('%s', created_at) AS INTEGER) * 1000,
            CAST(strftime('%s', updated_at) AS INTEGER) * 1000
     FROM notification_templates;
     INSERT INTO notification_template_versions
     (template_id, version, subject, content, created_at_ms)
     SELECT id, 1, subject, content,
            CAST(strftime('%s', created_at) AS INTEGER) * 1000
     FROM notification_templates;
     INSERT INTO status_pages
     (id, singleton_key, title, description, logo_url, custom_css, theme,
      created_at_ms, updated_at_ms)
     SELECT id, 1, title, description, logo_url, custom_css, theme,
            CAST(strftime('%s', created_at) AS INTEGER) * 1000,
            CAST(strftime('%s', updated_at) AS INTEGER) * 1000
     FROM status_page_config;
     CREATE TABLE agent_metrics_history_123 AS
       SELECT * FROM agent_metrics_history WHERE 0;
     DELETE FROM domain_outbox;
    `
  );
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      persistTo,
      "--file",
      setupPath,
    ],
    { cwd: repositoryRoot, env: commandEnvironment, encoding: "utf8" }
  );
  writeFileSync(contractSqlPath, contractSql);
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      persistTo,
      "--file",
      contractSqlPath,
    ],
    {
      cwd: repositoryRoot,
      env: commandEnvironment,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  const schemaCheck = execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      persistTo,
      "--command",
      `SELECT group_concat(name, ',') AS agent_columns
       FROM pragma_table_info('agents');
       SELECT COUNT(*) AS old_tables FROM sqlite_schema
       WHERE type = 'table' AND name IN (
        'status_page_config', 'notification_history',
        'agent_metrics_history_123', 'monitor_daily_stats'
       );
       SELECT COUNT(*) AS fk_violations FROM pragma_foreign_key_check;
       SELECT phase FROM contract_release_state WHERE singleton_key = 1;`,
    ],
    {
      cwd: repositoryRoot,
      env: commandEnvironment,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }
  );
  assert.match(schemaCheck, /id,anchor_nonce,created_at,updated_at/);
  assert.match(schemaCheck, /old_tables[\s\S]*0/);
  assert.match(schemaCheck, /fk_violations[\s\S]*0/);
  assert.match(schemaCheck, /phase[\s\S]*active/);

  writeContractReleaseBundle(outputPath, bundle);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(readFileSync(outputPath, "utf8")).status,
    "ready"
  );

  const unconserved = structuredClone(preflight);
  unconserved.conservation[0] = {
    ...unconserved.conservation[0],
    migratedRows: 0,
    difference: 1,
    conserved: false,
  };
  writeFileSync(preflightPath, JSON.stringify(unconserved));
  assert.throws(
    () => createContractReleaseBundle(input),
    /Postflight before snapshot does not match preflight|Data is not conserved/
  );
  writeFileSync(preflightPath, JSON.stringify(preflight));

  writeFileSync(sqlExportPath, `${sqlExport}-- tampered\n`);
  assert.throws(
    () => createContractReleaseBundle(input),
    /SQL Export does not match/
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
