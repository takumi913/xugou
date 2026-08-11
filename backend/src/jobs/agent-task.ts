import type { Bindings } from "../models/db";
import { writeStructuredLog } from "../platform/observability/StructuredLogger";
import { QueueJobPublisher } from "../platform/queues/QueuePublisher";
import { getEnvNumber } from "../utils/env";
import { publishAgentStatus } from "../modules/agents/realtime/MetricsBroadcastPublisher";

const DEFAULT_AGENT_OFFLINE_BATCH_SIZE = 50;

interface AgentResult {
  id: number;
  updated_at?: string;
  last_seen_at?: string | null;
  next_offline_at?: string | null;
  updated_at_ms?: number;
  last_seen_at_ms?: number | null;
  next_offline_at_ms?: number | null;
}

/** Cron 只推进离线状态并写 outbox，通知与状态页由 Queue Consumer 处理。 */
export async function checkAgentsStatus(env: Bindings) {
  const batchSize = getEnvNumber(
    env,
    "AGENT_OFFLINE_BATCH_SIZE",
    DEFAULT_AGENT_OFFLINE_BATCH_SIZE,
    { min: 1, max: 500 }
  );
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT node.id, runtime.updated_at_ms, runtime.last_seen_at_ms,
              runtime.next_offline_at_ms
       FROM agent_nodes node
       JOIN agent_runtime runtime ON runtime.agent_id = node.id
       WHERE runtime.status = 'active' AND node.deleted_at_ms IS NULL
         AND runtime.next_offline_at_ms <= ?
       ORDER BY runtime.next_offline_at_ms ASC LIMIT ?`
  )
    .bind(nowMs, batchSize)
    .all<AgentResult>();
  const publisher = new QueueJobPublisher(env.XUGOU_JOBS);

  for (const agent of results) {
    const deadline = String(agent.next_offline_at_ms ?? nowMs);
    const lastSeenAt = new Date(agent.last_seen_at_ms ?? agent.updated_at_ms ?? nowMs).toISOString();
    const eventId = `agent.status.changed:${agent.id}:offline:${deadline}`;
    const statements = [
      env.DB.prepare(
        `INSERT OR IGNORE INTO domain_outbox
         (event_id, event_type, aggregate_type, aggregate_id, payload_json,
          status, attempts, available_at, created_at, updated_at)
         SELECT ?, 'agent.status.changed', 'agent', CAST(runtime.agent_id AS TEXT), ?,
                'pending', 0, ?, ?, ?
         FROM agent_runtime runtime
         JOIN agent_nodes node ON node.id = runtime.agent_id
         WHERE runtime.agent_id = ? AND runtime.status = 'active'
           AND node.deleted_at_ms IS NULL AND runtime.next_offline_at_ms <= ?`
      ).bind(
        eventId,
        JSON.stringify({
          agent_id: agent.id,
          previous_status: "online",
          status: "offline",
          changed_at: now,
          last_seen_at: lastSeenAt,
        }),
        now,
        now,
        now,
        agent.id,
        nowMs
      ),
      env.DB.prepare(
        `UPDATE agent_runtime SET status = 'inactive',
         last_state_changed_at_ms = ?, next_offline_at_ms = NULL,
         version = version + 1, updated_at_ms = ?
         WHERE agent_id = ? AND status = 'active' AND next_offline_at_ms <= ?`
      ).bind(nowMs, nowMs, agent.id, nowMs),
    ];
    const batchResult = await env.DB.batch(statements);
    if (batchResult[1]?.meta.changes === 1) {
      try {
        await publishAgentStatus(env, agent.id, "inactive", now, lastSeenAt);
      } catch (error) {
        writeStructuredLog(env, {
          service: "realtime",
          operation: "publish_agent_offline_status",
          result: "deferred",
          entityType: "agent",
          entityId: agent.id,
          errorCode: "AGENT_OFFLINE_BROADCAST_DEFERRED",
          error,
        });
      }
    }
    const pending = await env.DB.prepare(
      `SELECT event_id FROM domain_outbox
       WHERE event_id = ? AND status = 'pending' LIMIT 1`
    )
      .bind(eventId)
      .first<{ event_id: string }>();
    if (!pending) continue;
    try {
      await publisher.publishOutbox(eventId);
      const publishedAt = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE domain_outbox SET status = 'published', attempts = attempts + 1,
         published_at = ?, last_error = NULL, updated_at = ?
         WHERE event_id = ? AND status = 'pending'`
      )
        .bind(publishedAt, publishedAt, eventId)
        .run();
    } catch (error) {
      writeStructuredLog(env, {
        service: "queue",
        operation: "publish_agent_offline_outbox",
        result: "deferred",
        eventId,
        entityType: "agent",
        entityId: agent.id,
        errorCode: "AGENT_OFFLINE_PUBLISH_DEFERRED",
        error,
      });
    }
  }
  return { checked: results.length };
}

export default {
  async scheduled(
    _event: ScheduledController,
    env: Bindings,
    _ctx: ExecutionContext
  ) {
    return checkAgentsStatus(env);
  },
};
