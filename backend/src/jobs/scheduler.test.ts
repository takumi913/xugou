import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bindings } from "../models/db";
import { createSqliteD1, type SqliteD1 } from "../test-utils/sqlite-d1";
// vi.mock 由 vitest 提升到 import 之前执行，所以下面的静态导入拿到的已是替身模块。
import { runScheduledTasks } from "./index";

const monitorScheduled = vi.fn(async () => ({ success: true }));
const agentScheduled = vi.fn(async () => ({ success: true }));
const checkExpiringAgents = vi.fn(async () => ({ renewed: 0, notified: 0 }));

vi.mock("./monitor-task", () => ({
  default: { scheduled: (...args: unknown[]) => monitorScheduled(...(args as [])) },
}));
vi.mock("./agent-task", () => ({
  default: { scheduled: (...args: unknown[]) => agentScheduled(...(args as [])) },
}));
vi.mock("./expiry-task", () => ({
  checkExpiringAgents: (...args: unknown[]) => checkExpiringAgents(...(args as [])),
}));
vi.mock(
  "../modules/notifications/persistence/NotificationSecretMaintenance",
  () => ({
    rotateNotificationSecretKek: vi.fn(async () => ({
      rotated: 0,
      remaining: 0,
      targetKeyVersion: 1,
    })),
  })
);
vi.mock("../platform/security/SecurityStore", () => ({
  deleteOldSecurityAuditEvents: vi.fn(async () => undefined),
  deleteStaleSecurityRateLimits: vi.fn(async () => undefined),
  writeSecurityAuditEvent: vi.fn(async () => undefined),
}));

/** cleanupOldRecords 与块保留策略实际触碰到的表。 */
const CLEANUP_SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE admin_sessions (id INTEGER PRIMARY KEY, expires_at TEXT);
CREATE TABLE monitor_check_rollups (
  id INTEGER PRIMARY KEY, bucket_start TEXT, bucket_size_seconds INTEGER);
CREATE TABLE monitor_incidents (
  id INTEGER PRIMARY KEY, started_at TEXT, ended_at TEXT);
CREATE TABLE monitor_check_samples (id INTEGER PRIMARY KEY, checked_at TEXT);
CREATE TABLE processed_events (id INTEGER PRIMARY KEY, processed_at TEXT);
CREATE TABLE notification_events (
  id INTEGER PRIMARY KEY, updated_at TEXT, status TEXT);
CREATE TABLE status_publications (id INTEGER PRIMARY KEY, generated_at TEXT);
CREATE TABLE status_publication_state (
  id INTEGER PRIMARY KEY, active_publication_id INTEGER);
CREATE TABLE agent_metric_blocks (
  id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, resolution INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL, point_count INTEGER NOT NULL, codec INTEGER NOT NULL,
  byte_size INTEGER NOT NULL, data BLOB NOT NULL);
CREATE UNIQUE INDEX agent_metric_blocks_key_idx
  ON agent_metric_blocks (agent_id, resolution, bucket_start);
`;

const NOW_MS = Date.UTC(2026, 7, 19, 3, 17, 0);

let sqlite: SqliteD1;
let env: Bindings;

const tick = (scheduledTime = NOW_MS) =>
  ({ scheduledTime, cron: "* * * * *", noRetry: () => {} }) as ScheduledController;
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function cleanupRan() {
  const row = sqlite.raw
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get("jobs.cleanup_old_records.last_run_at_ms") as { value: string } | undefined;
  return row?.value ?? null;
}

function staleSessionCount() {
  const row = sqlite.raw
    .prepare(`SELECT COUNT(*) AS n FROM admin_sessions`)
    .get() as { n: number };
  return Number(row.n);
}

beforeEach(() => {
  vi.clearAllMocks();
  monitorScheduled.mockResolvedValue({ success: true });
  agentScheduled.mockResolvedValue({ success: true });
  checkExpiringAgents.mockResolvedValue({ renewed: 0, notified: 0 });
  sqlite = createSqliteD1(CLEANUP_SCHEMA);
  sqlite.raw
    .prepare(`INSERT INTO admin_sessions (id, expires_at) VALUES (1, '2020-01-01T00:00:00.000Z')`)
    .run();
  env = { DB: sqlite.DB } as unknown as Bindings;
});

describe("runScheduledTasks 异常隔离", () => {
  it("正常一轮：清理先跑，随后监控与 agent 任务各跑一次", async () => {
    await runScheduledTasks(tick(), env, ctx);

    expect(cleanupRan()).toBe(String(NOW_MS));
    expect(staleSessionCount()).toBe(0);
    expect(monitorScheduled).toHaveBeenCalledTimes(1);
    expect(agentScheduled).toHaveBeenCalledTimes(1);
    expect(checkExpiringAgents).toHaveBeenCalledTimes(1);
  });

  it("monitorTask 抛异常不阻断清理与后续任务（库满自锁循环的回归）", async () => {
    monitorScheduled.mockRejectedValue(
      new Error("D1_ERROR: Exceeded maximum DB size")
    );

    await expect(runScheduledTasks(tick(), env, ctx)).rejects.toThrow(
      /scheduled tasks failed/
    );

    // 关键断言：清理在 monitorTask 之前执行，因此库满时清理仍然发生
    expect(cleanupRan()).toBe(String(NOW_MS));
    expect(staleSessionCount()).toBe(0);
    // 后续任务也不受前面失败的影响
    expect(agentScheduled).toHaveBeenCalledTimes(1);
    expect(checkExpiringAgents).toHaveBeenCalledTimes(1);
  });

  it("agentTask 抛异常不影响到期检测", async () => {
    agentScheduled.mockRejectedValue(new Error("boom"));

    await expect(runScheduledTasks(tick(), env, ctx)).rejects.toThrow(
      /scheduled tasks failed/
    );

    expect(monitorScheduled).toHaveBeenCalledTimes(1);
    expect(checkExpiringAgents).toHaveBeenCalledTimes(1);
  });

  it("清理任务自身失败也不阻断监控与 agent 任务", async () => {
    sqlite.raw.exec(`DROP TABLE admin_sessions`);

    await expect(runScheduledTasks(tick(), env, ctx)).rejects.toThrow(
      /scheduled tasks failed/
    );

    expect(monitorScheduled).toHaveBeenCalledTimes(1);
    expect(agentScheduled).toHaveBeenCalledTimes(1);
    expect(checkExpiringAgents).toHaveBeenCalledTimes(1);
  });

  it("全部成功时不抛异常", async () => {
    await expect(runScheduledTasks(tick(), env, ctx)).resolves.toBeUndefined();
  });
});

describe("清理任务的执行窗口", () => {
  it("不再绑定 UTC 00:30：任意一分钟触发都会跑第一次", async () => {
    await runScheduledTasks(tick(Date.UTC(2026, 7, 19, 17, 43, 0)), env, ctx);
    expect(cleanupRan()).toBe(String(Date.UTC(2026, 7, 19, 17, 43, 0)));
  });

  it("一天之内的后续 tick 不重复清理，超过一天后再次执行", async () => {
    await runScheduledTasks(tick(NOW_MS), env, ctx);
    sqlite.raw
      .prepare(`INSERT INTO admin_sessions (id, expires_at) VALUES (2, '2020-01-01T00:00:00.000Z')`)
      .run();

    // 一分钟后：领取失败，清理不执行，过期会话仍在
    await runScheduledTasks(tick(NOW_MS + 60_000), env, ctx);
    expect(cleanupRan()).toBe(String(NOW_MS));
    expect(staleSessionCount()).toBe(1);

    // 超过 24 小时：重新领取并清理
    const nextDay = NOW_MS + 25 * 60 * 60 * 1000;
    await runScheduledTasks(tick(nextDay), env, ctx);
    expect(cleanupRan()).toBe(String(nextDay));
    expect(staleSessionCount()).toBe(0);
  });
});
