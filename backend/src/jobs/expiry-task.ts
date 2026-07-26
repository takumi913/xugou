/**
 * 客户端账单到期检测任务（参照 CF-Server-Monitor checkExpiringServers）
 *
 * 每日 UTC 12:00 触发一次：
 *   1. auto_renewal=1 且已到期的客户端，按计费周期把 expire_date 顺延到未来
 *   2. expire_date 距今 ≤7 天（且未过期）的客户端，通过现有通知渠道发送到期提醒
 *
 * 通知触发机制取舍：通知设置模型没有 on_expire 开关，为最小侵入，
 * 复用 agent 资源级/global-agent 全局设置里已配置的渠道列表（只要设置 enabled
 * 即发送，不新增开关列）；渠道未配置时静默跳过。
 */
import {
  getAgentNotificationSettingsForUsers,
  getAgentsWithExpireDate,
  resolveEffectiveAgentNotificationSetting,
  updateAgentExpireDates,
  type NotificationSettingRow,
} from "../repositories";
import { sendNotification } from "../services";

const EXPIRE_REMINDER_DAYS = 7;
const RENEW_GUARD_MAX_STEPS = 120;

// 计费周期对应的月数（once 不参与自动续费）
const BILLING_CYCLE_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

// 是否到达每日到期检测时刻（UTC 12:00 的那一分钟）
export function shouldRunDailyExpiryCheck(now: Date = new Date()): boolean {
  return now.getUTCHours() === 12 && now.getUTCMinutes() === 0;
}

function parseDateOnly(value: string | null | undefined) {
  const match = String(value ?? "")
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function daysInUtcMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toDateString(year: number, month: number, day: number) {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

// 按计费周期顺延日期（UTC 月份加法，日截断到目标月末），参照 CF-SM addBillingCycleToDate
export function addBillingCycleToDate(
  dateString: string,
  billingCycle: string | null | undefined
): string {
  const parsed = parseDateOnly(dateString);
  const months = BILLING_CYCLE_MONTHS[billingCycle ?? ""];
  if (!parsed || !months) return dateString;

  const zeroBasedMonth = parsed.month - 1 + months;
  const year = parsed.year + Math.floor(zeroBasedMonth / 12);
  const month = ((zeroBasedMonth % 12) + 12) % 12 + 1;
  const day = Math.min(parsed.day, daysInUtcMonth(year, month));
  return toDateString(year, month, day);
}

function utcTodayDateString(now: number) {
  const date = new Date(now);
  return toDateString(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate()
  );
}

// 从生效的通知设置行里解析渠道列表与冷却时长（设置缺失/解析失败按无渠道处理）
function parseNotifyChannels(setting: NotificationSettingRow | null) {
  if (!setting) return { channels: [] as number[], cooldownMinutes: 30 };
  try {
    const channels = JSON.parse(setting.channels || "[]") as number[];
    return {
      channels: Array.isArray(channels) ? channels : [],
      cooldownMinutes: setting.cooldown_minutes,
    };
  } catch {
    return { channels: [] as number[], cooldownMinutes: 30 };
  }
}

export async function checkExpiringAgents(): Promise<{
  renewed: number;
  notified: number;
}> {
  let renewed = 0;
  let notified = 0;

  try {
    const now = Date.now();
    const today = utcTodayDateString(now);
    const rows = await getAgentsWithExpireDate();

    // 第一遍：计算自动续费顺延结果，逐条 UPDATE 收敛为一次批量执行
    const renewals: Array<{ id: number; expire_date: string }> = [];
    const effectiveExpireDates = new Map<number, string>();
    for (const agent of rows) {
      const parsed = parseDateOnly(agent.expire_date);
      if (!parsed) continue;

      let expireDate = toDateString(parsed.year, parsed.month, parsed.day);

      // 自动续费：已到期时按周期顺延到未来（once/未知周期不续费）
      if (
        agent.auto_renewal === 1 &&
        BILLING_CYCLE_MONTHS[agent.billing_cycle ?? ""]
      ) {
        let guard = 0;
        let next = expireDate;
        while (next <= today && guard < RENEW_GUARD_MAX_STEPS) {
          next = addBillingCycleToDate(next, agent.billing_cycle);
          guard++;
        }
        if (next !== expireDate && next > today) {
          renewals.push({ id: agent.id, expire_date: next });
          expireDate = next;
          renewed++;
          console.log(
            `[Expiry] 客户端 ${agent.name} (ID: ${agent.id}) 自动续费至 ${next}`
          );
        }
      }

      effectiveExpireDates.set(agent.id, expireDate);
    }

    // 批量顺延（并行 UPDATE，幂等），列表缓存失效由 repository 层负责
    await updateAgentExpireDates(renewals);

    // 第二遍：筛出剩余 1-7 天的到期提醒（已过期/远期不提醒）
    const reminders: Array<{
      agent: (typeof rows)[number];
      expireDate: string;
      days: number;
    }> = [];
    for (const agent of rows) {
      const expireDate = effectiveExpireDates.get(agent.id);
      if (!expireDate) continue;
      const expTime = new Date(`${expireDate}T00:00:00Z`).getTime();
      const days = Math.ceil((expTime - now) / 86400000);
      if (days <= 0 || days > EXPIRE_REMINDER_DAYS) continue;
      reminders.push({ agent, expireDate, days });
    }

    // 通知设置在循环外一次批量查询，循环内按 userId/agentId 内存匹配
    const settingRows = await getAgentNotificationSettingsForUsers([
      ...new Set(reminders.map((reminder) => reminder.agent.created_by)),
    ]);

    for (const { agent, expireDate, days } of reminders) {
      try {
        const { channels, cooldownMinutes } = parseNotifyChannels(
          resolveEffectiveAgentNotificationSetting(
            settingRows,
            agent.id,
            agent.created_by
          )
        );
        if (channels.length === 0) continue;

        const variables = {
          name: agent.name,
          status: `即将到期（剩余 ${days} 天）`,
          previous_status: "active",
          time: new Date().toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
          }),
          hostname: agent.hostname || "未知",
          ip_addresses: "-",
          ip_address: "-",
          os: agent.os || "未知",
          error: `客户端将于 ${expireDate} 到期 ⏰`,
          details: `到期日期: ${expireDate}\n剩余天数: ${days} 天\n计费周期: ${
            agent.billing_cycle || "未设置"
          }\n自动续费: ${agent.auto_renewal === 1 ? "已开启" : "未开启"}`,
        };

        const result = await sendNotification(
          "agent",
          agent.id,
          variables,
          channels,
          agent.created_by,
          cooldownMinutes
        );
        if (result.success) {
          notified++;
        }
      } catch (error) {
        console.error(
          `[Expiry] 客户端 ${agent.name} (ID: ${agent.id}) 到期提醒发送失败:`,
          error
        );
      }
    }
  } catch (error) {
    console.error("[Expiry] 到期检测任务执行失败:", error);
  }

  return { renewed, notified };
}
