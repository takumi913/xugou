import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { compareSemver } from "../src/utils/agentConfig";

const semverCases = JSON.parse(
  readFileSync(new URL("../../contracts/semver-cases.json", import.meta.url), "utf8")
) as Array<{ a: string; b: string; result: number | null }>;
for (const semverCase of semverCases) {
  assert.equal(compareSemver(semverCase.a, semverCase.b), semverCase.result);
}
import {
  AgentUseCases,
  type AgentRepositoryPort,
} from "../src/modules/agents/application/AgentUseCases";
import type {
  AgentReportCommand,
  AgentView,
} from "../src/modules/agents/domain/models";
import {
  agentV2ImportSchema,
  agentCredentialListQuerySchema,
  agentV2ListQuerySchema,
  agentV2MetricsQuerySchema,
  agentV2OrderSchema,
  agentV2RegistrationSchema,
  agentV2UpdateSchema,
  agentV4ReportSchema,
} from "../src/modules/agents/http/schemas";
import { parseAgentJsonRequest } from "../src/modules/agents/http/routes";
import { isXugouQueueMessage } from "../src/platform/queues/messages";
import {
  streamJsonArrayResponse,
  streamJsonDataArrayResponse,
} from "../src/platform/http/stream-json";

const base: AgentView = {
  id: 1,
  name: "edge-1",
  status: "active",
  hostname: "edge-1",
  ip_addresses: ["192.0.2.1"],
  os: "linux",
  version: "v4.0.0",
  keepalive: "300",
  boot_time: 1_700_000_000,
  collect_interval_seconds: 60,
  report_interval_seconds: 300,
  last_seen_at: "2026-08-01T00:00:00.000Z",
  next_offline_at: "2026-08-01T00:15:00.000Z",
  group_name: null,
  tags: [],
  price: null,
  currency: null,
  billing_cycle: null,
  expire_date: null,
  auto_renewal: false,
  is_hidden: false,
  traffic_limit_gb: null,
  traffic_reset_day: 1,
  traffic_calc_type: "sum",
  auto_update: true,
  region: null,
  geo_latitude: null,
  geo_longitude: null,
  geo_city: null,
  geo_region_name: null,
  sort_order: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};
const rows = [base, { ...base, id: 2, name: "edge-2" }, { ...base, id: 3, name: "edge-3" }];
const published: string[] = [];
const repository: AgentRepositoryPort = {
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
  async update(id, input) {
    const row = rows.find((candidate) => candidate.id === id);
    return row
      ? { ...row, ...input, status: input.status ?? row.status }
      : null;
  },
  async softDelete(id) {
    return rows.some((row) => row.id === id);
  },
  async authenticateCredential({ token }) {
    return token === "valid-token"
      ? {
          id: 1,
          name: "edge-1",
          status: "active",
          collect_interval_seconds: 60,
          report_interval_seconds: 300,
          auto_update: true,
        }
      : null;
  },
};
const useCases = new AgentUseCases(
  repository,
  { async digest(token) { return `digest:${token}`; } },
  { async digest(report) { return `digest:${report.report_id}`; } },
  { async process(agentId, report) { published.push(`agent-report:${report.report_id}`); return { outcome: "completed" }; } },
  { shouldUpdate({ autoUpdate, currentVersion }) {
    return autoUpdate && currentVersion === "v0.2.0";
  } }
);

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
assert.equal(agentV2ListQuerySchema.safeParse({ cursor: "bad" }).success, false);
assert.equal(
  agentCredentialListQuerySchema.safeParse({ cursor: String(Number.MAX_SAFE_INTEGER + 1) }).success,
  false,
  "agent cursor IDs must remain within JavaScript safe integer range"
);
await assert.rejects(
  useCases.update(1, { collect_interval_seconds: 600, report_interval_seconds: 300 }),
  /Report interval/
);

const report: AgentReportCommand = {
  protocol_version: 4,
  agent_version: "v0.2.0",
  report_id: "018f47f2-60e5-7b47-a8ca-58c57e1be5d4",
  hostname: "edge-1",
  samples: [
    {
      collected_at: "2026-08-01T00:00:00.000Z",
      cpu: { usage: 12.5, cores: 4 },
      memory: { usage_rate: 42 },
    },
  ],
};
const accepted = await useCases.acceptReport("valid-token", report);
assert.equal(accepted.accepted, true);
assert.equal(accepted.duplicate, false);
assert.equal(accepted.config.update, true);
assert.deepEqual(published, [`agent-report:${report.report_id}`]);

await assert.rejects(useCases.acceptReport("invalid-token", report), /credential/);

assert.equal(agentV4ReportSchema.safeParse(report).success, true);
assert.equal(
  agentV4ReportSchema.safeParse({ ...report, protocol_version: 3 }).success,
  false
);
assert.equal(
  agentV4ReportSchema.safeParse({ ...report, unexpected: true }).success,
  false
);
assert.equal(
  agentV4ReportSchema.safeParse({ ...report, samples: [] }).success,
  false
);
assert.equal(
  agentV4ReportSchema.safeParse({
    ...report,
    samples: [
      {
        ...report.samples[0],
        disks: [Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`disk_${index}`, 1]))],
      },
    ],
  }).success,
  false,
  "an individual metric map must have a hard property limit"
);
assert.equal(
  agentV4ReportSchema.safeParse({
    ...report,
    samples: [
      {
        ...report.samples[0],
        ping: Object.fromEntries(
          Array.from({ length: 129 }, (_, index) => [`target_${index}`, { latency: 1 }])
        ),
      },
    ],
  }).success,
  false,
  "ping targets must have a hard property limit"
);
assert.equal(
  agentV4ReportSchema.safeParse({
    ...report,
    samples: [{
      ...report.samples[0],
      ping: { bd: { target: "example.test:443", latency_ms: -1, loss: true } },
    }],
  }).success,
  true,
  "ping loss sentinel -1 remains compatible with the Go Agent"
);
for (const field of ["token", "api_key", "access_token", "secret"]) {
  assert.equal(
    agentV4ReportSchema.safeParse({
      ...report,
      samples: [{
        ...report.samples[0],
        disks: [{
          device: "disk",
          mount_point: "/",
          total: 1,
          used: 1,
          free: 0,
          usage_rate: 100,
          fs_type: "fixture",
          [field]: "sensitive",
        }],
      }],
    }).success,
    false,
    `strict disk metric schema must reject ${field}`
  );
}
assert.equal(agentV2ListQuerySchema.safeParse({ limit: 101 }).success, false);
assert.equal(
  agentV2ListQuerySchema.safeParse({ include_latest_metrics: "false" }).data
    ?.include_latest_metrics,
  false
);
assert.equal(agentV2UpdateSchema.safeParse({ tags: ["edge", "prod"] }).success, true);
assert.equal(agentV2UpdateSchema.safeParse({}).success, false);
assert.equal(agentV2OrderSchema.safeParse({ ids: [1, 2] }).success, true);
assert.equal(agentV2OrderSchema.safeParse({ ids: [0] }).success, false);
assert.equal(agentV2MetricsQuerySchema.safeParse({ hours: "168" }).success, true);
assert.equal(agentV2MetricsQuerySchema.safeParse({ hours: "2" }).success, false);
assert.equal(
  agentV2RegistrationSchema.safeParse({
    name: "edge-registration",
    hostname: "edge-1",
    ip_addresses: ["192.0.2.1"],
    os: "linux",
    version: "v0.2.0",
  }).success,
  true
);
assert.equal(
  agentV2RegistrationSchema.safeParse({
    name: "edge-registration",
    token: "credential-must-not-be-in-json",
  }).success,
  false
);
assert.equal(
  agentV2ImportSchema.safeParse([
    {
      name: "v2-agent",
      collect_interval_seconds: 60,
      report_interval_seconds: 300,
      auto_update: true,
      tags: ["edge"],
    },
  ]).success,
  true
);
assert.equal(
  agentV2ImportSchema.safeParse([
    {
      name: "legacy-agent",
      collect_interval: 60,
      report_interval: 300,
      auto_update: 1,
      tags: "edge",
    },
  ]).success,
  true
);

const gzipBody = new Uint8Array(gzipSync(JSON.stringify(report)));
const decodedGzip = await parseAgentJsonRequest(
  new Request("https://xugou.test/api/v2/agents/reports", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Content-Length": String(gzipBody.byteLength),
    },
    body: gzipBody,
  })
);
assert.equal(decodedGzip.ok, true);
if (decodedGzip.ok) assert.deepEqual(decodedGzip.value, report);
assert.equal(
  (
    await parseAgentJsonRequest(
      new Request("https://xugou.test/api/v2/agents/reports", {
        method: "POST",
        headers: { "Content-Encoding": "br" },
        body: "{}",
      })
    )
  ).ok,
  false
);

assert.equal(
  isXugouQueueMessage({ version: 1, kind: "job", job_id: "job-1" }),
  false
);
assert.equal(
  isXugouQueueMessage({ version: 1, kind: "outbox", event_id: "event-1" }),
  true
);
assert.equal(isXugouQueueMessage({ version: 2, kind: "job", job_id: "job-1" }), false);

const exportRows = Array.from({ length: 205 }, (_, index) => ({
  id: index + 1,
  name: `agent-${index + 1}`,
}));
let exportPageCalls = 0;
const streamedExport = streamJsonDataArrayResponse({
  filename: "agents.json",
  async loadPage(cursor?: number) {
    exportPageCalls += 1;
    const start = cursor ?? 0;
    const data = exportRows.slice(start, start + 100);
    const nextCursor = start + data.length;
    return {
      data,
      next_cursor: nextCursor < exportRows.length ? nextCursor : null,
    };
  },
  map: (item) => ({ name: item.name }),
});
assert.equal(
  streamedExport.headers.get("Content-Disposition"),
  'attachment; filename="agents.json"'
);
assert.deepEqual(JSON.parse(await streamedExport.text()), {
  data: exportRows.map((item) => ({ name: item.name })),
});
assert.equal(exportPageCalls, 3);

const legacyStreamedExport = streamJsonArrayResponse({
  filename: "legacy-agents.json",
  async loadPage(cursor?: number) {
    const start = cursor ?? 0;
    const data = exportRows.slice(start, start + 100);
    const nextCursor = start + data.length;
    return {
      data,
      next_cursor: nextCursor < exportRows.length ? nextCursor : null,
    };
  },
  map: (item) => ({ name: item.name }),
});
assert.deepEqual(
  JSON.parse(await legacyStreamedExport.text()),
  exportRows.map((item) => ({ name: item.name }))
);
