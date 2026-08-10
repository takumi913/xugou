import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContractReleaseBundle } from "./prepare-release";
import {
  CONTRACT_STATIC_DROP_TABLES,
  contractSchemaStatements,
} from "../../src/platform/compatibility/ContractSchemaPlan";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function validateBundle(value: unknown): ContractReleaseBundle {
  if (!value || typeof value !== "object") {
    throw new Error("Contract release bundle must be an object");
  }
  const bundle = value as ContractReleaseBundle;
  if (
    bundle.formatVersion !== 2 ||
    bundle.status !== "ready" ||
    bundle.architecture !== "single-worker-modular-monolith"
  ) {
    throw new Error("Contract release bundle is not a ready v2 single-Worker bundle");
  }
  if (
    !bundle.gates.sqliteIntegrity ||
    !bundle.gates.foreignKeys ||
    !bundle.gates.credentialsAndSecrets ||
    !bundle.gates.managementV1Sunset ||
    !bundle.gates.agentV1Sunset ||
    !bundle.gates.queuesAndPublications ||
    !bundle.gates.allDataConserved
  ) {
    throw new Error("Contract release bundle contains a failed gate");
  }
  if (
    !bundle.releaseVersion?.trim() ||
    !/^[0-9a-f]{7,64}$/i.test(bundle.gitSha) ||
    !Number.isFinite(Date.parse(bundle.generatedAt)) ||
    !bundle.readinessSnapshot
  ) {
    throw new Error("Contract release bundle metadata is incomplete");
  }
  return bundle;
}

export function renderContractMigration(input: {
  bundleText: string;
  activatedAt?: Date;
}) {
  const bundle = validateBundle(JSON.parse(input.bundleText) as unknown);
  const bundleSha256 = sha256(input.bundleText);
  const evidenceId = `contract:${bundleSha256}`;
  const activatedAt = (input.activatedAt ?? new Date()).toISOString();
  const expectedStatic = new Set(CONTRACT_STATIC_DROP_TABLES);
  const suppliedStatic = new Set(bundle.cleanup.staticDropTables);
  for (const table of bundle.cleanup.staticDropTables) {
    if (
      !expectedStatic.has(
        table as (typeof CONTRACT_STATIC_DROP_TABLES)[number]
      )
    ) {
      throw new Error(`Contract bundle contains an unexpected static table: ${table}`);
    }
  }
  for (const table of expectedStatic) {
    if (!suppliedStatic.has(table)) {
      throw new Error(`Contract bundle is missing static table: ${table}`);
    }
  }

  const statements = [
    `-- XUGOU independent Contract migration`,
    `-- bundle_sha256=${bundleSha256}`,
    `-- This file is executed once with: wrangler d1 execute DB --remote --file=FILE`,
    `PRAGMA defer_foreign_keys = on;`,
    `DROP TABLE IF EXISTS _contract_validation_gate;`,
    `CREATE TABLE _contract_validation_gate(value INTEGER NOT NULL CHECK(value = 0));`,
    `INSERT INTO _contract_validation_gate(value)`,
    `SELECT CASE WHEN`,
    `  (SELECT COUNT(*) FROM pragma_table_info('agents') WHERE name = 'token') = 1`,
    `  AND (SELECT COUNT(*) FROM pragma_table_info('monitors') WHERE name = 'url') = 1`,
    `  AND (SELECT COUNT(*) FROM pragma_table_info('notification_channels') WHERE name = 'config') = 1`,
    `  AND (SELECT COUNT(*) FROM pragma_table_info('notification_templates') WHERE name = 'subject') = 1`,
    `THEN 0 ELSE 1 END;`,
    `INSERT INTO _contract_validation_gate(value)`,
    `SELECT CASE WHEN NOT EXISTS (`,
    `  SELECT id FROM agents EXCEPT SELECT id FROM agent_nodes`,
    `) AND NOT EXISTS (`,
    `  SELECT id FROM agent_nodes EXCEPT SELECT id FROM agents`,
    `) AND NOT EXISTS (`,
    `  SELECT id FROM monitors EXCEPT SELECT id FROM monitor_definitions`,
    `) AND NOT EXISTS (`,
    `  SELECT id FROM monitor_definitions EXCEPT SELECT id FROM monitors`,
    `) AND NOT EXISTS (`,
    `  SELECT id FROM notification_channels WHERE deleted_at IS NULL`,
    `  EXCEPT SELECT channel_id FROM notification_endpoints`,
    `) AND NOT EXISTS (`,
    `  SELECT id FROM notification_templates EXCEPT SELECT id FROM notification_template_definitions`,
    `) THEN 0 ELSE 1 END;`,
    `INSERT INTO _contract_validation_gate(value)`,
    `SELECT CASE WHEN`,
    `  (SELECT COUNT(*) FROM async_jobs WHERE status IN ('pending', 'retry', 'processing')) = 0`,
    `  AND (SELECT COUNT(*) FROM domain_outbox WHERE status IN ('pending', 'published')) = 0`,
    `  AND (SELECT COUNT(*) FROM notification_messages WHERE status IN ('pending', 'retry', 'sending')) = 0`,
    `  AND (SELECT COUNT(*) FROM queue_failures WHERE status = 'open') = 0`,
    `  AND (SELECT COUNT(*) FROM migration_anomalies WHERE status IN ('open', 'retry_requested')) = 0`,
    `  AND (SELECT COUNT(*) FROM migration_checkpoints WHERE status IN ('running', 'failed')) = 0`,
    `  AND (SELECT COUNT(*) FROM raw_sample_archive_batches WHERE status <> 'verified' OR verified_at IS NULL) = 0`,
    `THEN 0 ELSE 1 END;`,
    `INSERT INTO contract_release_evidence`,
    `(id, bundle_sha256, release_version, git_sha, bundle_json, prepared_at,`,
    ` created_at, updated_at) VALUES (`,
    `${literal(evidenceId)}, ${literal(bundleSha256)}, ${literal(bundle.releaseVersion)},`,
    `${literal(bundle.gitSha)}, ${literal(input.bundleText)}, ${literal(bundle.generatedAt)},`,
    `${literal(activatedAt)}, ${literal(activatedAt)});`,
    ...contractSchemaStatements(bundle.cleanup.dynamicLegacyTables),
    `INSERT INTO contract_release_state`,
    `(singleton_key, active_evidence_id, phase, activated_at, updated_at)`,
    `VALUES (1, ${literal(evidenceId)}, 'active', ${literal(activatedAt)}, ${literal(activatedAt)})`,
    `ON CONFLICT(singleton_key) DO UPDATE SET`,
    ` active_evidence_id = excluded.active_evidence_id, phase = excluded.phase,`,
    ` activated_at = excluded.activated_at, updated_at = excluded.updated_at;`,
    `INSERT INTO _contract_validation_gate(value)`,
    `SELECT CASE WHEN (SELECT COUNT(*) FROM pragma_foreign_key_check) = 0`,
    `THEN 0 ELSE 1 END;`,
    `DROP TABLE _contract_validation_gate;`,
    `PRAGMA defer_foreign_keys = off;`,
    `PRAGMA optimize;`,
  ];
  return `${statements.join("\n")}\n`;
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const bundlePath = argument("--bundle");
  const outputPath = argument("--output");
  const activatedAtValue = argument("--activated-at");
  if (!bundlePath || !outputPath) {
    console.error(
      "用法: contract:render -- --bundle FILE --output FILE [--activated-at ISO8601]"
    );
    process.exitCode = 2;
  } else {
    const activatedAt = activatedAtValue ? new Date(activatedAtValue) : undefined;
    if (activatedAtValue && !Number.isFinite(activatedAt?.getTime())) {
      throw new Error("--activated-at must be an ISO8601 timestamp");
    }
    const sql = renderContractMigration({
      bundleText: readFileSync(resolve(bundlePath), "utf8"),
      activatedAt,
    });
    const output = resolve(outputPath);
    writeFileSync(output, sql, { mode: 0o600 });
    chmodSync(output, 0o600);
  }
}
