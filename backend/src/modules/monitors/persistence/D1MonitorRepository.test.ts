import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Bindings } from "../../../models/db";
import {
  createSqliteD1,
  MONITOR_SCHEMA,
  type SqliteD1,
} from "../../../test-utils/sqlite-d1";
import { D1MonitorRepository } from "./D1MonitorRepository";

let sqlite: SqliteD1;
let repository: D1MonitorRepository;

const INPUT = {
  name: "新监控",
  url: "https://example.com",
  method: "GET",
  interval_seconds: 300,
  timeout_ms: 30_000,
  expected_status: 200,
  headers: {},
  body: null,
};

/** 模拟调度器写入一次检查结果——外键指向 monitors(id)，缺锚点就会炸在这里。 */
function insertCheckSample(monitorId: number) {
  sqlite.raw
    .prepare(
      `INSERT INTO monitor_check_samples
       (job_id, monitor_id, scheduled_for_ms, checked_at, status,
        response_time_ms, created_at, updated_at)
       VALUES (?, ?, 0, '2026-08-20T00:00:00.000Z', 'up', 12, '', '')`
    )
    .run(`job-${monitorId}`, monitorId);
}

beforeEach(() => {
  sqlite = createSqliteD1(MONITOR_SCHEMA);
  repository = new D1MonitorRepository({ DB: sqlite.DB } as unknown as Bindings);
});

afterEach(() => {
  sqlite.close();
});

describe("D1MonitorRepository.create", () => {
  it("新建监控后能写入检查样本（monitors 锚点在位）", async () => {
    const view = await repository.create(INPUT);

    expect(() => insertCheckSample(view.id)).not.toThrow();
  });

  it("monitor_definitions 与 monitors 用同一个 id", async () => {
    const view = await repository.create(INPUT);

    const anchor = sqlite.raw
      .prepare(`SELECT id FROM monitors WHERE id = ?`)
      .get(view.id) as { id: number } | undefined;
    const definition = sqlite.raw
      .prepare(`SELECT id, name FROM monitor_definitions WHERE id = ?`)
      .get(view.id) as { id: number; name: string } | undefined;

    expect(anchor?.id).toBe(view.id);
    expect(definition?.name).toBe(INPUT.name);
  });

  it("锚点行不带业务名字，业务字段只落 monitor_definitions", async () => {
    const view = await repository.create(INPUT);

    const anchor = sqlite.raw
      .prepare(`SELECT name, status FROM monitors WHERE id = ?`)
      .get(view.id) as { name: string; status: string };

    expect(anchor.name).not.toBe(INPUT.name);
    expect(anchor.name.startsWith("contract-anchor:")).toBe(true);
    expect(anchor.status).toBe("retired");
  });

  it("连续新建的监控 id 不冲突", async () => {
    const first = await repository.create(INPUT);
    const second = await repository.create({ ...INPUT, name: "另一个监控" });

    expect(second.id).not.toBe(first.id);
    expect(() => insertCheckSample(first.id)).not.toThrow();
    expect(() => insertCheckSample(second.id)).not.toThrow();
  });

  it("monitor_runtime 写失败时锚点一起回滚，不留孤儿", async () => {
    sqlite.raw.exec(`DROP TABLE monitor_runtime`);

    await expect(repository.create(INPUT)).rejects.toThrow();

    const anchors = sqlite.raw
      .prepare(`SELECT COUNT(*) AS count FROM monitors`)
      .get() as { count: number };
    const definitions = sqlite.raw
      .prepare(`SELECT COUNT(*) AS count FROM monitor_definitions`)
      .get() as { count: number };
    expect(anchors.count).toBe(0);
    expect(definitions.count).toBe(0);
  });
});
