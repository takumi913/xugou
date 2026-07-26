/**
 * 账单/到期辅助函数（参照 CF-Server-Monitor serverBilling 精简）
 */
import type { BillingCycle } from "../types/agents";

// 计费周期短标签的 i18n key（组件内用 t() 取双语文案）
export const BILLING_CYCLE_KEYS: Record<BillingCycle, string> = {
  monthly: "agent.billing.cycle.monthly",
  quarterly: "agent.billing.cycle.quarterly",
  yearly: "agent.billing.cycle.yearly",
  once: "agent.billing.cycle.once",
};

export const BILLING_CYCLES = Object.keys(
  BILLING_CYCLE_KEYS
) as BillingCycle[];

// 到期剩余天数（UTC 日期差，已过期为负数；无/非法日期返回 null）
export function getDaysUntilExpire(
  expireDate?: string | null,
  now: number = Date.now()
): number | null {
  const match = String(expireDate ?? "")
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const expTime = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );
  if (!Number.isFinite(expTime)) return null;
  return Math.ceil((expTime - now) / 86400000);
}

// 剩余天数着色：过期红 / ≤7 天黄 / 其余次要色
// 注意：7 天阈值与 backend/src/jobs/expiry-task.ts 的 EXPIRE_REMINDER_DAYS 保持同步
export function getExpireColor(days: number): string {
  if (days <= 0) return "var(--accent-red)";
  if (days <= 7) return "var(--accent-yellow)";
  return "var(--text-secondary)";
}
