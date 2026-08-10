import type { Bindings } from "../models/db";
import { writeStructuredLog } from "../platform/observability/StructuredLogger";
import { QueueJobPublisher } from "../platform/queues/QueuePublisher";


const EXPIRE_REMINDER_DAYS = 7;
const RENEW_GUARD_MAX_STEPS = 120;
const EXPIRY_SCAN_BATCH_SIZE = 100;
const BILLING_CYCLE_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

interface ExpiringAgentRow {
  id: number;
  name: string;
  expire_date: string;
  billing_cycle: string | null;
  auto_renewal: number | null;
}

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
  return toDateString(
    year,
    month,
    Math.min(parsed.day, daysInUtcMonth(year, month))
  );
}

function utcTodayDateString(now: number) {
  const date = new Date(now);
  return toDateString(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate()
  );
}

export async function checkExpiringAgents(
  env: Bindings,
  nowMs = Date.now()
): Promise<{ renewed: number; notified: number }> {
  const today = utcTodayDateString(nowMs);
  const publisher = new QueueJobPublisher(env.XUGOU_JOBS);
  let renewed = 0;
  let notified = 0;
  let cursor = 0;

  for (;;) {
    const { results: agents } = await env.DB.prepare(
      `SELECT id, name, expire_date, billing_cycle, auto_renewal
         FROM agent_nodes
         WHERE deleted_at_ms IS NULL AND expire_date IS NOT NULL
           AND TRIM(expire_date) <> '' AND id > ?
         ORDER BY id LIMIT ?`
    )
      .bind(cursor, EXPIRY_SCAN_BATCH_SIZE)
      .all<ExpiringAgentRow>();
    if (agents.length === 0) break;
    cursor = agents.at(-1)!.id;

    for (const agent of agents) {
      const parsed = parseDateOnly(agent.expire_date);
      if (!parsed) continue;
      const originalExpireDate = agent.expire_date;
      let expireDate = toDateString(parsed.year, parsed.month, parsed.day);
      if (
        agent.auto_renewal === 1 &&
        BILLING_CYCLE_MONTHS[agent.billing_cycle ?? ""]
      ) {
        let guard = 0;
        let next = expireDate;
        while (next <= today && guard < RENEW_GUARD_MAX_STEPS) {
          next = addBillingCycleToDate(next, agent.billing_cycle);
          guard += 1;
        }
        if (next !== expireDate && next > today) {
          const statements = [
            env.DB.prepare(
              `UPDATE agent_nodes SET expire_date = ?, updated_at_ms = ?
               WHERE id = ? AND expire_date = ? AND deleted_at_ms IS NULL`
            ).bind(next, nowMs, agent.id, originalExpireDate),
          ];
          const updateResults = await env.DB.batch(statements);
          if (updateResults[0].meta.changes === 1) renewed += 1;
          expireDate = next;
        }
      }

      const expireAt = Date.parse(`${expireDate}T00:00:00.000Z`);
      const daysRemaining = Math.ceil((expireAt - nowMs) / 86_400_000);
      if (daysRemaining <= 0 || daysRemaining > EXPIRE_REMINDER_DAYS) continue;

      const nowIso = new Date(nowMs).toISOString();
      const eventId = `agent.expiry.reminder:${agent.id}:${today}:${expireDate}`;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO domain_outbox
         (event_id, event_type, aggregate_type, aggregate_id, payload_json,
          status, attempts, available_at, created_at, updated_at)
         VALUES (?, 'agent.expiry.reminder', 'agent', ?, ?, 'pending', 0, ?, ?, ?)`
      )
        .bind(
          eventId,
          String(agent.id),
          JSON.stringify({
            expire_date: expireDate,
            days_remaining: daysRemaining,
            billing_cycle: agent.billing_cycle,
            auto_renewal: agent.auto_renewal === 1,
            observed_at: nowIso,
          }),
          nowIso,
          nowIso,
          nowIso
        )
        .run();
      const pending = await env.DB.prepare(
        `SELECT event_id FROM domain_outbox
         WHERE event_id = ? AND status = 'pending' LIMIT 1`
      )
        .bind(eventId)
        .first<{ event_id: string }>();
      if (!pending) continue;
      try {
        await publisher.publishOutbox(eventId);
        const publishedAt = new Date().toISOString();
        await env.DB.prepare(
          `UPDATE domain_outbox SET status = 'published', attempts = attempts + 1,
           published_at = ?, last_error = NULL, updated_at = ?
           WHERE event_id = ? AND status = 'pending'`
        )
          .bind(publishedAt, publishedAt, eventId)
          .run();
        notified += 1;
      } catch (error) {
        writeStructuredLog(env, {
          service: "queue",
          operation: "publish_agent_expiry_outbox",
          result: "deferred",
          eventId,
          entityType: "agent",
          entityId: agent.id,
          errorCode: "AGENT_EXPIRY_PUBLISH_DEFERRED",
          error,
        });
      }
    }
  }
  return { renewed, notified };
}
