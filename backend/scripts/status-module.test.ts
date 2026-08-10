import assert from "node:assert/strict";
import {
  StatusUseCases,
  type StatusRepositoryPort,
} from "../src/modules/status/application/StatusUseCases";

let saved: unknown;
const repository: StatusRepositoryPort = {
  async getConfig() {
    return { title: "Fixture", monitors: [], agents: [] };
  },
  async saveConfig(input) {
    saved = input;
    return { success: true };
  },
  async getActivePublication() {
    return {
      payloadJson: '{"title":"Published"}',
      etag: '"sha256-fixture"',
      generatedAt: "2026-08-02T00:00:00.000Z",
    };
  },
  async getActiveMetricPublication(agentId) {
    return agentId === 1
      ? {
          agentId,
          payloadJson: '{"success":true,"agent":[{"agent_id":1}]}',
          etag: '"sha256-metric"',
          generatedAt: "2026-08-02T00:00:00.000Z",
        }
      : null;
  },
};
const useCases = new StatusUseCases(repository);
assert.deepEqual(await useCases.getConfig(), {
  title: "Fixture",
  monitors: [],
  agents: [],
});
await useCases.saveConfig({
  title: "Status",
  description: "Fixture",
  logoUrl: "",
  customCss: "",
  theme: "mono",
  monitors: [1],
  agents: [1],
});
assert.deepEqual((saved as { monitors: number[] }).monitors, [1]);
await assert.rejects(
  useCases.saveConfig({
    title: "Status",
    description: "Fixture",
    logoUrl: "",
    customCss: "",
    theme: "mono",
    monitors: [1, 1],
    agents: [],
  }),
  /unique and at most 100/
);
assert.equal((await useCases.getPublicData()).etag, '"sha256-fixture"');
assert.equal((await useCases.getPublicAgentMetrics(1)).etag, '"sha256-metric"');
await assert.rejects(useCases.getPublicAgentMetrics(2), /not found/);
