import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderProductionWranglerConfig } from "../tooling/wrangler/render-production-config";

const directory = mkdtempSync(join(tmpdir(), "xugou-wrangler-config-"));
const templatePath = join(directory, "wrangler.toml");
const outputPath = join(directory, "wrangler.production.toml");
writeFileSync(
  templatePath,
  'database_name = "${D1_DATABASE_NAME}"\ndatabase_id = "${D1_DATABASE_ID}"\n'
);

renderProductionWranglerConfig({
  templatePath,
  outputPath,
  databaseName: "xugou_db",
  databaseId: "11111111-2222-4333-8444-555555555555",
});
assert.equal(
  readFileSync(outputPath, "utf8"),
  'database_name = "xugou_db"\ndatabase_id = "11111111-2222-4333-8444-555555555555"\n'
);
assert.equal(statSync(outputPath).mode & 0o777, 0o600);

assert.throws(
  () =>
    renderProductionWranglerConfig({
      templatePath,
      outputPath,
      databaseName: "xugou_db\nmalicious = true",
      databaseId: "11111111-2222-4333-8444-555555555555",
    }),
  /D1_DATABASE_NAME/
);
assert.throws(
  () =>
    renderProductionWranglerConfig({
      templatePath,
      outputPath,
      databaseName: "xugou_db",
      databaseId: "not-a-database-id",
    }),
  /D1_DATABASE_ID/
);

writeFileSync(templatePath, 'database_name = "${D1_DATABASE_NAME}"\n');
assert.throws(
  () =>
    renderProductionWranglerConfig({
      templatePath,
      outputPath,
      databaseName: "xugou_db",
      databaseId: "11111111-2222-4333-8444-555555555555",
    }),
  /each D1 placeholder exactly once/
);

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const productionOutputPath = join(directory, "full-wrangler.production.toml");
renderProductionWranglerConfig({
  templatePath: join(repositoryRoot, "wrangler.toml"),
  outputPath: productionOutputPath,
  databaseName: "fixture_db",
  databaseId: "11111111-2222-4333-8444-555555555555",
});
const productionConfig = readFileSync(productionOutputPath, "utf8");
assert.match(productionConfig, /database_name = "fixture_db"/);
assert.doesNotMatch(productionConfig, /\$\{D1_DATABASE_(?:NAME|ID)\}/);
assert.equal(statSync(productionOutputPath).mode & 0o777, 0o600);
