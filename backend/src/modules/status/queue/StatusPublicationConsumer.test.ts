import { beforeEach, afterEach, describe, expect, it } from "vitest";

import type { Bindings } from "../../../models/db";
import {
  createSqliteD1,
  STATUS_PUBLICATION_SCHEMA,
  type SqliteD1,
} from "../../../test-utils/sqlite-d1";
import { pruneSupersededPublications } from "./StatusPublicationConsumer";

const NOW_MS = Date.UTC(2026, 7, 20, 12, 0, 0);

let sqlite: SqliteD1;
let env: Bindings;

/** 插入一条发布 + 它的 agent 指标快照，返回发布 id。 */
function insertPublication(options: {
  generatedAtMs: number;
  agentIds?: number[];
}) {
  const iso = new Date(options.generatedAtMs).toISOString();
  sqlite.raw
    .prepare(
      `INSERT INTO status_publications
       (source_event_id, payload_json, etag, generated_at, created_at, updated_at)
       VALUES (?, '{}', '"etag"', ?, ?, ?)`
    )
    .run(`event-${options.generatedAtMs}`, iso, iso, iso);
  const id = Number(
    (
      sqlite.raw.prepare(`SELECT last_insert_rowid() AS id`).get() as {
        id: number;
      }
    ).id
  );
  for (const agentId of options.agentIds ?? [38]) {
    sqlite.raw
      .prepare(
        `INSERT INTO status_metric_publications
         (status_publication_id, agent_id, payload_json, etag, generated_at,
          created_at, updated_at)
         VALUES (?, ?, '{"success":true,"agent":[]}', '"etag"', ?, ?, ?)`
      )
      .run(id, agentId, iso, iso, iso);
  }
  return id;
}

function remainingPublicationIds() {
  return (
    sqlite.raw
      .prepare(`SELECT id FROM status_publications ORDER BY id ASC`)
      .all() as { id: number }[]
  ).map((row) => Number(row.id));
}

function remainingMetricPublicationIds() {
  return (
    sqlite.raw
      .prepare(
        `SELECT status_publication_id AS id FROM status_metric_publications
         ORDER BY id ASC`
      )
      .all() as { id: number }[]
  ).map((row) => Number(row.id));
}

beforeEach(() => {
  sqlite = createSqliteD1(STATUS_PUBLICATION_SCHEMA);
  env = { DB: sqlite.DB } as unknown as Bindings;
});

afterEach(() => {
  sqlite.close();
});

describe("pruneSupersededPublications", () => {
  it("删掉被顶下去的发布，连同它的 agent 指标快照", async () => {
    const stale = insertPublication({
      generatedAtMs: NOW_MS - 60 * 60_000,
      agentIds: [38, 39],
    });
    const active = insertPublication({ generatedAtMs: NOW_MS });

    const result = await pruneSupersededPublications(env, active, NOW_MS);

    expect(result.deleted).toBe(1);
    expect(remainingPublicationIds()).toEqual([active]);
    // 两行指标快照跟着父行一起走，不能只删父表留下孤儿。
    expect(remainingMetricPublicationIds()).toEqual([active]);
    expect(remainingMetricPublicationIds()).not.toContain(stale);
  });

  it("永远不删当前 active，哪怕它比宽限期还老", async () => {
    const active = insertPublication({ generatedAtMs: NOW_MS - 24 * 3600_000 });

    const result = await pruneSupersededPublications(env, active, NOW_MS);

    expect(result.deleted).toBe(0);
    expect(remainingPublicationIds()).toEqual([active]);
  });

  it("宽限期内的非活跃发布留着，保护还没切 active 的并发发布", async () => {
    // 另一个消费者刚插进来、尚未切 active 的发布：删了它，等它切过去就 JOIN 落空。
    const inflight = insertPublication({ generatedAtMs: NOW_MS - 60_000 });
    const active = insertPublication({ generatedAtMs: NOW_MS });

    const result = await pruneSupersededPublications(env, active, NOW_MS);

    expect(result.deleted).toBe(0);
    expect(remainingPublicationIds()).toEqual([inflight, active]);
  });

  it("宽限期可由 STATUS_PUBLICATION_GRACE_MINUTES 调整", async () => {
    const older = insertPublication({ generatedAtMs: NOW_MS - 5 * 60_000 });
    const active = insertPublication({ generatedAtMs: NOW_MS });
    const tightEnv = {
      DB: sqlite.DB,
      STATUS_PUBLICATION_GRACE_MINUTES: "1",
    } as unknown as Bindings;

    const result = await pruneSupersededPublications(tightEnv, active, NOW_MS);

    expect(result.deleted).toBe(1);
    expect(remainingPublicationIds()).toEqual([active]);
    expect(remainingMetricPublicationIds()).not.toContain(older);
  });

  it("一次调用清掉攒下的整批历史发布", async () => {
    const stale = Array.from({ length: 12 }, (_, index) =>
      insertPublication({ generatedAtMs: NOW_MS - (index + 1) * 3600_000 })
    );
    const active = insertPublication({ generatedAtMs: NOW_MS });

    const result = await pruneSupersededPublications(env, active, NOW_MS);

    expect(result.deleted).toBe(stale.length);
    expect(remainingPublicationIds()).toEqual([active]);
    expect(remainingMetricPublicationIds()).toEqual([active]);
  });
});
