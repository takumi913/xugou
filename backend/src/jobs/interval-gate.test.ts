import { beforeEach, describe, expect, it } from "vitest";

import type { Bindings } from "../models/db";
import { createSqliteD1, type SqliteD1 } from "../test-utils/sqlite-d1";
import { claimIntervalRun } from "./interval-gate";

const KEY = "jobs.test.last_run_at_ms";
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 7, 19, 9, 0, 0);

let sqlite: SqliteD1;
let env: Bindings;

beforeEach(() => {
  sqlite = createSqliteD1(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  env = { DB: sqlite.DB } as unknown as Bindings;
});

describe("claimIntervalRun", () => {
  it("首次总是领取，并记下领取时刻", async () => {
    expect(await claimIntervalRun(env, KEY, HOUR, T0)).toBe(true);
    const row = sqlite.raw
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(KEY) as { value: string };
    expect(row.value).toBe(String(T0));
  });

  it("间隔内的重复调用领不到", async () => {
    expect(await claimIntervalRun(env, KEY, HOUR, T0)).toBe(true);
    expect(await claimIntervalRun(env, KEY, HOUR, T0 + 60_000)).toBe(false);
    expect(await claimIntervalRun(env, KEY, HOUR, T0 + HOUR - 1)).toBe(false);
  });

  it("满一个间隔后重新领取", async () => {
    await claimIntervalRun(env, KEY, HOUR, T0);
    expect(await claimIntervalRun(env, KEY, HOUR, T0 + HOUR)).toBe(true);
  });

  it("cron 漏跑数小时后照样领取，不会因错过某一分钟而整天不跑", async () => {
    await claimIntervalRun(env, KEY, 24 * HOUR, T0);
    // 下一次触发晚了 31 小时（Cloudflare cron 不保证准点）
    expect(await claimIntervalRun(env, KEY, 24 * HOUR, T0 + 31 * HOUR)).toBe(true);
  });

  it("并发的两次触发只有一次领到", async () => {
    const [first, second] = [
      await claimIntervalRun(env, KEY, HOUR, T0),
      await claimIntervalRun(env, KEY, HOUR, T0),
    ];
    expect([first, second]).toEqual([true, false]);
  });

  it("残留的非数字取值不会把任务永久锁住", async () => {
    sqlite.raw
      .prepare(`INSERT INTO settings (key, value) VALUES (?, 'not-a-number')`)
      .run(KEY);
    expect(await claimIntervalRun(env, KEY, HOUR, T0)).toBe(true);
  });

  it("不同任务各自独立计时", async () => {
    expect(await claimIntervalRun(env, "jobs.a", HOUR, T0)).toBe(true);
    expect(await claimIntervalRun(env, "jobs.b", HOUR, T0)).toBe(true);
    expect(await claimIntervalRun(env, "jobs.a", HOUR, T0)).toBe(false);
  });
});
