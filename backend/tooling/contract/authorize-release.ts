import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  chmodSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContractReleaseBundle } from "./prepare-release";

const evidenceKeys = [
  "d1-backfill",
  "r2-raw-sample",
  "d1-bookmark-restore",
  "legacy-quiet-window",
  "queue-freeze-reconciliation",
  "final-package-drill",
] as const;

const assertionKeys = [
  "postflightReady",
  "conservationZero",
  "r2Verified",
  "restoreGatePassed",
  "quietWindowsSatisfied",
  "queuesDrained",
  "encryptedRetentionConfirmed",
] as const;

type EvidenceKey = (typeof evidenceKeys)[number];

type ProductionEvidence = {
  key: EvidenceKey;
  startedAt: string;
  endedAt: string;
  operator: string;
  environment: "production" | "isolated-restore";
  inputs: Array<{ name: string; sha256: string }>;
  outputs: Array<{ name: string; sha256: string }>;
  result: "passed";
  difference: number;
  evidenceLocation: string;
  details: Record<string, unknown>;
};

type ProductionSignoff = {
  formatVersion: 1;
  environment: "production";
  generatedAt: string;
  gitSha: string;
  workerVersionId: string;
  artifacts: {
    migrationManifestSha256: string;
    contractBundleSha256: string;
    contractSqlSha256: string;
    preBookmarkSha256: string;
    postBookmarkSha256: string;
  };
  evidence: ProductionEvidence[];
  assertions: Record<(typeof assertionKeys)[number], boolean>;
  approvals: Array<{
    role: "executor" | "independent-reviewer";
    name: string;
    approvedAt: string;
    decision: "approved";
    record: string;
  }>;
};

export interface ContractExecutionAuthorization {
  formatVersion: 1;
  status: "authorized";
  generatedAt: string;
  gitSha: string;
  workerVersionId: string;
  contractBundleSha256: string;
  contractSqlSha256: string;
  productionSignoffSha256: string;
  productionSignoffSignatureSha256: string;
  approvalPublicKeySha256: string;
  evidenceKeys: EvidenceKey[];
  approvals: ProductionSignoff["approvals"];
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Production signoff is missing ${field}`);
  }
  return value.trim();
}

function validSha256(value: unknown, field: string) {
  const normalized = requiredString(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Production signoff has invalid ${field}`);
  }
  return normalized;
}

function timestamp(value: unknown, field: string) {
  const text = requiredString(value, field);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Production signoff has invalid ${field}`);
  }
  return parsed;
}

function detailBoolean(evidence: ProductionEvidence, key: string) {
  if (evidence.details[key] !== true) {
    throw new Error(`${evidence.key} requires details.${key}=true`);
  }
}

function detailZero(evidence: ProductionEvidence, key: string) {
  if (evidence.details[key] !== 0) {
    throw new Error(`${evidence.key} requires details.${key}=0`);
  }
}

function validateEvidence(signoff: ProductionSignoff) {
  if (!Array.isArray(signoff.evidence) || signoff.evidence.length !== evidenceKeys.length) {
    throw new Error("Production signoff must contain exactly six evidence records");
  }
  const byKey = new Map(signoff.evidence.map((item) => [item.key, item]));
  if (byKey.size !== evidenceKeys.length) {
    throw new Error("Production signoff evidence keys must be unique");
  }
  let latestEnd = 0;
  for (const key of evidenceKeys) {
    const evidence = byKey.get(key);
    if (!evidence) throw new Error(`Production signoff is missing evidence ${key}`);
    const startedAt = timestamp(evidence.startedAt, `${key}.startedAt`);
    const endedAt = timestamp(evidence.endedAt, `${key}.endedAt`);
    if (endedAt < startedAt) throw new Error(`${key} ends before it starts`);
    latestEnd = Math.max(latestEnd, endedAt);
    requiredString(evidence.operator, `${key}.operator`);
    requiredString(evidence.evidenceLocation, `${key}.evidenceLocation`);
    if (evidence.result !== "passed" || evidence.difference !== 0) {
      throw new Error(`${key} must pass with zero difference`);
    }
    const expectedEnvironment =
      key === "d1-bookmark-restore" ? "isolated-restore" : "production";
    if (evidence.environment !== expectedEnvironment) {
      throw new Error(`${key} must run in ${expectedEnvironment}`);
    }
    for (const collection of [evidence.inputs, evidence.outputs]) {
      if (!Array.isArray(collection) || collection.length === 0) {
        throw new Error(`${key} requires hashed inputs and outputs`);
      }
      for (const item of collection) {
        requiredString(item.name, `${key}.artifact.name`);
        validSha256(item.sha256, `${key}.${item.name}.sha256`);
      }
    }
  }

  const backfill = byKey.get("d1-backfill")!;
  detailZero(backfill, "conservationDifference");
  detailZero(backfill, "openAnomalies");
  const archive = byKey.get("r2-raw-sample")!;
  if (!Number.isInteger(archive.details.sampledObjects) || Number(archive.details.sampledObjects) < 1) {
    throw new Error("r2-raw-sample requires at least one sampled object");
  }
  for (const key of ["headVerified", "restoreReadVerified", "privateAccessVerified"]) {
    detailBoolean(archive, key);
  }
  const restore = byKey.get("d1-bookmark-restore")!;
  detailBoolean(restore, "bookmarkRestored");
  detailBoolean(restore, "fullGatePassed");
  const quiet = byKey.get("legacy-quiet-window")!;
  if (
    Number(quiet.details.managementV1Days) < 7 ||
    Number(quiet.details.agentV1Days) < 60 ||
    Number(quiet.details.latestPathDays) < 60 ||
    quiet.details.compatibilityHits !== 0
  ) {
    throw new Error("legacy-quiet-window does not satisfy the configured windows");
  }
  const queues = byKey.get("queue-freeze-reconciliation")!;
  for (const key of [
    "pendingJobs",
    "retryJobs",
    "processingJobs",
    "dlq",
    "unprocessedInbox",
    "pendingOutbox",
    "openFailures",
  ]) {
    detailZero(queues, key);
  }
  const drill = byKey.get("final-package-drill")!;
  detailBoolean(drill, "restoreDrillPassed");
  detailBoolean(drill, "contractDryRunPassed");
  return latestEnd;
}

function parseSignature(path: string) {
  const bytes = readFileSync(resolve(path));
  if (bytes.length === 64) return bytes;
  const decoded = Buffer.from(bytes.toString().trim(), "base64");
  if (decoded.length !== 64) {
    throw new Error("Production signoff signature must be Ed25519 raw or Base64");
  }
  return decoded;
}

export function createContractExecutionAuthorization(input: {
  bundlePath: string;
  contractSqlPath: string;
  signoffPath: string;
  signaturePath: string;
  publicKeyPath: string;
  generatedAt?: Date;
}): ContractExecutionAuthorization {
  const bundleBytes = readFileSync(resolve(input.bundlePath));
  const sqlBytes = readFileSync(resolve(input.contractSqlPath));
  const signoffBytes = readFileSync(resolve(input.signoffPath));
  const signatureBytes = parseSignature(input.signaturePath);
  const publicKeyBytes = readFileSync(resolve(input.publicKeyPath));
  const publicKey = createPublicKey(publicKeyBytes);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Production approval key must be Ed25519");
  }
  if (!verifySignature(null, signoffBytes, publicKey, signatureBytes)) {
    throw new Error("Production signoff signature verification failed");
  }

  const bundle = JSON.parse(bundleBytes.toString()) as ContractReleaseBundle;
  const signoff = JSON.parse(signoffBytes.toString()) as ProductionSignoff;
  if (bundle.status !== "ready" || bundle.formatVersion !== 2) {
    throw new Error("Contract bundle is not ready");
  }
  if (signoff.formatVersion !== 1 || signoff.environment !== "production") {
    throw new Error("Production signoff metadata is invalid");
  }
  if (signoff.gitSha !== bundle.gitSha) {
    throw new Error("Production signoff Git SHA does not match the bundle");
  }
  if (signoff.workerVersionId !== bundle.releaseVersion) {
    throw new Error("Production signoff Worker Version does not match readiness");
  }
  const bundleSha256 = sha256(bundleBytes);
  const sqlSha256 = sha256(sqlBytes);
  const expectedArtifacts = {
    migrationManifestSha256: bundle.evidence.migrationManifestSha256,
    contractBundleSha256: bundleSha256,
    contractSqlSha256: sqlSha256,
    preBookmarkSha256: bundle.evidence.bookmarkSha256,
    postBookmarkSha256: bundle.evidence.postBookmarkSha256,
  };
  for (const [key, expected] of Object.entries(expectedArtifacts)) {
    if (validSha256(signoff.artifacts?.[key as keyof typeof expectedArtifacts], key) !== expected) {
      throw new Error(`Production signoff ${key} does not match the sealed artifact`);
    }
  }
  const latestEvidenceEnd = validateEvidence(signoff);
  for (const key of assertionKeys) {
    if (signoff.assertions?.[key] !== true) {
      throw new Error(`Production assertion is not approved: ${key}`);
    }
  }
  if (!Array.isArray(signoff.approvals) || signoff.approvals.length !== 2) {
    throw new Error("Production signoff requires exactly two approvals");
  }
  const approvals = new Map(signoff.approvals.map((approval) => [approval.role, approval]));
  const executor = approvals.get("executor");
  const reviewer = approvals.get("independent-reviewer");
  if (!executor || !reviewer || executor.name.trim() === reviewer.name.trim()) {
    throw new Error("Production signoff requires distinct executor and reviewer");
  }
  for (const approval of [executor, reviewer]) {
    requiredString(approval.name, `${approval.role}.name`);
    requiredString(approval.record, `${approval.role}.record`);
    if (
      approval.decision !== "approved" ||
      timestamp(approval.approvedAt, `${approval.role}.approvedAt`) < latestEvidenceEnd
    ) {
      throw new Error(`${approval.role} approval is invalid or predates evidence`);
    }
  }
  if (timestamp(signoff.generatedAt, "generatedAt") < latestEvidenceEnd) {
    throw new Error("Production signoff was generated before evidence completed");
  }

  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  return {
    formatVersion: 1,
    status: "authorized",
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    gitSha: bundle.gitSha,
    workerVersionId: bundle.releaseVersion,
    contractBundleSha256: bundleSha256,
    contractSqlSha256: sqlSha256,
    productionSignoffSha256: sha256(signoffBytes),
    productionSignoffSignatureSha256: sha256(signatureBytes),
    approvalPublicKeySha256: sha256(publicKeyDer),
    evidenceKeys: [...evidenceKeys],
    approvals: signoff.approvals,
  };
}

export function writeContractExecutionAuthorization(
  outputPath: string,
  authorization: ContractExecutionAuthorization
) {
  const resolved = resolve(outputPath);
  writeFileSync(resolved, `${JSON.stringify(authorization, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(resolved, 0o600);
  if ((statSync(resolved).mode & 0o777) !== 0o600) {
    throw new Error("Contract authorization permissions are not 0600");
  }
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const bundlePath = argument("--bundle");
  const contractSqlPath = argument("--contract-sql");
  const signoffPath = argument("--signoff");
  const signaturePath = argument("--signature");
  const publicKeyPath = argument("--public-key");
  const outputPath = argument("--output");
  if (
    !bundlePath ||
    !contractSqlPath ||
    !signoffPath ||
    !signaturePath ||
    !publicKeyPath ||
    !outputPath
  ) {
    process.stderr.write(
      "用法: contract:authorize -- --bundle FILE --contract-sql FILE --signoff FILE --signature FILE --public-key FILE --output FILE\n"
    );
    process.exitCode = 2;
  } else {
    writeContractExecutionAuthorization(
      outputPath,
      createContractExecutionAuthorization({
        bundlePath,
        contractSqlPath,
        signoffPath,
        signaturePath,
        publicKeyPath,
      })
    );
  }
}
