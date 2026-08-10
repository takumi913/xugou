import assert from "node:assert/strict";
import { adaptLegacyAgentReport } from "../src/modules/agents/http/LegacyAgentReportAdapter";

const payload = {
  token: "legacy-agent-token",
  hostname: "legacy-edge",
  ip_addresses: ["192.0.2.8"],
  os: "linux",
  version: "v0.1.9",
  keepalive: "300",
  samples: [
    {
      ts: Date.parse("2026-08-01T00:00:00.000Z"),
      cpu: { usage: 101, cores: 4 },
      memory: { usage_rate: 45 },
      disks: [{ device: "/dev/vda", usage_rate: 70, nested: { ignored: true } }],
    },
  ],
};

const first = await adaptLegacyAgentReport(
  payload,
  "v0.1.9",
  new Date("2026-08-01T00:01:00.000Z")
);
const retry = await adaptLegacyAgentReport(
  structuredClone(payload),
  "v0.1.9",
  new Date("2026-08-01T00:04:59.000Z")
);
assert.equal(first.report.report_id, retry.report.report_id);
assert.equal(first.report.protocol_version, 4);
assert.equal(first.report.samples[0].cpu?.usage, 100);
assert.equal(first.report.samples[0].collected_at, "2026-08-01T00:00:00.000Z");
assert.equal(JSON.stringify(first.report).includes(payload.token), false);
assert.deepEqual(first.report.samples[0].disks?.[0], {
  device: "/dev/vda",
  usage_rate: 70,
});

const otherCredential = await adaptLegacyAgentReport(
  { ...payload, token: "another-legacy-token" },
  "v0.1.9",
  new Date("2026-08-01T00:01:00.000Z")
);
assert.notEqual(first.report.report_id, otherCredential.report.report_id);

const withoutTimestamp = { ...payload, samples: undefined, cpu: { usage: 40 } };
const sameWindow = await adaptLegacyAgentReport(
  withoutTimestamp,
  null,
  new Date("2026-08-01T00:03:00.000Z")
);
const nextWindow = await adaptLegacyAgentReport(
  withoutTimestamp,
  null,
  new Date("2026-08-01T00:06:00.000Z")
);
assert.notEqual(sameWindow.report.report_id, nextWindow.report.report_id);
