import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { Bindings } from "../src/models/db";
import { publishLatestMetrics } from "../src/modules/agents/realtime/MetricsBroadcastPublisher";

interface AgentRoomHealth {
  ok: boolean;
  subscribers: number;
  hasLatestReport: boolean;
}

async function health(agentId: number): Promise<AgentRoomHealth> {
  const response = await env.AGENT_ROOM.getByName(String(agentId)).fetch(
    "http://internal/health"
  );
  expect(response.status).toBe(200);
  return response.json<AgentRoomHealth>();
}

describe("per-Agent Durable Object realtime isolation", () => {
  it("keeps latest report state inside the target Agent room", async () => {
    const firstAgentId = 99101;
    const secondAgentId = 99102;

    await expect(health(firstAgentId)).resolves.toMatchObject({
      hasLatestReport: false,
    });
    await expect(health(secondAgentId)).resolves.toMatchObject({
      hasLatestReport: false,
    });

    await publishLatestMetrics(
      env as Bindings,
      firstAgentId,
      "2026-08-09T08:00:00.000Z",
      { cpu_usage: 42 }
    );

    await expect(health(firstAgentId)).resolves.toMatchObject({
      ok: true,
      hasLatestReport: true,
    });
    await expect(health(secondAgentId)).resolves.toMatchObject({
      ok: true,
      hasLatestReport: false,
    });
  });

  it("rejects malformed room updates without mutating room state", async () => {
    const agentId = 99103;
    const stub = env.AGENT_ROOM.getByName(String(agentId));
    const response = await stub.fetch("http://internal/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, samples: [] }),
    });

    expect(response.status).toBe(400);
    await expect(health(agentId)).resolves.toMatchObject({
      hasLatestReport: false,
    });
  });

  it("rejects oversized internal updates before JSON materialization", async () => {
    const agentId = 99104;
    const stub = env.AGENT_ROOM.getByName(String(agentId));
    const response = await stub.fetch("http://internal/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(256 * 1024 + 1),
      },
      body: "x".repeat(256 * 1024 + 1),
    });

    expect(response.status).toBe(400);
    await expect(health(agentId)).resolves.toMatchObject({
      hasLatestReport: false,
    });
  });
});
