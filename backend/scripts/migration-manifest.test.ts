import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMigrationManifest } from "../tooling/migrations/manifest";
import { verifyMigrationPostflight } from "../tooling/migrations/postflight";

const directory = mkdtempSync(join(tmpdir(), "xugou-manifest-"));
try {
  const preflightPath = join(directory, "preflight.json");
  const exportPath = join(directory, "export.sql");
  const bookmarkPath = join(directory, "bookmark.json");
  writeFileSync(exportPath, "CREATE TABLE fixture(id INTEGER);\n");
  writeFileSync(bookmarkPath, JSON.stringify({ bookmark: "fixture-bookmark" }));
  writeFileSync(
    preflightPath,
    JSON.stringify({
      generatedAt: "2026-08-02T00:00:00.000Z",
      database: exportPath,
      emptyDatabase: false,
      readyForExpand: true,
      readyForCredentialContract: false,
      blockers: [],
      warnings: ["fixture"],
      counts: { agents: 2, agentHistoricalRowsTotal: 1_000_010 },
      conservation: [
        {
          key: "agent-history",
          sourceRows: 1_000_010,
          migratedRows: 1_000_010,
          deduplicatedRows: 0,
          archivedRows: 0,
          anomalyRows: 0,
          difference: 0,
          conserved: true,
        },
      ],
      schema: {
        tables: ["agents"],
        legacyHistoryTables: ["agent_metrics_history_old"],
        latestEmbeddedMigration: "0028.sql",
        quickCheck: "ok",
        integrityCheck: "ok",
      },
    })
  );
  const manifest = createMigrationManifest({
    preflightPath,
    sqlExportPath: exportPath,
    bookmarkPath,
    gitSha: "0123456789abcdef0123456789abcdef01234567",
  });
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.export.bytes, readFileSync(exportPath).byteLength);
  assert.match(manifest.export.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.bookmark, { bookmark: "fixture-bookmark" });
  assert.equal(manifest.preflight.counts.agentHistoricalRowsTotal, 1_000_010);
  assert.equal(manifest.preflight.conservation[0]?.conserved, true);
  assert.throws(
    () => createMigrationManifest({ ...{
      preflightPath,
      sqlExportPath: exportPath,
      bookmarkPath,
    }, gitSha: "not-a-sha" }),
    /Git commit SHA/
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
  const before = JSON.parse(readFileSync(preflightPath, "utf8"));
  before.counts.foreignKeyViolations = 0;
  before.conservation = conservationKeys.map((key) => ({
    key,
    sourceRows: 1,
    migratedRows: 1,
    deduplicatedRows: 0,
    archivedRows: 0,
    anomalyRows: 0,
    difference: 0,
    conserved: true,
  }));
  writeFileSync(preflightPath, JSON.stringify(before));
  const after = structuredClone(before);
  after.generatedAt = "2026-08-02T00:01:00.000Z";
  const postflight = verifyMigrationPostflight(before, after);
  assert.equal(postflight.ready, true);

  const postflightPath = join(directory, "postflight.json");
  const postExportPath = join(directory, "post.sql");
  const postBookmarkPath = join(directory, "post-bookmark.json");
  writeFileSync(postflightPath, JSON.stringify(postflight));
  writeFileSync(postExportPath, "CREATE TABLE fixture(id INTEGER);\n-- post\n");
  writeFileSync(postBookmarkPath, JSON.stringify({ bookmark: "fixture-post-bookmark" }));
  const completeManifest = createMigrationManifest({
    preflightPath,
    sqlExportPath: exportPath,
    bookmarkPath,
    gitSha: "0123456789abcdef0123456789abcdef01234567",
    postflightPath,
    postSqlExportPath: postExportPath,
    postBookmarkPath,
  });
  assert.equal(completeManifest.postflight?.ready, true);
  assert.match(completeManifest.postExport?.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(completeManifest.postBookmark, {
    bookmark: "fixture-post-bookmark",
  });
  assert.throws(
    () =>
      createMigrationManifest({
        preflightPath,
        sqlExportPath: exportPath,
        bookmarkPath,
        gitSha: "0123456789abcdef0123456789abcdef01234567",
        postflightPath,
      }),
    /requires report, SQL Export and Bookmark together/
  );

  const regressed = structuredClone(after);
  regressed.counts.agents = 1;
  assert.equal(verifyMigrationPostflight(before, regressed).ready, false);
  const unconserved = structuredClone(after);
  unconserved.conservation[0] = {
    ...unconserved.conservation[0],
    migratedRows: 0,
    difference: 1,
    conserved: false,
  };
  assert.equal(verifyMigrationPostflight(before, unconserved).ready, false);
  const expandBefore = structuredClone(before);
  expandBefore.conservation[0] = {
    ...expandBefore.conservation[0],
    migratedRows: -1,
    anomalyRows: -1,
    difference: null,
    conserved: false,
  };
  const expandPostflight = verifyMigrationPostflight(
    expandBefore,
    unconserved,
    "expand"
  );
  assert.equal(expandPostflight.ready, true);
  assert.equal(expandPostflight.mode, "expand");
  const sourceRowsLost = structuredClone(unconserved);
  sourceRowsLost.conservation[0].sourceRows = 0;
  assert.equal(
    verifyMigrationPostflight(expandBefore, sourceRowsLost, "expand").ready,
    false,
    "Expand postflight must reject legacy source-row loss"
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
