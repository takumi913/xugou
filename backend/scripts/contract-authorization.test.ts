import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createContractExecutionAuthorization,
  writeContractExecutionAuthorization,
} from "../tooling/contract/authorize-release";

const directory = mkdtempSync(join(tmpdir(), "xugou-contract-authorization-"));
const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

try {
  const bundlePath = join(directory, "contract-release.json");
  const sqlPath = join(directory, "contract.sql");
  const signoffPath = join(directory, "production-signoff.json");
  const signaturePath = join(directory, "production-signoff.sig");
  const publicKeyPath = join(directory, "approval-public-key.pem");
  const authorizationPath = join(directory, "contract-authorization.json");
  const sql = "DROP TABLE fixture;\n";
  writeFileSync(sqlPath, sql);
  const evidenceDigest = sha256("evidence");
  const bundle = {
    formatVersion: 2,
    status: "ready",
    gitSha: "0123456789abcdef0123456789abcdef01234567",
    releaseVersion: "worker-version-fixture",
    evidence: {
      migrationManifestSha256: sha256("manifest"),
      bookmarkSha256: sha256("pre-bookmark"),
      postBookmarkSha256: sha256("post-bookmark"),
    },
  };
  const bundleText = `${JSON.stringify(bundle, null, 2)}\n`;
  writeFileSync(bundlePath, bundleText);

  const evidence = [
    {
      key: "d1-backfill",
      environment: "production",
      details: { conservationDifference: 0, openAnomalies: 0 },
    },
    {
      key: "r2-raw-sample",
      environment: "production",
      details: {
        sampledObjects: 3,
        headVerified: true,
        restoreReadVerified: true,
        privateAccessVerified: true,
      },
    },
    {
      key: "d1-bookmark-restore",
      environment: "isolated-restore",
      details: { bookmarkRestored: true, fullGatePassed: true },
    },
    {
      key: "legacy-quiet-window",
      environment: "production",
      details: {
        managementV1Days: 7,
        agentV1Days: 60,
        latestPathDays: 60,
        compatibilityHits: 0,
      },
    },
    {
      key: "queue-freeze-reconciliation",
      environment: "production",
      details: {
        pendingJobs: 0,
        retryJobs: 0,
        processingJobs: 0,
        dlq: 0,
        unprocessedInbox: 0,
        pendingOutbox: 0,
        openFailures: 0,
      },
    },
    {
      key: "final-package-drill",
      environment: "production",
      details: { restoreDrillPassed: true, contractDryRunPassed: true },
    },
  ].map((item, index) => ({
    ...item,
    startedAt: `2026-08-10T00:0${index}:00.000Z`,
    endedAt: `2026-08-10T00:0${index}:30.000Z`,
    operator: "release-operator",
    inputs: [{ name: `${item.key}-input`, sha256: evidenceDigest }],
    outputs: [{ name: `${item.key}-output`, sha256: evidenceDigest }],
    result: "passed",
    difference: 0,
    evidenceLocation: `encrypted://evidence/${item.key}`,
  }));
  const signoff = {
    formatVersion: 1,
    environment: "production",
    generatedAt: "2026-08-10T00:07:00.000Z",
    gitSha: bundle.gitSha,
    workerVersionId: bundle.releaseVersion,
    artifacts: {
      migrationManifestSha256: bundle.evidence.migrationManifestSha256,
      contractBundleSha256: sha256(bundleText),
      contractSqlSha256: sha256(sql),
      preBookmarkSha256: bundle.evidence.bookmarkSha256,
      postBookmarkSha256: bundle.evidence.postBookmarkSha256,
    },
    evidence,
    assertions: {
      postflightReady: true,
      conservationZero: true,
      r2Verified: true,
      restoreGatePassed: true,
      quietWindowsSatisfied: true,
      queuesDrained: true,
      encryptedRetentionConfirmed: true,
    },
    approvals: [
      {
        role: "executor",
        name: "operator-a",
        approvedAt: "2026-08-10T00:06:00.000Z",
        decision: "approved",
        record: "approval://executor/fixture",
      },
      {
        role: "independent-reviewer",
        name: "reviewer-b",
        approvedAt: "2026-08-10T00:06:30.000Z",
        decision: "approved",
        record: "approval://reviewer/fixture",
      },
    ],
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    publicKeyPath,
    publicKey.export({ type: "spki", format: "pem" })
  );
  const writeSignedSignoff = (value: unknown) => {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(signoffPath, text);
    writeFileSync(
      signaturePath,
      Buffer.from(sign(null, Buffer.from(text), privateKey)).toString("base64")
    );
  };
  writeSignedSignoff(signoff);

  const authorization = createContractExecutionAuthorization({
    bundlePath,
    contractSqlPath: sqlPath,
    signoffPath,
    signaturePath,
    publicKeyPath,
    generatedAt: new Date("2026-08-10T00:08:00.000Z"),
  });
  assert.equal(authorization.status, "authorized");
  assert.equal(authorization.evidenceKeys.length, 6);
  assert.equal(authorization.contractSqlSha256, sha256(sql));
  writeContractExecutionAuthorization(authorizationPath, authorization);
  assert.equal(statSync(authorizationPath).mode & 0o777, 0o600);

  writeFileSync(signoffPath, `${readFileSync(signoffPath, "utf8")} `);
  assert.throws(
    () =>
      createContractExecutionAuthorization({
        bundlePath,
        contractSqlPath: sqlPath,
        signoffPath,
        signaturePath,
        publicKeyPath,
      }),
    /signature verification failed/
  );

  const duplicateReviewer = structuredClone(signoff);
  duplicateReviewer.approvals[1]!.name = duplicateReviewer.approvals[0]!.name;
  writeSignedSignoff(duplicateReviewer);
  assert.throws(
    () =>
      createContractExecutionAuthorization({
        bundlePath,
        contractSqlPath: sqlPath,
        signoffPath,
        signaturePath,
        publicKeyPath,
      }),
    /distinct executor and reviewer/
  );

  const queueBacklog = structuredClone(signoff);
  queueBacklog.evidence[4]!.details.pendingJobs = 1;
  writeSignedSignoff(queueBacklog);
  assert.throws(
    () =>
      createContractExecutionAuthorization({
        bundlePath,
        contractSqlPath: sqlPath,
        signoffPath,
        signaturePath,
        publicKeyPath,
      }),
    /pendingJobs=0/
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
