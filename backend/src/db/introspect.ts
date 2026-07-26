import { db } from "../config";
import { sql } from "drizzle-orm";

/**
 * sqlite_master 表存在性探测（rotation-task 与 repositories/agent 共用）。
 * 查询错误原样向上抛出，由调用方决定降级语义（轮换任务失败即失败，
 * 历史查询侧 catch 后按"表不存在"处理）。
 */
export async function tableExists(tableName: string): Promise<boolean> {
  const rows = (await db.all(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name=${tableName}`
  )) as unknown[];
  return rows.length > 0;
}
