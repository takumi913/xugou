/**
 * 历史指标周表轮换任务（参照 CF-Server-Monitor weeklyCleanup）
 *
 * 每周日 UTC 00:00：
 *   1. DROP 更旧的 agent_metrics_history_old（丢弃上上周数据）
 *   2. 当前 agent_metrics_history RENAME → agent_metrics_history_old
 *   3. 重建空的 agent_metrics_history 主表
 *
 * DROP TABLE 的 D1 计费远低于按行 DELETE。轮换窗口（周日 0:00-0:05 UTC）
 * 内跳过离线检测，防止轮换期间误报。
 */
import { db } from "../config";
import { getTableColumns, sql } from "drizzle-orm";
import { agentMetricsHistory } from "../db/schema";
import { tableExists } from "../db/introspect";
import { clearAgentCaches } from "../utils/memCache";

/**
 * 运行时从 drizzle schema（db/schema.ts 的 agentMetricsHistory）生成建表 DDL，
 * 保证轮换重建的表与迁移建出的表列集合永不漂移（无任何二级索引）。
 */
export function buildAgentMetricsHistoryDDL(): string {
  const columns = Object.values(getTableColumns(agentMetricsHistory)).map(
    (column) => {
      let definition = `${column.name} ${column.getSQLType()}`;
      if (column.primary) definition += " PRIMARY KEY";
      if (column.notNull) definition += " NOT NULL";
      return `  ${definition}`;
    }
  );
  return `CREATE TABLE IF NOT EXISTS agent_metrics_history (\n${columns.join(
    ",\n"
  )}\n)`;
}

const ROTATION_SKIP_WINDOW_MINUTES = 5;

// 是否处于轮换保护窗口（周日 UTC 0:00-0:05），窗口内跳过离线检测防误报
export function isRotationWindow(now: Date = new Date()): boolean {
  return (
    now.getUTCDay() === 0 &&
    now.getUTCHours() === 0 &&
    now.getUTCMinutes() < ROTATION_SKIP_WINDOW_MINUTES
  );
}

// 是否到达轮换触发时刻（周日 UTC 00:00 的那一分钟）
export function shouldRunWeeklyRotation(now: Date = new Date()): boolean {
  return (
    now.getUTCDay() === 0 && now.getUTCHours() === 0 && now.getUTCMinutes() === 0
  );
}

// 轮换完成后断言重建表的列集合与 schema.ts 一致，不一致时大声报警（不阻断轮换结果）
async function assertHistoryTableMatchesSchema(): Promise<void> {
  try {
    const pragmaRows = (await db.all(
      sql.raw(`PRAGMA table_info(agent_metrics_history)`)
    )) as Array<{ name: string }>;
    const actual = new Set(pragmaRows.map((row) => row.name));
    const expected = Object.values(getTableColumns(agentMetricsHistory)).map(
      (column) => column.name
    );
    const missing = expected.filter((name) => !actual.has(name));
    const extra = [...actual].filter((name) => !expected.includes(name));
    if (missing.length > 0 || extra.length > 0) {
      console.error(
        `[Rotation] 严重: agent_metrics_history 列集合与 db/schema.ts 不一致! ` +
          `缺少=[${missing.join(",")}] 多余=[${extra.join(",")}]`
      );
    }
  } catch (error) {
    console.error("[Rotation] agent_metrics_history 列集合断言执行失败:", error);
  }
}

export async function weeklyRotation(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    // 1. 删除更旧的轮换表
    await db.run(sql.raw(`DROP TABLE IF EXISTS agent_metrics_history_old`));

    // 2. 当前主表存在则重命名为 _old
    if (await tableExists("agent_metrics_history")) {
      await db.run(
        sql.raw(
          `ALTER TABLE agent_metrics_history RENAME TO agent_metrics_history_old`
        )
      );
    }

    // 3. 重建空主表（DDL 运行时由 drizzle schema 生成）
    await db.run(sql.raw(buildAgentMetricsHistoryDDL()));

    await assertHistoryTableMatchesSchema();

    // 轮换后清空 isolate 内相关缓存，避免读到已轮换的数据
    clearAgentCaches();

    console.log("[Rotation] agent_metrics_history 周表轮换完成");
    return { success: true };
  } catch (error) {
    console.error("[Rotation] agent_metrics_history 周表轮换失败:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
