import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/models/db";
import { scheduleDueMonitorChecks } from "../src/modules/monitors/queue/MonitorScheduler";
import { relayPendingQueueWork } from "../src/platform/queues/OutboxRelay";

const dueAt = Date.parse("2026-08-09T08:00:00.000Z");
const scheduledAt = new Date("2026-08-09T09:00:00.000Z");

async function seedDueMonitors(baseId: number, size: number) {
  const offsets = JSON.stringify(Array.from({ length: size }, (_, index) => index));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO monitor_definitions
       (id, name, url, method, headers_json, body, interval_ms, timeout_ms,
        expected_status, active, sort_order, created_at_ms, updated_at_ms,
        deleted_at_ms)
       SELECT ? + CAST(value AS INTEGER),
              'scheduler-scale-' || (? + CAST(value AS INTEGER)),
              'https://scheduler-scale-' || (? + CAST(value AS INTEGER)) || '.example.test',
              'GET', '{}', NULL, 300000, 30000, 200, 1,
              CAST(value AS INTEGER), ?, ?, NULL
       FROM json_each(?)`
    ).bind(baseId, baseId, baseId, dueAt, dueAt, offsets),
    env.DB.prepare(
      `INSERT INTO monitor_runtime
       (monitor_id, status, response_time_ms, last_checked_at_ms,
        next_due_at_ms, version, created_at_ms, updated_at_ms)
       SELECT ? + CAST(value AS INTEGER), 'pending', 0, NULL,
              ? + CAST(value AS INTEGER), 0, ?, ?
       FROM json_each(?)`
    ).bind(baseId, dueAt, dueAt, dueAt, offsets),
  ]);
}

async function scheduledJobCount(baseId: number, size: number) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM async_jobs
     WHERE kind = 'monitor.check'
       AND CAST(aggregate_id AS INTEGER) BETWEEN ? AND ?`
  )
    .bind(baseId, baseId + size - 1)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function completeScheduledJobs(baseId: number, size: number) {
  await env.DB.prepare(
    `UPDATE async_jobs SET status = 'completed'
     WHERE kind = 'monitor.check'
       AND CAST(aggregate_id AS INTEGER) BETWEEN ? AND ?`
  )
    .bind(baseId, baseId + size - 1)
    .run();
}

describe("monitor scheduler scale and continuation", () => {
  it(
    "schedules 50, 500 and 5000 due monitors inside the configured tick budget",
    async () => {
      const sizes = [50, 500, 5000];
      for (const [index, size] of sizes.entries()) {
        const baseId = 500_000 + index * 10_000;
        await seedDueMonitors(baseId, size);
        const result = await scheduleDueMonitorChecks(
          {
            ...(env as Bindings),
            DATA_COMPATIBILITY_MODE: "contract",
            MONITOR_CHECK_BATCH_SIZE: "100",
            MONITOR_SCHEDULER_TIME_BUDGET_MS: "5000",
          },
          scheduledAt
        );
        expect(result, `scale=${size}`).toMatchObject({
          scheduled: size,
          published: size,
          batches: Math.ceil(size / 100),
          budget_exhausted: false,
        });
        expect(result.duration_ms, `scale=${size}`).toBeLessThan(5_000);
        expect(await scheduledJobCount(baseId, size), `scale=${size}`).toBe(size);
        await completeScheduledJobs(baseId, size);
      }
    },
    60_000
  );

  it("continues from persisted due state after a scheduler budget cutoff", async () => {
    const baseId = 600_000;
    const size = 150;
    await seedDueMonitors(baseId, size);
    let clock = -50;
    const first = await scheduleDueMonitorChecks(
      {
        ...(env as Bindings),
        DATA_COMPATIBILITY_MODE: "contract",
        MONITOR_CHECK_BATCH_SIZE: "100",
        MONITOR_SCHEDULER_TIME_BUDGET_MS: "100",
      },
      scheduledAt,
      { monotonicNow: () => (clock += 50) }
    );
    expect(first).toMatchObject({
      scheduled: 100,
      published: 100,
      batches: 1,
      budget_exhausted: true,
    });

    const second = await scheduleDueMonitorChecks(
      {
        ...(env as Bindings),
        DATA_COMPATIBILITY_MODE: "contract",
        MONITOR_CHECK_BATCH_SIZE: "100",
        MONITOR_SCHEDULER_TIME_BUDGET_MS: "5000",
      },
      scheduledAt
    );
    expect(second).toMatchObject({
      scheduled: 50,
      published: 50,
      batches: 1,
      budget_exhausted: false,
    });
    expect(await scheduledJobCount(baseId, size)).toBe(size);
    await completeScheduledJobs(baseId, size);
  });

  it("retains every Job Ledger entry when Queue batch publication fails", async () => {
    const baseId = 700_000;
    const size = 250;
    await seedDueMonitors(baseId, size);
    const relayed: string[] = [];
    const failingQueue = {
      send: async () => {},
      sendBatch: async () => {
        throw new Error("injected queue timeout");
      },
    } as unknown as Bindings["XUGOU_JOBS"];
    const schedulerEnv = {
      ...(env as Bindings),
      DATA_COMPATIBILITY_MODE: "contract",
      MONITOR_CHECK_BATCH_SIZE: "100",
      MONITOR_SCHEDULER_TIME_BUDGET_MS: "5000",
      XUGOU_JOBS: failingQueue,
    };
    const scheduled = await scheduleDueMonitorChecks(schedulerEnv, scheduledAt);
    expect(scheduled).toMatchObject({
      scheduled: size,
      published: 0,
      batches: 3,
      budget_exhausted: false,
    });
    expect(await scheduledJobCount(baseId, size)).toBe(size);

    const duplicateTick = await scheduleDueMonitorChecks(
      schedulerEnv,
      scheduledAt
    );
    expect(duplicateTick.scheduled).toBe(0);

    const recoveryQueue = {
      send: async () => {},
      sendBatch: async (
        messages: Array<{ body: { kind: string; job_id?: string } }>
      ) => {
        for (const message of messages) {
          if (message.body.kind === "job" && message.body.job_id) {
            relayed.push(message.body.job_id);
          }
        }
      },
    } as unknown as Bindings["XUGOU_JOBS"];
    const relay = await relayPendingQueueWork(
      { ...schedulerEnv, XUGOU_JOBS: recoveryQueue },
      size
    );
    expect(relay.publishedJobs).toBe(size);
    expect(new Set(relayed).size).toBe(size);
    await completeScheduledJobs(baseId, size);
  });
});
