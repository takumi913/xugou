import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATABASE_NAME_PLACEHOLDER = "${D1_DATABASE_NAME}";
const DATABASE_ID_PLACEHOLDER = "${D1_DATABASE_ID}";

function occurrenceCount(source: string, value: string) {
  return source.split(value).length - 1;
}

function validateDatabaseName(value: string) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(value)) {
    throw new Error("D1_DATABASE_NAME must be a 1-64 character D1 name");
  }
}

function validateDatabaseId(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    throw new Error("D1_DATABASE_ID must be a UUID");
  }
}

export function renderProductionWranglerConfig(input: {
  templatePath: string;
  outputPath: string;
  databaseName: string;
  databaseId: string;
}) {
  validateDatabaseName(input.databaseName);
  validateDatabaseId(input.databaseId);
  const templatePath = resolve(input.templatePath);
  const outputPath = resolve(input.outputPath);
  const template = readFileSync(templatePath, "utf8");
  if (
    occurrenceCount(template, DATABASE_NAME_PLACEHOLDER) !== 1 ||
    occurrenceCount(template, DATABASE_ID_PLACEHOLDER) !== 1
  ) {
    throw new Error(
      "Wrangler template must contain each D1 placeholder exactly once"
    );
  }
  const rendered = template
    .replace(DATABASE_NAME_PLACEHOLDER, input.databaseName)
    .replace(DATABASE_ID_PLACEHOLDER, input.databaseId);
  writeFileSync(outputPath, rendered, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  return outputPath;
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const templatePath = argument("--template");
  const outputPath = argument("--output");
  const databaseName = process.env.D1_DATABASE_NAME;
  const databaseId = process.env.D1_DATABASE_ID;
  if (!templatePath || !outputPath || !databaseName || !databaseId) {
    console.error(
      "用法: D1_DATABASE_NAME=NAME D1_DATABASE_ID=UUID wrangler:render-config -- --template FILE --output FILE"
    );
    process.exitCode = 2;
  } else {
    renderProductionWranglerConfig({
      templatePath,
      outputPath,
      databaseName,
      databaseId,
    });
  }
}
