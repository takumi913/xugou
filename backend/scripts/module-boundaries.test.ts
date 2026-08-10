import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../src");
const modulesRoot = join(srcRoot, "modules");
const jobsRoot = join(srcRoot, "jobs");

function listTypescriptFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? listTypescriptFiles(path)
      : /\.tsx?$/.test(name)
        ? [path]
        : [];
  });
}

for (const file of listTypescriptFiles(modulesRoot)) {
  const source = readFileSync(file, "utf8");
  const path = relative(srcRoot, file);
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*\/(?:services|repositories)(?:\/|["'])/,
    `${path} must use module ports/adapters instead of legacy services or repositories`
  );
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*\/api(?:\/|["'])/,
    `${path} must not depend on the legacy API adapter layer`
  );
  if (path.includes("/domain/")) {
    assert.doesNotMatch(
      source,
      /from\s+["'](?:hono|drizzle-orm|\.\.\/\.\.\/)/,
      `${path} domain layer must stay framework-independent`
    );
  }
  if (path.includes("/application/")) {
    assert.doesNotMatch(
      source,
      /from\s+["'](?:hono|drizzle-orm|.*\/(?:api|config|db|repositories)(?:\/|["']))/,
      `${path} application layer must depend on ports and domain only`
    );
  }
}

for (const file of listTypescriptFiles(jobsRoot)) {
  const source = readFileSync(file, "utf8");
  const path = relative(srcRoot, file);
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*\/(?:services|repositories|config)(?:\/|["'])/,
    `${path} must use request-level D1/module adapters instead of legacy globals`
  );
}
