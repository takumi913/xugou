import type { Bindings } from "../../../models/db";
import { realtimeRoomName } from "./RealtimeSharding";
import { projectPublicRealtimeMetric } from "../../status/domain/public-contract";

async function publishAgentUpdate(
  env: Pick<Bindings, "AGENT_ROOM">,
  update: {
    agentId: number;
    samples: Array<{
      ts: number;
      data: Record<string, unknown>;
      publicData?: Record<string, unknown>;
    }>;
    status?: "active" | "inactive";
    lastSeenAt?: string | null;
    changedAt?: string;
  }
) {
  const namespace = env.AGENT_ROOM;
  if (!namespace) return;
  const response = await namespace
    .getByName(realtimeRoomName(update.agentId))
    .fetch("http://internal/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
  if (!response.ok) {
    throw new Error(`Agent room returned ${response.status}`);
  }
}

export async function publishLatestMetrics(
  env: Pick<Bindings, "AGENT_ROOM">,
  agentId: number,
  timestamp: string,
  metrics: Record<string, unknown>
) {
  const ts = Date.parse(timestamp);
  await publishAgentUpdate(env, {
    agentId,
    samples: [
      {
        ts: Number.isFinite(ts) ? ts : Date.now(),
        data: metrics,
        publicData: projectPublicRealtimeMetric(metrics),
      },
    ],
    status: "active",
    lastSeenAt: timestamp,
    changedAt: timestamp,
  });
}

export async function publishAgentStatus(
  env: Pick<Bindings, "AGENT_ROOM">,
  agentId: number,
  status: "active" | "inactive",
  changedAt: string,
  lastSeenAt: string | null
) {
  await publishAgentUpdate(env, {
    agentId,
    samples: [],
    status,
    lastSeenAt,
    changedAt,
  });
}
