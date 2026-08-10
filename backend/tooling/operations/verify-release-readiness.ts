import { readFileSync } from "node:fs";

type Mode =
  | "release"
  | "contract-worker"
  | "credential-contract"
  | "management-v1-sunset"
  | "agent-v1-sunset"
  | "all";

type ReadinessCheck = {
  key: string;
  ready: boolean;
  actual: number | null;
  threshold: number;
  direction: string;
};

type Readiness = {
  generated_at: string;
  release_version: string;
  release_ready: boolean;
  contract_worker_ready: boolean;
  credential_contract_ready: boolean;
  management_v1_sunset_ready: boolean;
  agent_v1_sunset_ready: boolean;
  checks: ReadinessCheck[];
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseMode(value: string | undefined): Mode {
  const mode = value ?? "release";
  switch (mode) {
    case "release":
    case "contract-worker":
    case "credential-contract":
    case "management-v1-sunset":
    case "agent-v1-sunset":
    case "all":
      return mode;
    default:
      throw new Error(`未知门禁模式：${mode}`);
  }
}

function readInput() {
  const file = argument("--file");
  return file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
}

function readinessFrom(value: unknown): Readiness {
  if (!value || typeof value !== "object") throw new Error("Readiness JSON 必须是对象");
  const envelope = record(value);
  const data =
    envelope.data && typeof envelope.data === "object"
      ? record(envelope.data)
      : envelope;
  const requiredBooleans = [
    "release_ready",
    "contract_worker_ready",
    "credential_contract_ready",
    "management_v1_sunset_ready",
    "agent_v1_sunset_ready",
  ];
  for (const key of requiredBooleans) {
    if (typeof data[key] !== "boolean") throw new Error(`缺少布尔字段 ${key}`);
  }
  if (!Array.isArray(data.checks)) throw new Error("缺少 checks 数组");
  const stringField = (key: string) => {
    if (typeof data[key] !== "string" || data[key].length === 0) {
      throw new Error(`缺少字符串字段 ${key}`);
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
      throw new Error(`checks[${index}] 格式无效`);
    }
    return {
      key: row.key,
      ready: row.ready,
      actual: row.actual,
      threshold: row.threshold,
      direction: row.direction,
    };
  });
  return {
    generated_at: stringField("generated_at"),
    release_version: stringField("release_version"),
    release_ready: data.release_ready as boolean,
    contract_worker_ready: data.contract_worker_ready as boolean,
    credential_contract_ready: data.credential_contract_ready as boolean,
    management_v1_sunset_ready: data.management_v1_sunset_ready as boolean,
    agent_v1_sunset_ready: data.agent_v1_sunset_ready as boolean,
    checks,
  };
}

function modeReady(readiness: Readiness, mode: Mode) {
  if (mode === "release") return readiness.release_ready;
  if (mode === "contract-worker") return readiness.contract_worker_ready;
  if (mode === "credential-contract") return readiness.credential_contract_ready;
  if (mode === "management-v1-sunset") {
    return readiness.management_v1_sunset_ready;
  }
  if (mode === "agent-v1-sunset") return readiness.agent_v1_sunset_ready;
  return (
    readiness.release_ready &&
    readiness.contract_worker_ready &&
    readiness.credential_contract_ready &&
    readiness.management_v1_sunset_ready &&
    readiness.agent_v1_sunset_ready
  );
}

const mode = parseMode(argument("--mode"));
const readiness = readinessFrom(JSON.parse(readInput()) as unknown);
const failedChecks = readiness.checks.filter((item) => !item.ready);
const result = {
  verified_at: new Date().toISOString(),
  mode,
  generated_at: readiness.generated_at,
  release_version: readiness.release_version,
  ready: modeReady(readiness, mode),
  failed_checks: failedChecks,
  gates: {
    release_ready: readiness.release_ready,
    contract_worker_ready: readiness.contract_worker_ready,
    credential_contract_ready: readiness.credential_contract_ready,
    management_v1_sunset_ready: readiness.management_v1_sunset_ready,
    agent_v1_sunset_ready: readiness.agent_v1_sunset_ready,
  },
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ready) process.exitCode = 1;
