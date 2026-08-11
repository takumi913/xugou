// 导出所有定时任务
import monitorTask from "./monitor-task";
import agentTask from "./agent-task";
import {
  checkExpiringAgents,
  shouldRunDailyExpiryCheck,
} from "./expiry-task";
import { getEnvNumber } from "../utils/env";

import {
  backfillNotificationSecrets,
  rotateNotificationSecretKek,
} from "../modules/notifications/persistence/NotificationSecretMaintenance";
import {
  deleteOldSecurityAuditEvents,
  deleteStaleSecurityRateLimits,
  writeSecurityAuditEvent,
} from "../platform/security/SecurityStore";
import type { Bindings } from "../models/db";
import { writeStructuredLog } from "../platform/observability/StructuredLogger";

const DEFAULT_AGENT_ROLLUP_RETENTION_DAYS = 30;
const DEFAULT_MONITOR_ROLLUP_RETENTION_DAYS = 90;
const DEFAULT_MONITOR_DAILY_ROLLUP_RETENTION_DAYS = 3650;
const DEFAULT_MONITOR_INCIDENT_RETENTION_DAYS = 180;
const DEFAULT_SECURITY_AUDIT_RETENTION_DAYS = 180;
const DEFAULT_STATUS_PUBLICATION_RETENTION_DAYS = 7;
const DEFAULT_PROCESSED_EVENT_RETENTION_DAYS = 30;
const DEFAULT_NOTIFICATION_EVENT_RETENTION_DAYS = 90;
const DEFAULT_API_COMPATIBILITY_HIT_RETENTION_DAYS = 400;
const SECURITY_RATE_LIMIT_RETENTION_DAYS = 7;


// 统一的定时任务处理函数
export const runScheduledTasks = async (
  event: ScheduledController,
  env: Bindings,
  ctx: ExecutionContext
) => {
  try {
    const now = new Date();


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

    // 执行监控检查任务
    await monitorTask.scheduled(event, env, ctx);

    // 新指标只写不可变 report samples；旧历史由可恢复 Backfill 读取，不再运行时改表。
    await agentTask.scheduled(event, env, ctx);

    // 执行清理任务 - 每天执行一次
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    if (hour === 0 && minute === 30) {
      await cleanupOldRecords(env);
    }

    // 客户端账单到期检测/自动续费 - 每天 UTC 12:00 执行一次
    if (shouldRunDailyExpiryCheck(now)) {
      await checkExpiringAgents(env);
    }
  } catch (error) {
    throw error;
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
  // monitor_daily_stats 与 notification_history 在兼容窗口内仍是 Backfill 源和
  // 回切证据；只清理目标模型及无迁移依赖的数据。旧源表由独立 Contract 发布处理。
  await env.DB.prepare(`DELETE FROM admin_sessions WHERE expires_at <= ?`)
    .bind(cleanupStartedAt)
    .run();

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
  const compatibilityHitCutoff = getCutoffIso(
    getEnvNumber(
      env,
      "API_COMPATIBILITY_HIT_RETENTION_DAYS",
      DEFAULT_API_COMPATIBILITY_HIT_RETENTION_DAYS,
      { min: 60, max: 3650 }
    )
  ).slice(0, 10);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM agent_metric_rollups WHERE bucket_start < ?`).bind(
      agentRollupCutoff
    ),
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
    env.DB.prepare(`DELETE FROM api_compatibility_hits WHERE day < ?`).bind(
      compatibilityHitCutoff
    ),
  ]);
  return {
    success: true,
  };
}
