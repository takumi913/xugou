import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkForNewVersion, compareSemver } from "../src/utils/version";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});

const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as { version: string };
const frontendPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };
const backendPackage = JSON.parse(
  readFileSync(new URL("../../backend/package.json", import.meta.url), "utf8")
) as { version: string };

assert.match(rootPackage.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(frontendPackage.version, rootPackage.version);
assert.equal(backendPackage.version, rootPackage.version);

assert.equal(compareSemver("v1.2.3", "1.2.4"), -1);
assert.equal(compareSemver("1.2.3", "1.2.3-rc1"), 1);
assert.equal(compareSemver("not-a-version", "1.0.0"), null);

const semverCases = JSON.parse(
  readFileSync(new URL("../../contracts/semver-cases.json", import.meta.url), "utf8")
) as Array<{ a: string; b: string; result: number | null }>;
for (const semverCase of semverCases) {
  assert.equal(compareSemver(semverCase.a, semverCase.b), semverCase.result);
}

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ tag_name: "v2.0.0" }), { status: 200 });
  assert.equal(await checkForNewVersion("1.0.0"), "v2.0.0");

  storage.clear();
  globalThis.fetch = async () =>
    new Response("x".repeat(65 * 1024), { status: 200 });
  assert.equal(await checkForNewVersion("1.0.0"), null);
} finally {
  globalThis.fetch = originalFetch;
}
