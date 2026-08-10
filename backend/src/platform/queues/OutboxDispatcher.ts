import type { Bindings } from "../../models/db";
import { NotificationOutboxConsumer } from "../../modules/notifications/queue/NotificationOutboxConsumer";
import { StatusPublicationConsumer } from "../../modules/status/queue/StatusPublicationConsumer";
import type { OutboxConsumer, StoredOutboxEvent } from "./outbox";

export class OutboxDispatcher {
  private readonly registry = new Map<string, OutboxConsumer[]>();

  constructor(private readonly env: Bindings) {
    // 安全公开投影优先提交；通知供应商故障只重试通知 Consumer，不阻塞状态页。
    const consumers: OutboxConsumer[] = [
      new StatusPublicationConsumer(env),
      new NotificationOutboxConsumer(env),
    ];
    for (const consumer of consumers) {
      if (consumer.eventTypes.length === 0) {
        throw new Error(`Outbox consumer ${consumer.consumerName} declares no event types`);
      }
      for (const eventType of consumer.eventTypes) {
        this.registry.set(eventType, [
          ...(this.registry.get(eventType) ?? []),
          consumer,
        ]);
      }
    }
  }

  private async alreadyProcessed(consumer: string, eventId: string) {
    return Boolean(
      await this.env.DB.prepare(
        `SELECT event_id FROM processed_events
         WHERE consumer = ? AND event_id = ? LIMIT 1`
      )
        .bind(consumer, eventId)
        .first<{ event_id: string }>()
    );
  }

  private async markProcessed(consumer: string, eventId: string) {
    const now = new Date().toISOString();
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO processed_events
       (consumer, event_id, processed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(consumer, eventId, now, now, now)
      .run();
  }

  async process(eventId: string) {
    const event = await this.env.DB.prepare(
      `SELECT event_id, event_type, aggregate_type, aggregate_id, payload_json, status
       FROM domain_outbox WHERE event_id = ? LIMIT 1`
    )
      .bind(eventId)
      .first<StoredOutboxEvent>();
    if (!event) return;

    const supported = this.registry.get(event.event_type) ?? [];
    if (supported.length === 0) {
      const now = new Date().toISOString();
      const errorCode = "UNSUPPORTED_OUTBOX_EVENT_TYPE";
      await this.env.DB.prepare(
        `UPDATE domain_outbox
         SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ?
         WHERE event_id = ?`
      )
        .bind(`${errorCode}:${event.event_type}`.slice(0, 2048), now, event.event_id)
        .run();
      const error = new Error(`Unsupported outbox event type: ${event.event_type}`);
      error.name = "PermanentOutboxEventError";
      throw error;
    }
    for (const consumer of supported) {
      if (await this.alreadyProcessed(consumer.consumerName, event.event_id)) continue;
      await consumer.process(event);
      await this.markProcessed(consumer.consumerName, event.event_id);
    }

    const now = new Date().toISOString();
    await this.env.DB.prepare(
      `UPDATE domain_outbox SET status = 'processed', processed_at = COALESCE(processed_at, ?),
       last_error = NULL, updated_at = ? WHERE event_id = ?`
    )
      .bind(now, now, event.event_id)
      .run();
  }
}
