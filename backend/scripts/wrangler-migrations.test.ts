import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const persistTo = mkdtempSync(join(tmpdir(), "xugou-wrangler-migrations-"));
const environment = { ...process.env, CI: "1", NO_COLOR: "1" };

try {
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
    { cwd: repositoryRoot, env: environment, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
  );
  const secondRun = execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "list",
      "DB",
      "--local",
      "--persist-to",
      persistTo,
    ],
    { cwd: repositoryRoot, env: environment, encoding: "utf8" }
  );
  assert.match(secondRun, /No migrations to apply/);
} finally {
  rmSync(persistTo, { recursive: true, force: true });
}
