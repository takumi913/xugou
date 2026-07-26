import { MIGRATIONS } from "./generated-migrations";
import { Bindings } from "../models";


const tableExists = async (d1: Bindings["DB"], tableName: string): Promise<boolean | undefined> => {
  const result = await d1.prepare("SELECT * FROM sqlite_master WHERE type='table' AND name=?").bind(tableName).run();
  return result.success && result.results && result.results.length > 0;
}

const getMigrationStatements = (sql: string): string[] => {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
};

// settings 表里记录已应用的最高迁移名，用于 isolate 首请求的轻量短路检查
const APPLIED_MIGRATION_SETTING_KEY = "applied_migration_latest";

// 迁移检查短路：读 settings 中记录的最高迁移名，与打包内最新迁移一致则跳过逐条检查
async function isMigrationUpToDate(d1: Bindings["DB"], latestName: string): Promise<boolean> {
  if (!latestName) return false;
  try {
    const row = await d1
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind(APPLIED_MIGRATION_SETTING_KEY)
      .first<{ value: string | null }>();
    return row?.value === latestName;
  } catch {
    // settings 表尚不存在（全新库）等情况，走完整迁移检查
    return false;
  }
}

// 迁移完成后记录最高迁移名（幂等 upsert；settings 表由迁移创建，失败不影响主流程）
async function recordAppliedMigration(d1: Bindings["DB"], latestName: string): Promise<void> {
  if (!latestName) return;
  try {
    await d1
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .bind(APPLIED_MIGRATION_SETTING_KEY, latestName)
      .run();
  } catch (error) {
    console.error("记录迁移版本失败:", error);
  }
}

// 执行所有迁移脚本
export async function runMigrations(d1: Bindings["DB"]): Promise<void> {
  try {
    const latestName = MIGRATIONS[MIGRATIONS.length - 1]?.name ?? "";

    // 版本一致则短路，只花费一次轻量 SELECT
    if (await isMigrationUpToDate(d1, latestName)) {
      return;
    }

    // 检查迁移记录表是否存在
    const migrationsTableExists = await tableExists(d1, "migrations");
    if (!migrationsTableExists) {
      // 创建迁移记录表
      await d1.prepare("CREATE TABLE migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, timestamp TEXT)").run();
    }
    
    // 执行迁移
    for (const migration of MIGRATIONS) {
      // 检查是否已执行过该迁移
      const migrationResult = await d1.prepare("SELECT * FROM migrations WHERE name = ?").bind(migration.name).run();
      if (migrationResult.results && migrationResult.results.length > 0) {
        continue;
      }
      
      const statements = getMigrationStatements(migration.sql);
      for (const statement of statements) {
        const result = await d1.prepare(statement).run();
        if (!result.success) {
          console.error(`迁移 ${migration.name} 失败`);
          throw new Error(`迁移 ${migration.name} 执行失败`);
        }
      }
      // 写入迁移记录
      await d1.prepare("INSERT INTO migrations (name, timestamp) VALUES (?, ?)").bind(migration.name, new Date().toISOString()).run();
    }

    // 全部迁移执行完成后记录最高迁移名，供后续 isolate 短路
    await recordAppliedMigration(d1, latestName);
  } catch (error) {
    console.error("执行迁移脚本时出错:", error);
    throw error;
  }
}
