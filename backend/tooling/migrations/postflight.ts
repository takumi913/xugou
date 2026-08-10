import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MigrationPreflightReport } from "./preflight";

const requiredConservationKeys = [
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
] as const;

export type MigrationPostflightMode = "expand" | "contract";

export interface MigrationPostflightReport {
  generatedAt: string;
  mode: MigrationPostflightMode;
  ready: boolean;
  blockers: string[];
  coreCountDelta: Record<string, number>;
  conservationDelta: Array<{
    key: string;
    before: number | null;
    after: number | null;
    regressed: boolean;
  }>;
  preflight: MigrationPreflightReport;
  postflight: MigrationPreflightReport;
}

export function verifyMigrationPostflight(
  before: MigrationPreflightReport,
  after: MigrationPreflightReport,
  mode: MigrationPostflightMode = "contract"
): MigrationPostflightReport {
  const blockers = [...after.blockers];
  if (!after.readyForExpand) blockers.push("迁移后 Expand 预检未通过");
  if (after.schema.quickCheck !== "ok" || after.schema.integrityCheck !== "ok") {
    blockers.push("迁移后 SQLite 完整性检查未通过");
  }
  if (after.counts.foreignKeyViolations !== 0) {
    blockers.push(`迁移后存在 ${after.counts.foreignKeyViolations ?? "unknown"} 条外键异常`);
  }
  const coreKeys = [
    "monitors",
    "agents",
    "agentHistoricalRowsTotal",
    "monitorStatusHistoryRows",
    "monitorDailyStatsRows",
    "notificationHistoryRows",
    "notificationChannels",
  ];
  const coreCountDelta: Record<string, number> = {};
  for (const key of coreKeys) {
    const previous = before.counts[key];
    const current = after.counts[key];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    coreCountDelta[key] = current - previous;
    if (current < previous) blockers.push(`${key} 行数减少 ${previous - current}`);
  }
  const beforeConservation = new Map(
    before.conservation.map((check) => [check.key, check])
  );
  const afterConservation = new Map(after.conservation.map((check) => [check.key, check]));
  for (const key of requiredConservationKeys) {
    if (!afterConservation.has(key)) blockers.push(`迁移后缺少 ${key} 守恒证据`);
  }
  const conservationDelta = after.conservation.map((check) => {
    const beforeCheck = beforeConservation.get(check.key);
    const previous = beforeCheck?.difference ?? null;
    const current = check.difference;
    const differenceRegressed =
      previous !== null && current !== null && Math.abs(current) > Math.abs(previous);
    const sourceRowsRegressed =
      beforeCheck !== undefined &&
      beforeCheck.sourceRows >= 0 &&
      check.sourceRows < beforeCheck.sourceRows;
    const regressed = differenceRegressed || sourceRowsRegressed;
    if (differenceRegressed) {
      blockers.push(`${check.key} 守恒差额扩大: ${previous} -> ${current}`);
    }
    if (sourceRowsRegressed) {
      blockers.push(
        `${check.key} 旧源数据行数减少: ${beforeCheck.sourceRows} -> ${check.sourceRows}`
      );
    }
    if (mode === "contract" && (!check.conserved || check.difference !== 0)) {
      blockers.push(`${check.key} 迁移后守恒未归零: ${check.difference ?? "unknown"}`);
    }
    return { key: check.key, before: previous, after: current, regressed };
  });
  return {
    generatedAt: new Date().toISOString(),
    mode,
    ready: blockers.length === 0,
    blockers,
    coreCountDelta,
    conservationDelta,
    preflight: before,
    postflight: after,
  };
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const beforePath = argument("--before");
  const afterPath = argument("--after");
  const outputPath = argument("--output");
  const mode = argument("--mode") ?? "contract";
  if (
    !beforePath ||
    !afterPath ||
    !outputPath ||
    (mode !== "expand" && mode !== "contract")
  ) {
    process.stderr.write(
      "用法: migration:postflight -- --mode expand|contract --before FILE --after FILE --output FILE\n"
    );
    process.exitCode = 2;
  } else {
    const result = verifyMigrationPostflight(
      JSON.parse(
        readFileSync(resolve(beforePath), "utf8")
      ) as MigrationPreflightReport,
      JSON.parse(
        readFileSync(resolve(afterPath), "utf8")
      ) as MigrationPreflightReport,
      mode
    );
    writeFileSync(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`);
    if (!result.ready) process.exitCode = 1;
  }
}
