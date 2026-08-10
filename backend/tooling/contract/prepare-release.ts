import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  chmodSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MigrationManifest } from "../migrations/manifest";
import type {
  DataConservationCheck,
  MigrationPreflightReport,
} from "../migrations/preflight";
import type { MigrationPostflightReport } from "../migrations/postflight";

const expectedConservationKeys = [
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
] as const;

type ReadinessCheck = {
  key: string;
  ready: boolean;
  actual: number | null;
  threshold: number;
  direction: string;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type ReleaseReadiness = {
  generated_at: string;
  release_version: string;
  release_ready: boolean;
  contract_worker_ready: boolean;
  credential_contract_ready: boolean;
  management_v1_sunset_ready: boolean;
  agent_v1_sunset_ready: boolean;
  checks: ReadinessCheck[];
};

type CleanupPlan = {
  formatVersion: number;
  architecture: string;
  execution: string;
  requiredGates: string[];
  steps: unknown[];
  identityAnchorRebuilds: Array<{ table: string }>;
  dropTablesAfterArchive: string[];
  preserveTables: string[];
};

type RetentionPolicy = {
  formatVersion: number;
  policyVersion: string;
  archive: {
    contractSqlExportRequired: boolean;
    artifactUploadAllowed: boolean;
    storageRequirement: string;
    checksum: string;
    minimumDays: number;
    deletionRequiresBookmark: boolean;
  };
  datasets: Array<{
    tables: string[];
    deleteRule: string;
    archiveBinding?: string;
  }>;
};

export interface ContractReleaseBundle {
  formatVersion: 2;
  generatedAt: string;
  status: "ready";
  architecture: "single-worker-modular-monolith";
  gitSha: string;
  releaseVersion: string;
  evidence: {
    preflightSha256: string;
    migrationManifestSha256: string;
    readinessSha256: string;
    bookmarkSha256: string;
    sqlExport: { bytes: number; sha256: string };
    postflightSha256: string;
    postBookmarkSha256: string;
    postSqlExport: { bytes: number; sha256: string };
  };
  gates: {
    sqliteIntegrity: true;
    foreignKeys: true;
    credentialsAndSecrets: true;
    managementV1Sunset: true;
    agentV1Sunset: true;
    queuesAndPublications: true;
    allDataConserved: true;
  };
  conservation: DataConservationCheck[];
  readinessSnapshot: ReleaseReadiness;
  cleanup: {
    planSha256: string;
    identityAnchorTables: string[];
    staticDropTables: string[];
    dynamicLegacyTables: string[];
    evidenceTablesPreserved: string[];
  };
  retention: {
    policyVersion: string;
    policySha256: string;
    sqlExportMinimumDays: number;
    storageRequirement: string;
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

function sha256Bytes(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string) {
  return sha256Bytes(readFileSync(resolve(path)));
}

function readinessFrom(value: unknown): ReleaseReadiness {
  if (!value || typeof value !== "object") {
    throw new Error("Contract readiness JSON must be an object");
  }
  const envelope = record(value);
  const data =
    envelope.data && typeof envelope.data === "object"
      ? record(envelope.data)
      : envelope;
  for (const key of [
    "release_ready",
    "contract_worker_ready",
    "credential_contract_ready",
    "management_v1_sunset_ready",
    "agent_v1_sunset_ready",
  ]) {
    if (data[key] !== true) throw new Error(`Contract gate is not ready: ${key}`);
  }
  if (!Array.isArray(data.checks)) {
    throw new Error("Contract readiness is missing checks");
  }
  const stringField = (key: string) => {
    if (typeof data[key] !== "string" || data[key].length === 0) {
      throw new Error(`Contract readiness is missing ${key}`);
    }
    return data[key];
  };
  const checks = data.checks.map((item, index): ReadinessCheck => {
    const row = record(item);
    if (
      typeof row.key !== "string" ||
      typeof row.ready !== "boolean" ||
      (row.actual !== null && typeof row.actual !== "number") ||
      typeof row.threshold !== "number" ||
      typeof row.direction !== "string"
    ) {
      throw new Error(`Contract readiness check ${index} is invalid`);
    }
    return {
      key: row.key,
      ready: row.ready,
      actual: row.actual,
      threshold: row.threshold,
      direction: row.direction,
    };
  });
  const readiness: ReleaseReadiness = {
    generated_at: stringField("generated_at"),
    release_version: stringField("release_version"),
    release_ready: true,
    contract_worker_ready: true,
    credential_contract_ready: true,
    management_v1_sunset_ready: true,
    agent_v1_sunset_ready: true,
    checks,
  };
  const failed = readiness.checks.filter((item) => !item.ready);
  if (failed.length > 0) {
    throw new Error(
      `Contract readiness contains failed checks: ${failed
        .map((item) => item.key)
        .join(", ")}`
    );
  }
  if (!Number.isFinite(Date.parse(readiness.generated_at))) {
    throw new Error("Contract readiness has an invalid generated_at");
  }
  return readiness;
}

function validateConservation(preflight: MigrationPreflightReport) {
  if (!Array.isArray(preflight.conservation)) {
    throw new Error("Preflight does not contain explicit data conservation");
  }
  const byKey = new Map(preflight.conservation.map((item) => [item.key, item]));
  for (const key of expectedConservationKeys) {
    const item = byKey.get(key);
    if (!item) throw new Error(`Preflight is missing conservation domain ${key}`);
    if (!item.conserved || item.difference !== 0) {
      throw new Error(
        `Data is not conserved for ${key}: difference=${item.difference ?? "unknown"}`
      );
    }
    if (
      item.sourceRows !==
      item.migratedRows +
        item.deduplicatedRows +
        item.archivedRows +
        item.anomalyRows
    ) {
      throw new Error(`Invalid conservation equation for ${key}`);
    }
  }
}

function validateRetentionPolicy(policy: RetentionPolicy) {
  if (
    policy.formatVersion !== 1 ||
    !policy.archive.contractSqlExportRequired ||
    policy.archive.artifactUploadAllowed ||
    policy.archive.checksum !== "sha256" ||
    !policy.archive.deletionRequiresBookmark ||
    policy.archive.minimumDays < 400
  ) {
    throw new Error("Retention policy does not satisfy the Contract archive gate");
  }
  const coveredTables = new Set(
    policy.datasets.flatMap((dataset) => dataset.tables)
  );
  for (const table of [
    "agent_report_samples",
    "monitor_check_samples",
    "notification_attempts",
    "security_audit_events",
    "migration_anomalies",
    "legacy_id_map",
  ]) {
    if (!coveredTables.has(table)) {
      throw new Error(`Retention policy is missing ${table}`);
    }
  }
  for (const table of ["agent_report_samples", "monitor_check_samples"]) {
    const dataset = policy.datasets.find((item) => item.tables.includes(table));
    if (
      dataset?.archiveBinding !== "RAW_SAMPLE_ARCHIVE" ||
      dataset.deleteRule !==
        "delete-flag-and-source-before-cutoff-and-member-batch-r2-sha256-size-head-verified"
    ) {
      throw new Error(`Retention policy has no verified R2 gate for ${table}`);
    }
  }
  for (const table of [
    "raw_sample_archive_batches",
    "raw_sample_archive_members",
  ]) {
    const dataset = policy.datasets.find((item) => item.tables.includes(table));
    if (dataset?.deleteRule !== "none") {
      throw new Error(`Retention policy must preserve ${table}`);
    }
  }
}

export function createContractReleaseBundle(input: {
  preflightPath: string;
  migrationManifestPath: string;
  readinessPath: string;
  bookmarkPath: string;
  sqlExportPath: string;
  postflightPath: string;
  postBookmarkPath: string;
  postSqlExportPath: string;
  cleanupPlanPath: string;
  retentionPolicyPath: string;
  gitSha: string;
  generatedAt?: Date;
}): ContractReleaseBundle {
  const preflight = readJson<MigrationPreflightReport>(input.preflightPath);
  const migrationManifest = readJson<MigrationManifest>(
    input.migrationManifestPath
  );
  const readinessValue = readJson<unknown>(input.readinessPath);
  const readiness = readinessFrom(readinessValue);
  const bookmark = readJson<unknown>(input.bookmarkPath);
  const postflight = readJson<MigrationPostflightReport>(input.postflightPath);
  const postBookmark = readJson<unknown>(input.postBookmarkPath);
  const cleanupPlan = readJson<CleanupPlan>(input.cleanupPlanPath);
  const retentionPolicy = readJson<RetentionPolicy>(input.retentionPolicyPath);
  const gitSha = input.gitSha.trim();

  if (!/^[0-9a-f]{7,64}$/i.test(gitSha)) {
    throw new Error("Contract release requires a Git commit SHA");
  }
  if (migrationManifest.formatVersion !== 2) {
    throw new Error("Contract release requires Migration Manifest v2");
  }
  if (migrationManifest.gitSha !== gitSha) {
    throw new Error("Migration Manifest Git SHA does not match the release");
  }
  if (
    !migrationManifest.postflight ||
    !migrationManifest.postExport ||
    migrationManifest.postBookmark === undefined
  ) {
    throw new Error("Contract release requires complete postflight evidence");
  }
  if (!isDeepStrictEqual(migrationManifest.postflight, postflight)) {
    throw new Error("Postflight report does not match the Migration Manifest");
  }
  if (postflight.mode !== "contract") {
    throw new Error("Contract release requires a Contract-mode postflight");
  }
  if (!postflight.ready || postflight.blockers.length > 0) {
    throw new Error("Postflight is not ready for Contract");
  }
  if (
    !postflight.postflight.readyForExpand ||
    postflight.postflight.blockers.length > 0 ||
    postflight.postflight.schema.quickCheck !== "ok" ||
    postflight.postflight.schema.integrityCheck !== "ok" ||
    postflight.postflight.counts.foreignKeyViolations !== 0
  ) {
    throw new Error("Postflight database integrity is not ready for Contract");
  }
  if (!isDeepStrictEqual(postflight.preflight, preflight)) {
    throw new Error("Postflight before snapshot does not match preflight");
  }
  if (
    !preflight.readyForExpand ||
    !preflight.readyForCredentialContract ||
    preflight.blockers.length > 0
  ) {
    throw new Error("Preflight is not ready for Contract");
  }
  if (
    preflight.schema.quickCheck !== "ok" ||
    preflight.schema.integrityCheck !== "ok" ||
    preflight.counts.foreignKeyViolations !== 0
  ) {
    throw new Error("SQLite integrity or foreign-key gate failed");
  }
  validateConservation(preflight);
  validateConservation(postflight.postflight);
  if (!isDeepStrictEqual(migrationManifest.preflight.conservation, preflight.conservation)) {
    throw new Error("Migration Manifest conservation evidence does not match preflight");
  }
  if (!isDeepStrictEqual(migrationManifest.preflight.counts, preflight.counts)) {
    throw new Error("Migration Manifest counts do not match preflight");
  }

  const sqlExportPath = resolve(input.sqlExportPath);
  const sqlExportSha256 = sha256File(sqlExportPath);
  if (
    migrationManifest.export.sha256 !== sqlExportSha256 ||
    migrationManifest.export.bytes !== statSync(sqlExportPath).size
  ) {
    throw new Error("SQL Export does not match the Migration Manifest");
  }
  if (!isDeepStrictEqual(migrationManifest.bookmark, bookmark)) {
    throw new Error("Bookmark does not match the Migration Manifest");
  }
  const postSqlExportPath = resolve(input.postSqlExportPath);
  const postSqlExportSha256 = sha256File(postSqlExportPath);
  if (
    migrationManifest.postExport.sha256 !== postSqlExportSha256 ||
    migrationManifest.postExport.bytes !== statSync(postSqlExportPath).size
  ) {
    throw new Error("Post-migration SQL Export does not match the Migration Manifest");
  }
  if (!isDeepStrictEqual(migrationManifest.postBookmark, postBookmark)) {
    throw new Error("Post-migration Bookmark does not match the Migration Manifest");
  }

  if (
    cleanupPlan.formatVersion !== 1 ||
    cleanupPlan.architecture !== "single-worker-modular-monolith" ||
    cleanupPlan.execution !== "independent-contract-release" ||
    cleanupPlan.steps.length < 4 ||
    cleanupPlan.identityAnchorRebuilds.length < 4 ||
    cleanupPlan.dropTablesAfterArchive.length === 0
  ) {
    throw new Error("Contract cleanup plan is incomplete");
  }
  validateRetentionPolicy(retentionPolicy);

  const preflightGeneratedAt = Date.parse(preflight.generatedAt);
  const postflightGeneratedAt = Date.parse(postflight.generatedAt);
  const readinessGeneratedAt = Date.parse(readiness.generated_at);
  if (
    !Number.isFinite(preflightGeneratedAt) ||
    !Number.isFinite(postflightGeneratedAt) ||
    postflightGeneratedAt < preflightGeneratedAt ||
    readinessGeneratedAt < postflightGeneratedAt
  ) {
    throw new Error("Evidence timestamps must follow preflight, postflight, readiness order");
  }

  return {
    formatVersion: 2,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    status: "ready",
    architecture: "single-worker-modular-monolith",
    gitSha,
    releaseVersion: readiness.release_version,
    evidence: {
      preflightSha256: sha256File(input.preflightPath),
      migrationManifestSha256: sha256File(input.migrationManifestPath),
      readinessSha256: sha256File(input.readinessPath),
      bookmarkSha256: sha256File(input.bookmarkPath),
      sqlExport: {
        bytes: statSync(sqlExportPath).size,
        sha256: sqlExportSha256,
      },
      postflightSha256: sha256File(input.postflightPath),
      postBookmarkSha256: sha256File(input.postBookmarkPath),
      postSqlExport: {
        bytes: statSync(postSqlExportPath).size,
        sha256: postSqlExportSha256,
      },
    },
    gates: {
      sqliteIntegrity: true,
      foreignKeys: true,
      credentialsAndSecrets: true,
      managementV1Sunset: true,
      agentV1Sunset: true,
      queuesAndPublications: true,
      allDataConserved: true,
    },
    conservation: postflight.postflight.conservation,
    readinessSnapshot: readiness,
    cleanup: {
      planSha256: sha256File(input.cleanupPlanPath),
      identityAnchorTables: cleanupPlan.identityAnchorRebuilds.map(
        (item) => item.table
      ),
      staticDropTables: cleanupPlan.dropTablesAfterArchive.filter(
        (table) =>
          table !== "agent_metrics_history_old" &&
          table !== "agent_metrics_history_*"
      ),
      dynamicLegacyTables: postflight.postflight.schema.legacyHistoryTables,
      evidenceTablesPreserved: cleanupPlan.preserveTables,
    },
    retention: {
      policyVersion: retentionPolicy.policyVersion,
      policySha256: sha256File(input.retentionPolicyPath),
      sqlExportMinimumDays: retentionPolicy.archive.minimumDays,
      storageRequirement: retentionPolicy.archive.storageRequirement,
    },
  };
}

export function writeContractReleaseBundle(
  outputPath: string,
  bundle: ContractReleaseBundle
) {
  const resolvedOutput = resolve(outputPath);
  writeFileSync(resolvedOutput, `${JSON.stringify(bundle, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(resolvedOutput, 0o600);
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const preflightPath = argument("--preflight");
  const migrationManifestPath = argument("--migration-manifest");
  const readinessPath = argument("--readiness");
  const bookmarkPath = argument("--bookmark");
  const sqlExportPath = argument("--sql-export");
  const postflightPath = argument("--postflight");
  const postBookmarkPath = argument("--post-bookmark");
  const postSqlExportPath = argument("--post-sql-export");
  const gitSha = argument("--git-sha");
  const outputPath = argument("--output");
  const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const cleanupPlanPath =
    argument("--cleanup-plan") ?? resolve(backendRoot, "contract/cleanup-plan.json");
  const retentionPolicyPath =
    argument("--retention-policy") ??
    resolve(backendRoot, "contract/retention-policy.json");

  if (
    !preflightPath ||
    !migrationManifestPath ||
    !readinessPath ||
    !bookmarkPath ||
    !sqlExportPath ||
    !postflightPath ||
    !postBookmarkPath ||
    !postSqlExportPath ||
    !gitSha ||
    !outputPath
  ) {
    console.error(
      "用法: contract:prepare -- --preflight FILE --migration-manifest FILE --readiness FILE --bookmark FILE --sql-export FILE --postflight FILE --post-bookmark FILE --post-sql-export FILE --git-sha SHA --output FILE [--cleanup-plan FILE] [--retention-policy FILE]"
    );
    process.exitCode = 2;
  } else {
    const bundle = createContractReleaseBundle({
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
    });
    writeContractReleaseBundle(outputPath, bundle);
  }
}
