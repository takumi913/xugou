import { Monitor } from "../models";

import { db } from "../config";
import {
  monitors,
  monitorStatusHistory24h,
  monitorDailyStats,
  monitorCheckRollups,
  monitorIncidents,
} from "../db/schema";
import { eq, desc, asc, and, inArray, gte, isNull, lte, or, sql } from "drizzle-orm";

/**
 * 监控相关的数据库操作
 */

function getTwentyFourHoursAgo() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function getNextCheckAt(intervalSeconds: number, from = new Date()) {
  return new Date(
    from.getTime() + Math.max(intervalSeconds || 60, 1) * 1000
  ).toISOString();
}

const SINGLE_HISTORY_LIMIT = 1440;
const ALL_HISTORY_LIMIT = 10000;
const ROLLUP_BUCKET_SIZE_SECONDS = 300;

function getBucketStart(date = new Date(), bucketSizeSeconds = ROLLUP_BUCKET_SIZE_SECONDS) {
  const bucketMs = bucketSizeSeconds * 1000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs).toISOString();
}

function mapRollupsToHistory(rows: Array<typeof monitorCheckRollups.$inferSelect>) {
  return rows.map((row) => ({
    id: row.id,
    monitor_id: row.monitor_id,
    status: (row.last_status || "pending") as "up" | "down",
    timestamp: row.bucket_start,
    response_time: row.response_time_avg,
    status_code: null,
    error: null,
  }));
}

// 获取需要检查的监控列表
export async function getMonitorsToCheck(limit: number) {
  const now = new Date().toISOString();
  const monitorsToCheck = await db
    .select()
    .from(monitors)
    .where(
      and(
        eq(monitors.active, 1),
        or(lte(monitors.next_check_at, now), isNull(monitors.next_check_at))
      )
    )
    .orderBy(asc(monitors.next_check_at))
    .limit(limit)
    .execute();

  // 解析所有监控的 headers 字段
  if (monitorsToCheck) {
    monitorsToCheck.forEach((monitor: Monitor) => {
      if (typeof monitor.headers === "string") {
        try {
          monitor.headers = JSON.parse(monitor.headers);
        } catch (e) {
          monitor.headers = {};
        }
      }
    });
  }
  return monitorsToCheck;
}

// 获取单个监控详情
export async function getMonitorById(id: number, userId: number, userRole: string) {
  const monitor = await db.select().from(monitors).where(eq(monitors.id, id));

  if (monitor.length === 0) {
    return null;
  }

  // 权限检查：管理员或所有者
  if (userRole !== 'admin' && monitor[0].created_by !== userId) {
    return null;
  }
  
  // 解析 headers 字段
  const monitorData = monitor[0];
  if (monitorData && typeof monitorData.headers === "string") {
    try {
      // @ts-ignore
      monitorData.headers = JSON.parse(monitorData.headers);
    } catch (e) {
      // @ts-ignore
      monitorData.headers = {};
    }
  }
  return monitorData;
}

// 获取所有监控
export async function getAllMonitors(userId: number) {
  const result = await db
    .select()
    .from(monitors)
    .where(eq(monitors.created_by, userId))
    .orderBy(desc(monitors.created_at));

  // 解析所有监控的 headers 字段
  if (result) {
    // fix: 为 monitor 参数添加 Monitor 类型
    result.forEach((monitor: Monitor) => {
      if (typeof monitor.headers === "string") {
        try {
          // @ts-ignore
          monitor.headers = JSON.parse(monitor.headers);
        } catch (e) {
          // @ts-ignore
          monitor.headers = {};
        }
      }
    });
  }

  return result;
}

// 批量获取指定用户的监控
export async function getMonitorsByIds(monitorIds: number[], userId: number) {
  if (monitorIds.length === 0) return [];

  const result = await db
    .select()
    .from(monitors)
    .where(
      and(
        inArray(monitors.id, monitorIds),
        eq(monitors.created_by, userId)
      )
    )
    .orderBy(desc(monitors.created_at));

  result.forEach((monitor: Monitor) => {
    if (typeof monitor.headers === "string") {
      try {
        // @ts-ignore
        monitor.headers = JSON.parse(monitor.headers);
      } catch {
        // @ts-ignore
        monitor.headers = {};
      }
    }
  });

  return result;
}

// 获取单个监控状态历史 24小时内
export async function getMonitorStatusHistoryIn24h(monitorId: number) {
  const rollupRows = await db
    .select()
    .from(monitorCheckRollups)
    .where(
      and(
        eq(monitorCheckRollups.monitor_id, monitorId),
        gte(monitorCheckRollups.bucket_start, getTwentyFourHoursAgo())
      )
    )
    .orderBy(asc(monitorCheckRollups.bucket_start))
    .limit(SINGLE_HISTORY_LIMIT);

  if (rollupRows.length > 0) {
    return mapRollupsToHistory(rollupRows);
  }

  const rows = await db
    .select()
    .from(monitorStatusHistory24h)
    .where(
      and(
        eq(monitorStatusHistory24h.monitor_id, monitorId),
        gte(monitorStatusHistory24h.timestamp, getTwentyFourHoursAgo())
      )
    )
    .orderBy(desc(monitorStatusHistory24h.timestamp))
    .limit(SINGLE_HISTORY_LIMIT);

  return rows.reverse();
}

// 获取所有监控状态历史 24小时内
export async function getAllMonitorStatusHistoryIn24h(userId: number) {
  const userMonitors = await getAllMonitors(userId);
  // fix: 添加 Monitor 类型以解决 TS7006
  const monitorIds = userMonitors.map((m: Monitor) => m.id);
  if (monitorIds.length === 0) return [];

  const rollupRows = await db
    .select()
    .from(monitorCheckRollups)
    .where(
      and(
        inArray(monitorCheckRollups.monitor_id, monitorIds),
        gte(monitorCheckRollups.bucket_start, getTwentyFourHoursAgo())
      )
    )
    .orderBy(asc(monitorCheckRollups.bucket_start))
    .limit(ALL_HISTORY_LIMIT);

  if (rollupRows.length > 0) {
    return mapRollupsToHistory(rollupRows);
  }

  const rows = await db
    .select()
    .from(monitorStatusHistory24h)
    // fix: 使用 inArray 查询多个监控项
    .where(
      and(
        inArray(monitorStatusHistory24h.monitor_id, monitorIds),
        gte(monitorStatusHistory24h.timestamp, getTwentyFourHoursAgo())
      )
    )
    .orderBy(desc(monitorStatusHistory24h.timestamp))
    .limit(ALL_HISTORY_LIMIT);

  return rows.reverse();
}

// 批量获取多个监控的 24 小时状态历史
export async function getMonitorStatusHistoryIn24hByIds(monitorIds: number[]) {
  if (monitorIds.length === 0) return [];

  const rollupRows = await db
    .select()
    .from(monitorCheckRollups)
    .where(
      and(
        inArray(monitorCheckRollups.monitor_id, monitorIds),
        gte(monitorCheckRollups.bucket_start, getTwentyFourHoursAgo())
      )
    )
    .orderBy(asc(monitorCheckRollups.bucket_start))
    .limit(ALL_HISTORY_LIMIT);

  if (rollupRows.length > 0) {
    return mapRollupsToHistory(rollupRows);
  }

  const rows = await db
    .select()
    .from(monitorStatusHistory24h)
    .where(
      and(
        inArray(monitorStatusHistory24h.monitor_id, monitorIds),
        gte(monitorStatusHistory24h.timestamp, getTwentyFourHoursAgo())
      )
    )
    .orderBy(desc(monitorStatusHistory24h.timestamp))
    .limit(ALL_HISTORY_LIMIT);

  return rows.reverse();
}
// 记录监控状态历史到热表
export async function insertMonitorStatusHistory(
  monitorId: number,
  status: string,
  response_time: number,
  status_code: number,
  error: string | null
) {
  // 使用ISO格式的时间戳
  const now = new Date().toISOString();

  await db.insert(monitorStatusHistory24h).values({
    monitor_id: monitorId,
    status: status,
    timestamp: now,
    response_time: response_time,
    status_code: status_code,
    error: error,
  });
}

// 更新监控状态
export async function updateMonitorStatus(
  monitorId: number,
  status: string,
  responseTime: number,
  interval: number = 60
) {
  // 使用ISO格式的时间戳
  const now = new Date().toISOString();
  const nextCheckAt = getNextCheckAt(interval);

  await db
    .update(monitors)
    .set({
      status: status,
      last_checked: now,
      next_check_at: nextCheckAt,
      response_time: responseTime,
    })
    .where(eq(monitors.id, monitorId));
}

export async function upsertMonitorCheckRollup(
  monitorId: number,
  status: string,
  responseTime: number,
  checkedAt = new Date()
) {
  const bucketSizeSeconds = ROLLUP_BUCKET_SIZE_SECONDS;
  const bucketStart = getBucketStart(checkedAt, bucketSizeSeconds);
  const now = checkedAt.toISOString();
  const isUp = status === "up" ? 1 : 0;
  const isDown = status === "down" ? 1 : 0;
  const normalizedResponseTime = Math.max(0, Math.round(responseTime || 0));

  return await db
    .insert(monitorCheckRollups)
    .values({
      monitor_id: monitorId,
      bucket_start: bucketStart,
      bucket_size_seconds: bucketSizeSeconds,
      total_checks: 1,
      up_checks: isUp,
      down_checks: isDown,
      last_status: status,
      response_time_avg: normalizedResponseTime,
      response_time_p95: normalizedResponseTime,
      response_time_max: normalizedResponseTime,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        monitorCheckRollups.monitor_id,
        monitorCheckRollups.bucket_start,
        monitorCheckRollups.bucket_size_seconds,
      ],
      set: {
        total_checks: sql`${monitorCheckRollups.total_checks} + 1`,
        up_checks: sql`${monitorCheckRollups.up_checks} + ${isUp}`,
        down_checks: sql`${monitorCheckRollups.down_checks} + ${isDown}`,
        last_status: status,
        response_time_avg: sql`round(((${monitorCheckRollups.response_time_avg} * ${monitorCheckRollups.total_checks}) + ${normalizedResponseTime}) / (${monitorCheckRollups.total_checks} + 1))`,
        response_time_p95: sql`max(${monitorCheckRollups.response_time_p95}, ${normalizedResponseTime})`,
        response_time_max: sql`max(${monitorCheckRollups.response_time_max}, ${normalizedResponseTime})`,
        updated_at: now,
      },
    });
}

export async function recordMonitorIncident(
  monitorId: number,
  previousStatus: string | null | undefined,
  currentStatus: string,
  error: string | null,
  checkedAt = new Date()
) {
  if (!previousStatus || previousStatus === currentStatus) {
    return;
  }

  const now = checkedAt.toISOString();

  if (currentStatus === "up") {
    await db
      .update(monitorIncidents)
      .set({
        ended_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(monitorIncidents.monitor_id, monitorId),
          isNull(monitorIncidents.ended_at)
        )
      );
  }

  return await db.insert(monitorIncidents).values({
    monitor_id: monitorId,
    from_status: previousStatus,
    to_status: currentStatus,
    started_at: now,
    ended_at: currentStatus === "up" ? now : null,
    reason: error,
    last_error: error,
    created_at: now,
    updated_at: now,
  });
}

// 创建新监控
export async function createMonitor(
  name: string,
  url: string,
  method: string = "GET",
  interval: number = 60,
  timeout: number = 30,
  expectedStatus: number = 200,
  headers: Record<string, string> = {},
  body: string = "",
  userId: number
) {
  const now = new Date().toISOString();

  const [newMonitor] = await db
    .insert(monitors)
    .values({
      name: name,
      url: url,
      method: method,
      interval: interval,
      timeout: timeout,
      expected_status: expectedStatus,
      headers: JSON.stringify(headers),
      body: body,
      created_by: userId,
      active: 1,
      status: "pending",
      response_time: 0,
      last_checked: null,
      next_check_at: now,
      created_at: now,
      updated_at: now,
    })
    .returning();

  if (!newMonitor) {
    throw new Error("创建监控失败");
  }

  if (newMonitor && typeof newMonitor.headers === "string") {
    try {
        // @ts-ignore
      newMonitor.headers = JSON.parse(newMonitor.headers);
    } catch (e) {
        // @ts-ignore
      newMonitor.headers = {};
    }
  }

  return newMonitor;
}

// 更新监控配置
export async function updateMonitorConfig(
  id: number,
  // fix: 修正 Monitor 类型的使用
  updates: Partial<Monitor>
) {
  
  // 准备更新数据对象
  const updateData: { [key: string]: any } = {
    updated_at: new Date().toISOString(),
  };

  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.url !== undefined) updateData.url = updates.url;
  if (updates.method !== undefined) updateData.method = updates.method;
  if (updates.interval !== undefined) updateData.interval = updates.interval;
  if (updates.timeout !== undefined) updateData.timeout = updates.timeout;
  if (updates.expected_status !== undefined) updateData.expected_status = updates.expected_status;
  if (updates.headers !== undefined) updateData.headers = JSON.stringify(updates.headers);
  if (updates.body !== undefined) updateData.body = updates.body;
  if (updates.active !== undefined) updateData.active = updates.active ? 1 : 0;

  if (updates.active !== undefined) {
    updateData.next_check_at = updates.active
      ? new Date().toISOString()
      : null;
  } else if (updates.interval !== undefined) {
    updateData.next_check_at = new Date().toISOString();
  }


  // 如果没有要更新的字段，则提前返回
  if (Object.keys(updateData).length <= 1) { // 只有 updated_at
    return { message: "没有提供要更新的字段" };
  }

  // 执行更新
  const [updatedMonitor] = await db
    .update(monitors)
    .set(updateData)
    .where(eq(monitors.id, id))
    .returning();

  if (!updatedMonitor) {
    throw new Error("更新监控失败");
  }

  // 解析 headers 字段
  if (updatedMonitor && typeof updatedMonitor.headers === "string") {
    try {
        // @ts-ignore
      updatedMonitor.headers = JSON.parse(updatedMonitor.headers);
    } catch (e) {
        // @ts-ignore
      updatedMonitor.headers = {};
    }
  }

  return updatedMonitor;
}

// 删除监控
export async function deleteMonitor(id: number) {
  // 先删除关联的历史数据
  await db
    .delete(monitorStatusHistory24h)
    .where(eq(monitorStatusHistory24h.monitor_id, id));

  // 删除每日统计数据
  await db
    .delete(monitorDailyStats)
    .where(eq(monitorDailyStats.monitor_id, id));

  await db
    .delete(monitorCheckRollups)
    .where(eq(monitorCheckRollups.monitor_id, id));

  await db
    .delete(monitorIncidents)
    .where(eq(monitorIncidents.monitor_id, id));

  // 执行删除监控
  await db.delete(monitors).where(eq(monitors.id, id));
}

// 新增：根据用户ID删除监控
export async function deleteMonitorsByUserId(userId: number) {
  const userMonitors = await getAllMonitors(userId);
  // fix: 为参数 'm' 明确添加 Monitor 类型
  const monitorIds = userMonitors.map((m: Monitor) => m.id);

  if (monitorIds.length === 0) {
    return;
  }

  // 批量删除关联的历史数据和每日统计数据
  await db.delete(monitorStatusHistory24h).where(inArray(monitorStatusHistory24h.monitor_id, monitorIds));
  await db.delete(monitorDailyStats).where(inArray(monitorDailyStats.monitor_id, monitorIds));
  await db.delete(monitorCheckRollups).where(inArray(monitorCheckRollups.monitor_id, monitorIds));
  await db.delete(monitorIncidents).where(inArray(monitorIncidents.monitor_id, monitorIds));

  // 批量删除监控
  await db.delete(monitors).where(inArray(monitors.id, monitorIds));
}


export async function getMonitorDailyStatsById(id: number) {
  // 查询每日统计数据
  return await db
    .select()
    .from(monitorDailyStats)
    .where(eq(monitorDailyStats.monitor_id, id))
    .orderBy(asc(monitorDailyStats.date));
}

export async function getAllMonitorDailyStats(userId: number) {
  const userMonitors = await getAllMonitors(userId);
  // fix: 添加 Monitor 类型以解决 TS7006
  const monitorIds = userMonitors.map((m: Monitor) => m.id);
  if (monitorIds.length === 0) return [];

  return await db
    .select()
    .from(monitorDailyStats)
    // fix: 使用 inArray 查询多个监控项
    .where(inArray(monitorDailyStats.monitor_id, monitorIds))
    .orderBy(asc(monitorDailyStats.date));
}

export async function getMonitorDailyStatsByIds(monitorIds: number[]) {
  if (monitorIds.length === 0) return [];

  return await db
    .select()
    .from(monitorDailyStats)
    .where(inArray(monitorDailyStats.monitor_id, monitorIds))
    .orderBy(asc(monitorDailyStats.date));
}
