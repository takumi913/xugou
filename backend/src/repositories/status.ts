import { StatusPageConfig, Agent, Bindings } from "../models";
import { db } from "../config";
import {
  statusPageConfig,
  statusPageMonitors,
  statusPageAgents,
  publicStatusSnapshots,
  agents,
} from "../db/schema";
import { eq, desc, asc, and, count, sql, isNull, lte, or } from "drizzle-orm";

/**
 * 状态页相关的数据库操作
 */

// 获取所有状态页配置
export async function getAllStatusPageConfigs() {
  return await db.select().from(statusPageConfig);
}

// 新增：根据用户ID获取状态页配置
export async function getStatusPageConfigByUserId(userId: number) {
  const config = await db
    .select()
    .from(statusPageConfig)
    .where(eq(statusPageConfig.user_id, userId))
    .limit(1);
  return config[0];
}

// 获取配置的监控项
export async function getConfigMonitors(configId: number) {
  return await db
    .select()
    .from(statusPageMonitors)
    .where(eq(statusPageMonitors.config_id, configId));
}

// 获取配置的客户端
export async function getConfigAgents(configId: number) {
  return await db
    .select()
    .from(statusPageAgents)
    .where(eq(statusPageAgents.config_id, configId));
}

// 获取状态页配置
export async function getStatusPageConfigById(id: number) {
  const config = await db
    .select()
    .from(statusPageConfig)
    .where(eq(statusPageConfig.id, id));
  return config[0];
}

// 更新状态页配置
export async function updateStatusPageConfig(
  id: number,
  title: string,
  description: string,
  logoUrl: string,
  customCss: string
) {
  return await db
    .update(statusPageConfig)
    .set({
      title: title,
      description: description,
      logo_url: logoUrl,
      custom_css: customCss,
    })
    .where(eq(statusPageConfig.id, id));
}

// 创建状态页配置
export async function createStatusPageConfig(
  userId: number,
  title: string,
  description: string,
  logoUrl: string,
  customCss: string
) {
  const result = await db
    .insert(statusPageConfig)
    .values({
      user_id: userId,
      title: title,
      description: description,
      logo_url: logoUrl,
      custom_css: customCss,
    })
    .returning({ id: statusPageConfig.id }); // D1/SQLite 需要这样获取ID

  if (!result || result.length === 0) {
    throw new Error("创建状态页配置失败");
  }

  // 获取新插入的ID
  return result[0].id;
}

// 清除配置的监控项关联
export async function clearConfigMonitorLinks(configId: number) {
  return await db
    .delete(statusPageMonitors)
    .where(eq(statusPageMonitors.config_id, configId));
}

// 清除配置的客户端关联
export async function clearConfigAgentLinks(configId: number) {
  return await db
    .delete(statusPageAgents)
    .where(eq(statusPageAgents.config_id, configId));
}

// 添加监控项到配置
export async function addMonitorToConfig(configId: number, monitorId: number) {
  return await db.insert(statusPageMonitors).values({
    config_id: configId,
    monitor_id: monitorId,
  });
}

// 批量添加监控项到配置
export async function addMonitorsToConfig(
  configId: number,
  monitorIds: number[]
) {
  if (monitorIds.length === 0) return;

  const statements = monitorIds.map((monitorId) =>
    db.insert(statusPageMonitors).values({
      config_id: configId,
      monitor_id: monitorId,
    })
  );

  return await db.batch(statements);
}

// 添加客户端到配置
export async function addAgentToConfig(configId: number, agentId: number) {
  return await db.insert(statusPageAgents).values({
    config_id: configId,
    agent_id: agentId,
  });
}

// 批量添加客户端到配置
export async function addAgentsToConfig(configId: number, agentIds: number[]) {
  if (agentIds.length === 0) return;

  const statements = agentIds.map((agentId) =>
    db.insert(statusPageAgents).values({
      config_id: configId,
      agent_id: agentId,
    })
  );

  return await db.batch(statements);
}

// 获取选中的监控项IDs
export async function getSelectedMonitors(configId: number) {
  return await db
    .select({ monitor_id: statusPageMonitors.monitor_id })
    .from(statusPageMonitors)
    .where(eq(statusPageMonitors.config_id, configId));
}

// 获取选中的客户端IDs
export async function getSelectedAgents(configId: number) {
  return await db
    .select({ agent_id: statusPageAgents.agent_id })
    .from(statusPageAgents)
    .where(eq(statusPageAgents.config_id, configId));
}

export async function isAgentSelectedForStatusPage(
  userId: number,
  agentId: number
) {
  const rows = await db
    .select({ agent_id: statusPageAgents.agent_id })
    .from(statusPageConfig)
    .innerJoin(
      statusPageAgents,
      eq(statusPageAgents.config_id, statusPageConfig.id)
    )
    .innerJoin(agents, eq(agents.id, statusPageAgents.agent_id))
    .where(
      and(
        eq(statusPageConfig.user_id, userId),
        eq(statusPageAgents.agent_id, agentId),
        eq(agents.created_by, userId)
      )
    )
    .limit(1);

  return rows.length > 0;
}

export async function getPublicStatusSnapshot(userId: number) {
  const rows = await db
    .select()
    .from(publicStatusSnapshots)
    .where(eq(publicStatusSnapshots.user_id, userId))
    .limit(1);

  return rows[0] ?? null;
}

export async function upsertPublicStatusSnapshot(
  userId: number,
  snapshotJson: string,
  etag: string,
  expiresAt: string
) {
  const now = new Date().toISOString();
  const values = {
    user_id: userId,
    snapshot_json: snapshotJson,
    etag,
    generated_at: now,
    expires_at: expiresAt,
    dirty_at: null,
    refresh_after: null,
    refreshing: 0,
    last_error: null,
  };

  return await db
    .insert(publicStatusSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: publicStatusSnapshots.user_id,
      set: values,
    });
}

export async function markPublicStatusSnapshotDirty(
  userId: number,
  coalesceSeconds: number
) {
  const now = new Date();
  const refreshAfter = new Date(
    now.getTime() + Math.max(coalesceSeconds, 0) * 1000
  ).toISOString();
  const nowIso = now.toISOString();

  return await db
    .update(publicStatusSnapshots)
    .set({
      dirty_at: nowIso,
      refresh_after: refreshAfter,
    })
    .where(
      and(
        eq(publicStatusSnapshots.user_id, userId),
        or(
          isNull(publicStatusSnapshots.dirty_at),
          lte(publicStatusSnapshots.refresh_after, nowIso)
        )
      )
    );
}

// 新增：根据用户ID删除状态页配置
export async function deleteStatusPageConfigByUserId(userId: number) {
  await db.delete(statusPageConfig).where(eq(statusPageConfig.user_id, userId));
}
