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

// 执行所有迁移脚本
export async function runMigrations(d1: Bindings["DB"]): Promise<void> {
  try {
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
  } catch (error) {
    console.error("执行迁移脚本时出错:", error);
    throw error;
  }
}
