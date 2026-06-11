// 导出所有定时任务
import monitorTask from "./monitor-task";
import agentTask from "./agent-task";
import { db } from "../config";
import * as schema from "../db/schema";
import { and, lt, sql } from "drizzle-orm";
import { getEnvNumber } from "../utils/env";

const DEFAULT_AGENT_ROLLUP_RETENTION_DAYS = 30;
const DEFAULT_MONITOR_ROLLUP_RETENTION_DAYS = 90;
const DEFAULT_MONITOR_INCIDENT_RETENTION_DAYS = 180;

// 统一的定时任务处理函数
export const runScheduledTasks = async (event: any, env: any, ctx: any) => {
  try {
    // 执行监控检查任务
    await monitorTask.scheduled(event, env, ctx);

    // 执行客户端状态检查任务
    await agentTask.scheduled(event, env, ctx);

    // 执行清理任务 - 每天执行一次
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    if (hour === 0 && minute === 30) {
      await cleanupOldRecords(env);
    }
  } catch (error) {
    console.error("定时任务执行出错:", error);
  }
};

// 清理30天以前的历史记录
function getCutoffIso(days: number) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff.toISOString();
}

export async function cleanupOldRecords(env?: Record<string, unknown>) {
  // 清理30天以前的 monitor_daily_stats
  const now = new Date();
  now.setDate(now.getDate() - 30);
  const dateStr = now.toISOString().split("T")[0];
  await db.delete(schema.monitorDailyStats).where(
    lt(schema.monitorDailyStats.date, dateStr)
  );

  // 清理通知历史记录
  await db.delete(schema.notificationHistory).where(
    lt(schema.notificationHistory.sent_at, dateStr)
  );

  const agentRollupCutoff = getCutoffIso(
    getEnvNumber(
      env,
      "AGENT_ROLLUP_RETENTION_DAYS",
      DEFAULT_AGENT_ROLLUP_RETENTION_DAYS,
      { min: 1, max: 3650 }
    )
  );
  const monitorRollupCutoff = getCutoffIso(
    getEnvNumber(
      env,
      "MONITOR_ROLLUP_RETENTION_DAYS",
      DEFAULT_MONITOR_ROLLUP_RETENTION_DAYS,
      { min: 1, max: 3650 }
    )
  );
  const monitorIncidentCutoff = getCutoffIso(
    getEnvNumber(
      env,
      "MONITOR_INCIDENT_RETENTION_DAYS",
      DEFAULT_MONITOR_INCIDENT_RETENTION_DAYS,
      { min: 1, max: 3650 }
    )
  );

  await db.delete(schema.agentMetricRollups).where(
    lt(schema.agentMetricRollups.bucket_start, agentRollupCutoff)
  );
  await db.delete(schema.monitorCheckRollups).where(
    lt(schema.monitorCheckRollups.bucket_start, monitorRollupCutoff)
  );
  await db.delete(schema.monitorIncidents).where(
    and(
      lt(schema.monitorIncidents.started_at, monitorIncidentCutoff),
      sql`${schema.monitorIncidents.ended_at} is not null`
    )
  );

  return {
    success: true,
  };
}
