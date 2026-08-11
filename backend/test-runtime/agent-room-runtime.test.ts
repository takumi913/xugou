import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { Bindings } from "../src/models/db";
import { publishLatestMetrics } from "../src/modules/agents/realtime/MetricsBroadcastPublisher";
import { realtimeRoomName } from "../src/modules/agents/realtime/RealtimeSharding";

interface AgentRoomHealth {
  ok: boolean;
  subscribers: number;
  hasLatestReport: boolean;
}

async function connect(
  stub: DurableObjectStub,
  agentIds: number[],
  scope: "admin" | "public" = "admin"
): Promise<WebSocket> {
  const url = new URL("http://internal/ws");
  url.searchParams.set("agentIds", agentIds.join(","));
  url.searchParams.set("scope", scope);
  const response = await stub.fetch(url, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("Expected WebSocket response");
  socket.accept();
  return socket;
}

async function health(agentId: number): Promise<AgentRoomHealth> {
  const url = new URL("http://internal/health");
  url.searchParams.set("agentId", String(agentId));
  const response = await env.AGENT_ROOM.getByName(realtimeRoomName(agentId)).fetch(
    url
  );
  expect(response.status).toBe(200);
  return response.json<AgentRoomHealth>();
}

describe("sharded Agent Durable Object realtime isolation", () => {
  it("keeps latest report state scoped by Agent inside a shared shard", async () => {
    const firstAgentId = 99101;
    const secondAgentId = firstAgentId + 8;

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
    const stub = env.AGENT_ROOM.getByName(realtimeRoomName(agentId));
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
    const stub = env.AGENT_ROOM.getByName(realtimeRoomName(agentId));
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

  it("multiplexes subscriptions and only delivers matching Agent updates", async () => {
    const firstAgentId = 99201;
    const secondAgentId = firstAgentId + 8;
    const thirdAgentId = firstAgentId + 16;
    const stub = env.AGENT_ROOM.getByName(realtimeRoomName(firstAgentId));
    const subscribed = await connect(stub, [firstAgentId, secondAgentId]);
    const unrelated = await connect(stub, [thirdAgentId]);
    const updateMessage = new Promise<string>((resolve) => {
      subscribed.addEventListener("message", (event) => {
        if (
          typeof event.data === "string" &&
          event.data.includes('"type":"batchUpdate"')
        ) {
          resolve(event.data);
        }
      });
    });

    const response = await stub.fetch("http://internal/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: firstAgentId,
        status: "active",
        lastSeenAt: "2026-08-11T08:00:00.000Z",
        changedAt: "2026-08-11T08:00:00.000Z",
        samples: [{ ts: Date.now(), data: { cpu_usage: 51 } }],
      }),
    });
    expect(await response.json<{ delivered: number }>()).toMatchObject({
      delivered: 1,
    });
    expect(JSON.parse(await updateMessage)).toMatchObject({
      type: "batchUpdate",
      updates: [{ agentId: firstAgentId, status: "active" }],
    });
    subscribed.close(1000, "done");
    unrelated.close(1000, "done");
  });

  it("projects anonymous realtime samples to the public whitelist", async () => {
    const agentId = 99301;
    const stub = env.AGENT_ROOM.getByName(realtimeRoomName(agentId));
    const socket = await connect(stub, [agentId], "public");
    const updateMessage = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => {
        if (
          typeof event.data === "string" &&
          event.data.includes('"type":"batchUpdate"')
        ) {
          resolve(event.data);
        }
      });
    });

    await publishLatestMetrics(
      env as Bindings,
      agentId,
      "2026-08-11T08:00:00.000Z",
      {
        cpu_usage: 27,
        network_rx_speed: 2048,
        threshold_state: { cpu: true },
        ip_addresses: ["192.0.2.10"],
      }
    );
    const message = JSON.parse(await updateMessage) as {
      updates: Array<{ samples: Array<{ data: Record<string, unknown> }> }>;
    };
    const data = message.updates[0].samples[0].data;
    expect(data.cpu_usage).toBe(27);
    expect(data.network_rx_speed).toBe(2048);
    expect(data).not.toHaveProperty("threshold_state");
    expect(data).not.toHaveProperty("ip_addresses");
    socket.close(1000, "done");
  });
});
