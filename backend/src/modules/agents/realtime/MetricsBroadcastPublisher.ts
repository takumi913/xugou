import type { Bindings } from "../../../models/db";

export async function publishLatestMetrics(
  env: Pick<Bindings, "AGENT_ROOM">,
  agentId: number,
  timestamp: string,
  metrics: Record<string, unknown>
) {
  const namespace = env.AGENT_ROOM;
  if (!namespace) return;
  const ts = Date.parse(timestamp);
  const response = await namespace
    .getByName(String(agentId))
    .fetch("http://internal/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId,
        samples: [
          {
            ts: Number.isFinite(ts) ? ts : Date.now(),
            data: metrics,
          },
        ],
      }),
    });
  if (!response.ok) {
    throw new Error(`Agent room returned ${response.status}`);
  }
}
