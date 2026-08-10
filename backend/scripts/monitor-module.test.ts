import assert from "node:assert/strict";
import {
  MonitorUseCases,
  type MonitorRepositoryPort,
} from "../src/modules/monitors/application/MonitorUseCases";
import type {
  MonitorMutation,
  MonitorView,
} from "../src/modules/monitors/domain/models";
import {
  monitorV2ImportSchema,
  monitorV2DailyStatsQuerySchema,
  monitorV2ListQuerySchema,
  monitorV2MutationSchema,
  monitorV2OrderSchema,
  monitorV2RelatedDataQuerySchema,
} from "../src/modules/monitors/http/schemas";

const base: MonitorView = {
  id: 1,
  name: "API",
  url: "https://example.test/health",
  method: "GET",
  interval_seconds: 300,
  timeout_ms: 1500,
  expected_status: 200,
  headers: {},
  body: null,
  active: true,
  status: "pending",
  response_time_ms: 0,
  last_checked_at: null,
  next_check_at: null,
  sort_order: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};
const rows = Array.from({ length: 3 }, (_, index) => ({
  ...base,
  id: index + 1,
  name: `API ${index + 1}`,
}));
const createdInputs: MonitorMutation[] = [];
const repository: MonitorRepositoryPort = {
  async listPage({ after, limit }) {
    return rows
      .filter(
        (row) =>
          !after ||
          row.sort_order > after.sortOrder ||
          (row.sort_order === after.sortOrder && row.id > after.id)
      )
      .slice(0, limit);
  },
  async findById(id) {
    return rows.find((row) => row.id === id) ?? null;
  },
  async create(input) {
    createdInputs.push(input);
    return { ...base, ...input, id: 4, active: input.active ?? true };
  },
  async update(id, input) {
    const row = rows.find((candidate) => candidate.id === id);
    return row ? { ...row, ...input } : null;
  },
  async delete(id) {
    return rows.some((row) => row.id === id);
  },
};
const useCases = new MonitorUseCases(repository, 300);

assert.deepEqual(await useCases.list({ limit: 2 }), {
  data: rows.slice(0, 2),
  next_cursor: "0:2",
  has_more: true,
});
assert.deepEqual(await useCases.list({ cursor: "0:2", limit: 2 }), {
  data: rows.slice(2),
  next_cursor: null,
  has_more: false,
});
await assert.rejects(useCases.list({ limit: 101 }), /page limit/);
assert.equal(monitorV2ListQuerySchema.safeParse({ cursor: "bad" }).success, false);
assert.equal(
  monitorV2RelatedDataQuerySchema.safeParse({ monitor_id: String(Number.MAX_SAFE_INTEGER + 1) }).success,
  false,
  "cursor IDs must remain within JavaScript safe integer range"
);

await useCases.create({
  name: "new",
  url: "https://new.example",
  method: "GET",
  interval_seconds: 10,
  timeout_ms: 1250,
  expected_status: 200,
  headers: {},
});
assert.equal(createdInputs.at(-1)?.interval_seconds, 300);
assert.equal(createdInputs.at(-1)?.timeout_ms, 1250);
await assert.rejects(useCases.get(99), /Monitor not found/);

assert.equal(
  monitorV2MutationSchema.safeParse({
    name: "API",
    url: "https://example.test",
    method: "GET",
    interval_seconds: 300,
    timeout_ms: 1250,
    expected_status: 200,
    headers: {},
  }).success,
  true
);
assert.equal(
  monitorV2MutationSchema.safeParse({
    name: "API",
    url: "ftp://example.test",
    method: "GET",
    interval_seconds: 300,
    timeout_ms: 1250,
    expected_status: 200,
    headers: {},
  }).success,
  false
);
assert.equal(monitorV2ListQuerySchema.safeParse({ limit: 101 }).success, false);
assert.equal(monitorV2RelatedDataQuerySchema.safeParse({}).success, false);
assert.deepEqual(
  monitorV2DailyStatsQuerySchema.parse({ monitor_id: "1" }),
  { monitor_id: 1, days: 90 }
);
assert.equal(
  monitorV2DailyStatsQuerySchema.safeParse({ monitor_id: 1, days: 367 }).success,
  false
);
assert.equal(
  monitorV2OrderSchema.safeParse({ ids: [1, 2, 3] }).success,
  true
);
assert.equal(
  monitorV2OrderSchema.safeParse({ ids: [1, 0] }).success,
  false
);
assert.equal(
  monitorV2ImportSchema.safeParse([
    {
      name: "v2 export",
      url: "https://example.test/health",
      method: "GET",
      interval_seconds: 300,
      timeout_ms: 1500,
      expected_status: 200,
      headers: {},
      sort_order: 1,
    },
  ]).success,
  true
);
assert.equal(
  monitorV2ImportSchema.safeParse([
    {
      name: "legacy export",
      url: "https://example.test/health",
      method: "GET",
      interval: 300,
      timeout: 30,
      expected_status: 200,
      headers: {},
    },
  ]).success,
  true
);
