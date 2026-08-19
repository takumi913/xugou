import type { Bindings } from "../models/db";

/**
 * Cloudflare cron 不保证准点触发：绑定到「UTC 00:30 这一分钟」的任务漏一次就整天不跑，
 * 而库满时正是这种漏跑把「清理永不执行 → 库永远满」锁死的。
 *
 * 改为在 settings 表记录上次执行时间，超过间隔就跑。领取动作用一条带 WHERE 的 upsert
 * 完成，靠 meta.changes 判断是否抢到，避免两个重叠的 cron 调用同时执行同一个任务。
 */
export async function claimIntervalRun(
  env: Bindings,
  key: string,
  intervalMs: number,
  nowMs: number = Date.now()
): Promise<boolean> {
  const threshold = nowMs - intervalMs;
  const result = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value
     WHERE CAST(settings.value AS INTEGER) <= ?`
  )
    .bind(key, String(nowMs), threshold)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export const INTERVAL_KEY_CLEANUP = "jobs.cleanup_old_records.last_run_at_ms";
export const INTERVAL_KEY_DAILY_MONITOR_STATS =
  "jobs.daily_monitor_stats.last_run_at_ms";
export const INTERVAL_KEY_EXPIRY_CHECK = "jobs.expiry_check.last_run_at_ms";
export const INTERVAL_KEY_AGENT_BLOCK_BUDGET =
  "jobs.agent_block_budget_gc.last_run_at_ms";

export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const HOURLY_INTERVAL_MS = 60 * 60 * 1000;
