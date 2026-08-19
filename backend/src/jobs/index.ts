// 导出所有定时任务
import monitorTask from "./monitor-task";
import agentTask from "./agent-task";
import { checkExpiringAgents } from "./expiry-task";
import { getEnvNumber } from "../utils/env";
import { runAgentBlockRetention } from "./agent-block-retention";
import {
  claimIntervalRun,
  DAILY_INTERVAL_MS,
  INTERVAL_KEY_CLEANUP,
  INTERVAL_KEY_EXPIRY_CHECK,
} from "./interval-gate";

import {
  rotateNotificationSecretKek,
} from "../modules/notifications/persistence/NotificationSecretMaintenance";
import {
  deleteOldSecurityAuditEvents,
  deleteStaleSecurityRateLimits,
  writeSecurityAuditEvent,
} from "../platform/security/SecurityStore";
import type { Bindings } from "../models/db";
import { writeStructuredLog } from "../platform/observability/StructuredLogger";

const DEFAULT_MONITOR_ROLLUP_RETENTION_DAYS = 90;
const DEFAULT_MONITOR_SAMPLE_RETENTION_DAYS = 90;
const DEFAULT_MONITOR_DAILY_ROLLUP_RETENTION_DAYS = 3650;
const DEFAULT_MONITOR_INCIDENT_RETENTION_DAYS = 180;
const DEFAULT_SECURITY_AUDIT_RETENTION_DAYS = 180;
const DEFAULT_STATUS_PUBLICATION_RETENTION_DAYS = 1;
const DEFAULT_PROCESSED_EVENT_RETENTION_DAYS = 30;
const DEFAULT_NOTIFICATION_EVENT_RETENTION_DAYS = 90;
const SECURITY_RATE_LIMIT_RETENTION_DAYS = 7;


// 统一的定时任务处理函数
export const runScheduledTasks = async (
  event: ScheduledController,
  env: Bindings,
  ctx: ExecutionContext
) => {
  const nowMs = Number.isFinite(Number(event.scheduledTime))
    ? Number(event.scheduledTime)
    : Date.now();
  const now = new Date(nowMs);
  let failures = 0;

  // 每个子任务都自己兜住异常：2026-08-12 的事故就是「库满 → monitorTask 抛异常 →
  // 清理任务永远走不到 → 库永远满」的自锁循环，任何一个环节都不该能掐断后面的环节。
  const runIsolated = async (operation: string, task: () => Promise<unknown>) => {
    try {
      await task();
      return true;
    } catch (error) {
      failures += 1;
      writeStructuredLog(env, {
        service: "cron",
        operation,
        result: "failure",
        errorCode: `CRON_${operation.toUpperCase()}_FAILED`,
        error,
      });
      return false;
    }
  };

  // 清理排在最前面：它是自愈路径，必须先于任何可能因库满而失败的任务执行。
  await runIsolated("cleanup_old_records", async () => {
    if (await claimIntervalRun(env, INTERVAL_KEY_CLEANUP, DAILY_INTERVAL_MS, nowMs)) {
      await cleanupOldRecords(env);
    }
  });

  // 块保留策略自己记日志、自己吞异常，每个 tick 都跑。
  await runAgentBlockRetention(env, nowMs);

  {
    try {
      const notificationRotation = await rotateNotificationSecretKek(env, 10);
      if (notificationRotation.rotated > 0) {
        writeStructuredLog(env, {
          service: "migration",
          operation: "notification_kek_rotate",
          result: notificationRotation.remaining ? "deferred" : "success",
          fields: {
            rows_written: notificationRotation.rotated,
            remaining: notificationRotation.remaining,
            target_key_version: notificationRotation.targetKeyVersion,
          },
        });
        await writeSecurityAuditEvent(env, {
          eventType: "notification.kek.rotate",
          outcome: "success",
          actorType: "system",
          metadata: {
            rotated: notificationRotation.rotated,
            target_key_version: notificationRotation.targetKeyVersion,
          },
        });
      }
    } catch (error) {
      writeStructuredLog(env, {
        service: "migration",
        operation: "notification_kek_rotate",
        result: "failure",
        errorCode: "NOTIFICATION_KEK_ROTATE_FAILED",
        error,
      });
    }

  }

  // 执行监控检查任务
  await runIsolated("monitor_task", () => monitorTask.scheduled(event, env, ctx));

  // Agent 定时任务只推进在线状态与低频事件。
  await runIsolated("agent_task", () => agentTask.scheduled(event, env, ctx));

  // 客户端账单到期检测/自动续费 - 每天一次。
  await runIsolated("expiry_check", async () => {
    if (
      await claimIntervalRun(env, INTERVAL_KEY_EXPIRY_CHECK, DAILY_INTERVAL_MS, nowMs)
    ) {
      await checkExpiringAgents(env, nowMs);
    }
  });

  // 全部隔离执行完毕后再抛：让 Cloudflare 把这次触发标记为失败以便告警，
  // 但不影响本次已经跑完的其它任务。
  if (failures > 0) {
    throw new Error(`scheduled tasks failed: ${failures}`);
  }
};

// 清理30天以前的历史记录
function getCutoffIso(days: number) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff.toISOString();
}

export async function cleanupOldRecords(env: Bindings) {
  const cleanupStartedAt = new Date().toISOString();
  await env.DB.prepare(`DELETE FROM admin_sessions WHERE expires_at <= ?`)
    .bind(cleanupStartedAt)
    .run();

  const monitorRollupCutoff = getCutoffIso(
    getEnvNumber(
      env,
      "MONITOR_ROLLUP_RETENTION_DAYS",
      DEFAULT_MONITOR_ROLLUP_RETENTION_DAYS,
      { min: 1, max: 3650 }
    )
  );
  const monitorDailyRollupCutoff = getCutoffIso(
    getEnvNumber(
      env,
      "MONITOR_DAILY_ROLLUP_RETENTION_DAYS",
      DEFAULT_MONITOR_DAILY_ROLLUP_RETENTION_DAYS,
      { min: 30, max: 36500 }
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
  const monitorSampleCutoff = getCutoffIso(
    getEnvNumber(
      env,
      "MONITOR_SAMPLE_RETENTION_DAYS",
      DEFAULT_MONITOR_SAMPLE_RETENTION_DAYS,
      { min: 1, max: 3650 }
    )
  );
  const securityAuditCutoff = getCutoffIso(
    getEnvNumber(
      env,
      "SECURITY_AUDIT_RETENTION_DAYS",
      DEFAULT_SECURITY_AUDIT_RETENTION_DAYS,
      { min: 30, max: 3650 }
    )
  );
  const statusPublicationCutoff = getCutoffIso(
    getEnvNumber(env, "STATUS_PUBLICATION_RETENTION_DAYS", DEFAULT_STATUS_PUBLICATION_RETENTION_DAYS, {
      min: 1,
      max: 365,
    })
  );
  const processedEventCutoff = getCutoffIso(
    getEnvNumber(env, "PROCESSED_EVENT_RETENTION_DAYS", DEFAULT_PROCESSED_EVENT_RETENTION_DAYS, {
      min: 1,
      max: 3650,
    })
  );
  const notificationEventCutoff = getCutoffIso(
    getEnvNumber(env, "NOTIFICATION_EVENT_RETENTION_DAYS", DEFAULT_NOTIFICATION_EVENT_RETENTION_DAYS, {
      min: 1,
      max: 3650,
    })
  );
  // Agent 指标的保留策略已整体搬到 agent-block-retention.ts：
  // 块表按年龄 + 字节预算回收，不再有 agent_metric_rollups / agent_reports 的按天清理。
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM monitor_check_rollups
       WHERE bucket_size_seconds < 86400 AND bucket_start < ?`
    ).bind(monitorRollupCutoff),
    env.DB.prepare(
      `DELETE FROM monitor_check_rollups
       WHERE bucket_size_seconds >= 86400 AND bucket_start < ?`
    ).bind(monitorDailyRollupCutoff),
    env.DB.prepare(
      `DELETE FROM monitor_incidents WHERE started_at < ? AND ended_at IS NOT NULL`
    ).bind(monitorIncidentCutoff),
    env.DB.prepare(`DELETE FROM monitor_check_samples WHERE checked_at < ?`).bind(
      monitorSampleCutoff
    ),
  ]);
  await deleteOldSecurityAuditEvents(env, securityAuditCutoff);
  await deleteStaleSecurityRateLimits(
    env,
    getCutoffIso(SECURITY_RATE_LIMIT_RETENTION_DAYS)
  );
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM processed_events WHERE processed_at < ?`).bind(
      processedEventCutoff
    ),
    env.DB.prepare(
      `DELETE FROM notification_events WHERE updated_at < ? AND status = 'completed'`
    ).bind(notificationEventCutoff),
    env.DB.prepare(
      `DELETE FROM status_publications
       WHERE generated_at < ?
         AND id NOT IN (
           SELECT active_publication_id FROM status_publication_state
           WHERE active_publication_id IS NOT NULL
         )`
    ).bind(statusPublicationCutoff),
  ]);
  return {
    success: true,
  };
}
