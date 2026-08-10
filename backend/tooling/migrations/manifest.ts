import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { MigrationPreflightReport } from "./preflight";
import type { MigrationPostflightReport } from "./postflight";

export interface MigrationManifest {
  formatVersion: 2;
  generatedAt: string;
  gitSha: string;
  database: string;
  export: {
    path: string;
    bytes: number;
    sha256: string;
  };
  bookmark: unknown;
  preflight: {
    readyForExpand: boolean;
    readyForCredentialContract: boolean;
    blockers: string[];
    warnings: string[];
    counts: Record<string, number>;
    conservation: MigrationPreflightReport["conservation"];
    schema: MigrationPreflightReport["schema"];
  };
  migrationResult: string | null;
  postflight?: MigrationPostflightReport;
  postExport?: { path: string; bytes: number; sha256: string };
  postBookmark?: unknown;
}

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function createMigrationManifest(input: {
  preflightPath: string;
  sqlExportPath: string;
  bookmarkPath: string;
  gitSha: string;
  migrationResultPath?: string;
  postflightPath?: string;
  postSqlExportPath?: string;
  postBookmarkPath?: string;
}): MigrationManifest {
  const preflightPath = resolve(input.preflightPath);
  const exportPath = resolve(input.sqlExportPath);
  const bookmarkPath = resolve(input.bookmarkPath);
  const preflight = readJson(preflightPath) as MigrationPreflightReport;
  if (!preflight.readyForExpand) {
    throw new Error("Migration manifest requires a successful Expand preflight");
  }
  const gitSha = input.gitSha.trim();
  if (!/^[0-9a-f]{7,64}$/i.test(gitSha)) {
    throw new Error("Migration manifest requires a Git commit SHA");
  }
  const postflightInputs = [
    input.postflightPath,
    input.postSqlExportPath,
    input.postBookmarkPath,
  ];
  const providedPostflightInputs = postflightInputs.filter(Boolean).length;
  if (providedPostflightInputs > 0 && providedPostflightInputs !== postflightInputs.length) {
    throw new Error(
      "Migration manifest postflight requires report, SQL Export and Bookmark together"
    );
  }
  const postflight = input.postflightPath
    ? readJson(resolve(input.postflightPath)) as MigrationPostflightReport
    : undefined;
  if (postflight) {
    if (!postflight.ready || postflight.blockers.length > 0) {
      throw new Error("Migration manifest requires a successful postflight");
    }
    if (!isDeepStrictEqual(postflight.preflight, preflight)) {
      throw new Error("Migration postflight before snapshot does not match preflight");
    }
  }
  return {
    formatVersion: 2,
    generatedAt: new Date().toISOString(),
    gitSha,
    database: preflight.database,
    export: {
      path: exportPath,
      bytes: statSync(exportPath).size,
      sha256: sha256File(exportPath),
    },
    bookmark: readJson(bookmarkPath),
    preflight: {
      readyForExpand: preflight.readyForExpand,
      readyForCredentialContract: preflight.readyForCredentialContract,
      blockers: preflight.blockers,
      warnings: preflight.warnings,
      counts: preflight.counts,
      conservation: preflight.conservation,
      schema: preflight.schema,
    },
    migrationResult: input.migrationResultPath
      ? readFileSync(resolve(input.migrationResultPath), "utf8").trim() || null
      : null,
    ...(postflight
      ? { postflight }
      : {}),
    ...(input.postSqlExportPath
      ? {
          postExport: {
            path: resolve(input.postSqlExportPath),
            bytes: statSync(resolve(input.postSqlExportPath)).size,
            sha256: sha256File(resolve(input.postSqlExportPath)),
          },
        }
      : {}),
    ...(input.postBookmarkPath
      ? { postBookmark: readJson(resolve(input.postBookmarkPath)) }
      : {}),
  };
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const preflightPath = argument("--preflight");
  const sqlExportPath = argument("--sql-export");
  const bookmarkPath = argument("--bookmark");
  const gitSha = argument("--git-sha");
  const outputPath = argument("--output");
  const migrationResultPath = argument("--migration-result");
  const postflightPath = argument("--postflight");
  const postSqlExportPath = argument("--post-sql-export");
  const postBookmarkPath = argument("--post-bookmark");
  if (!preflightPath || !sqlExportPath || !bookmarkPath || !gitSha || !outputPath) {
    console.error(
      "用法: migration:manifest -- --preflight FILE --sql-export FILE --bookmark FILE --git-sha SHA --output FILE [--migration-result FILE] [--postflight FILE --post-sql-export FILE --post-bookmark FILE]"
    );
    process.exitCode = 2;
  } else {
    const manifest = createMigrationManifest({
      preflightPath,
      sqlExportPath,
      bookmarkPath,
      gitSha,
      migrationResultPath,
      postflightPath,
      postSqlExportPath,
      postBookmarkPath,
    });
    writeFileSync(resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
