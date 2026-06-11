import { Hono } from "hono";
import { Bindings } from "../models/db";
import { Monitor } from "../models/monitor";
import { getMonitorsToCheck, checkMonitor } from "../services";
import { shouldSendNotification, sendNotification } from "../services";
import { db } from "../config";
import {
  monitorDailyStats,
  monitorCheckRollups,
  monitorStatusHistory24h,
} from "../db/schema";
import { and, gte, lte, sql } from "drizzle-orm";
import { getEnvNumber } from "../utils/env";

const monitorTask = new Hono<{ Bindings: Bindings }>();
const DEFAULT_MONITOR_CHECK_BATCH_SIZE = 10;
const DEFAULT_MONITOR_CHECK_CONCURRENCY = 3;
const DEFAULT_MIN_MONITOR_INTERVAL_SECONDS = 300;
const DEFAULT_STATUS_SNAPSHOT_DIRTY_COALESCE_SECONDS = 30;

type DailyStatsAggregation = {
  monitor_id: number;
  total_checks: number;
  up_checks: number;
  down_checks: number;
  avg_response_time: number;
  min_response_time: number;
  max_response_time: number;
};

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
) {
  const results: R[] = [];

  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    const batchResults = await Promise.all(batch.map(worker));
    results.push(...batchResults);
  }

  return results;
}

// 监控检查的主要函数
async function checkMonitors(c: any) {
  try {
    const batchSize = getEnvNumber(
      c?.env,
      "MONITOR_CHECK_BATCH_SIZE",
      DEFAULT_MONITOR_CHECK_BATCH_SIZE,
      { min: 1, max: 50 }
    );
    const concurrency = getEnvNumber(
      c?.env,
      "MONITOR_CHECK_CONCURRENCY",
      DEFAULT_MONITOR_CHECK_CONCURRENCY,
      { min: 1, max: batchSize }
    );
    const minIntervalSeconds = getEnvNumber(
      c?.env,
      "MIN_MONITOR_INTERVAL_SECONDS",
      DEFAULT_MIN_MONITOR_INTERVAL_SECONDS,
      { min: 1, max: 86400 }
    );
    const statusSnapshotDirtyCoalesceSeconds = getEnvNumber(
      c?.env,
      "STATUS_SNAPSHOT_DIRTY_COALESCE_SECONDS",
      DEFAULT_STATUS_SNAPSHOT_DIRTY_COALESCE_SECONDS,
      { min: 0, max: 3600 }
    );
    // 查询需要检查的监控
    const monitors = await getMonitorsToCheck(batchSize);

    if (!monitors || monitors.length === 0) {
      return { success: true, message: "没有需要检查的监控", checked: 0 };
    }

    // 检查每个监控
    const results = await runWithConcurrency(
      monitors,
      concurrency,
      async (monitor: Monitor) => {
        const checkResult = await checkMonitor(monitor, {
          minIntervalSeconds,
          statusSnapshotDirtyCoalesceSeconds,
        });
        // 处理通知
        await handleMonitorNotification(c, monitor, checkResult);
        return checkResult;
      }
    );

    return {
      success: true,
      message: "监控检查完成",
      checked: results.length,
      results: results,
    };
  } catch (error) {
    console.error("监控检查出错:", error);
    return { success: false, message: "监控检查出错", error: String(error) };
  }
}

// 处理监控通知
async function handleMonitorNotification(
  c: any,
  monitor: Monitor,
  checkResult: any
) {
  try {
    // 如果监控状态没有变化，不需要继续处理，使用 monitor.status (数据库里的最新状态) 与刚才检查到的状态 (checkResult.status)
    if (monitor.status === checkResult.status) {
      return;
    }

    // 定义当前状态和前一个状态
    const currentStatus = checkResult.status;
    const previousStatus = monitor.status || "unknown"; // 使用 monitor.status 作为前一个状态

    // 检查是否需要发送通知
    const notificationCheck = await shouldSendNotification(
      monitor.created_by, // 修复: 传入 userId
      "monitor",
      monitor.id,
      previousStatus,
      currentStatus
    );

    if (
      !notificationCheck.shouldSend ||
      notificationCheck.channels.length === 0
    ) {
      return;
    }

    // 信息添加红绿灯
    let errorMsg = checkResult.error || "无";
    if (currentStatus === "up") {
        errorMsg = "服务已恢复访问 🟢";
    } 
    else if (currentStatus === "down") {
        errorMsg = `${checkResult.error || "服务无法访问"} 🔴`;
    }

    // 准备通知变量
    const variables = {
      name: monitor.name,
      status: currentStatus,
      previous_status: previousStatus,
      time: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      url: monitor.url,
      response_time: `${checkResult.responseTime}ms`,
      status_code: checkResult.statusCode
        ? checkResult.statusCode.toString()
        : "无",
      expected_status: monitor.expected_status.toString(),
      error: errorMsg,
      details: `URL: ${monitor.url}\n响应时间: ${
        checkResult.responseTime
      }ms\n状态码: ${checkResult.statusCode || "无"}\n错误信息: ${
        checkResult.error || "无"
      }`,
    };

    // 发送通知
    const notificationResult = await sendNotification(
      "monitor",
      monitor.id,
      variables,
      notificationCheck.channels,
      monitor.created_by, // 修复: 传入 userId
      notificationCheck.cooldownMinutes
    );

    if (!notificationResult.success) {
      console.error(`监控 ${monitor.name} (ID: ${monitor.id}) 通知发送失败`);
    }
  } catch (error) {
    console.error(
      `处理监控通知时出错 (${monitor.name}, ID: ${monitor.id}):`,
      error
    );
  }
}

// 从 rollup 表生成每日监控统计数据的函数
async function generateDailyStats(c: any) {
  try {
    // 获取前一天的日期 (YYYY-MM-DD 格式)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1); // 修正：获取前一天的日期
    const dateStr = yesterday.toISOString().split("T")[0];

    // 时间范围
    const startTime = `${dateStr}T00:00:00.000Z`;
    const endTime = `${dateStr}T23:59:59.999Z`;

    const statsRows = (await db
      .select({
        monitor_id: monitorCheckRollups.monitor_id,
        total_checks: sql<number>`sum(${monitorCheckRollups.total_checks})`,
        up_checks: sql<number>`sum(${monitorCheckRollups.up_checks})`,
        down_checks: sql<number>`sum(${monitorCheckRollups.down_checks})`,
        avg_response_time: sql<number>`coalesce(sum(${monitorCheckRollups.response_time_avg} * ${monitorCheckRollups.total_checks}) / nullif(sum(${monitorCheckRollups.total_checks}), 0), 0)`,
        min_response_time: sql<number>`coalesce(min(case when ${monitorCheckRollups.response_time_avg} > 0 then ${monitorCheckRollups.response_time_avg} end), 0)`,
        max_response_time: sql<number>`coalesce(max(${monitorCheckRollups.response_time_max}), 0)`,
      })
      .from(monitorCheckRollups)
      .where(
        and(
          gte(monitorCheckRollups.bucket_start, startTime),
          lte(monitorCheckRollups.bucket_start, endTime)
        )
      )
      .groupBy(monitorCheckRollups.monitor_id)) as DailyStatsAggregation[];

    if (!statsRows || statsRows.length === 0) {
      return { success: true, message: "没有历史记录", processed: 0 };
    }

    // 将统计数据写入数据库
    const now = new Date().toISOString();
    const insertStatements = statsRows.map((stats) => {
      const totalChecks = Number(stats.total_checks) || 0;
      const upChecks = Number(stats.up_checks) || 0;
      const downChecks = Number(stats.down_checks) || 0;
      const availability =
        totalChecks > 0 ? (upChecks / totalChecks) * 100 : 0;

      return db.insert(monitorDailyStats).values({
        monitor_id: stats.monitor_id,
        date: dateStr,
        total_checks: totalChecks,
        up_checks: upChecks,
        down_checks: downChecks,
        avg_response_time: Math.round(Number(stats.avg_response_time) || 0),
        min_response_time: Math.round(Number(stats.min_response_time) || 0),
        max_response_time: Math.round(Number(stats.max_response_time) || 0),
        availability,
        created_at: now,
      }).onConflictDoUpdate({
        target: [monitorDailyStats.monitor_id, monitorDailyStats.date],
        set: {
          total_checks: totalChecks,
          up_checks: upChecks,
          down_checks: downChecks,
          avg_response_time: Math.round(Number(stats.avg_response_time) || 0),
          min_response_time: Math.round(Number(stats.min_response_time) || 0),
          max_response_time: Math.round(Number(stats.max_response_time) || 0),
          availability,
          created_at: now,
        },
      });
    });

    const batchSize = 50;
    for (let index = 0; index < insertStatements.length; index += batchSize) {
      await db.batch(insertStatements.slice(index, index + batchSize));
    }

    // 从 24h 表中删除已处理的数据
    await db
      .delete(monitorStatusHistory24h)
      .where(
        and(
          gte(monitorStatusHistory24h.timestamp, startTime),
          lte(monitorStatusHistory24h.timestamp, endTime)
        )
      );

    return {
      success: true,
      message: "每日统计数据生成完成",
      processed: insertStatements.length,
      date: dateStr,
    };
  } catch (error) {
    console.error("生成每日统计数据时出错:", error);
    return {
      success: false,
      message: "生成每日统计数据时出错",
      error: String(error),
    };
  }
}
// 在 Cloudflare Workers 中设置定时触发器
export default {
  async scheduled(event: any, env: any, ctx: any) {
    const c = { env };

    // 默认执行监控检查任务
    let result: any = await checkMonitors(c);

    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();

    if (hour == 0 && minute == 5) {
      // 生成每日监控统计数据
      const statsResult = await generateDailyStats(c);
      if (statsResult.error) {
        console.error("生成每日监控统计数据时出错:", statsResult.error);
      }
    }

    return result;
  },
  fetch: monitorTask.fetch,
};
