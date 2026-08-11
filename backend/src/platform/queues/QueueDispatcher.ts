import type { Bindings } from "../../models/db";

import { isXugouQueueMessage, type XugouQueueMessage } from "./messages";
import { OutboxDispatcher } from "./OutboxDispatcher";
import { writeStructuredLog } from "../observability/StructuredLogger";

export interface QueueMessageLike {
  readonly id: string;
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueBatchLike {
  readonly queue: string;
  readonly messages: readonly QueueMessageLike[];
}

export async function dispatchQueueBatch(
  batch: QueueBatchLike,
  env: Bindings,
  traceId = crypto.randomUUID()
) {
  const eventConsumer = new OutboxDispatcher(env);

  for (const message of batch.messages) {
    if (!isXugouQueueMessage(message.body)) {
      writeStructuredLog(env, {
        service: "queue",
        operation: "queue_message",
        result: "rejected",
        traceId,
        errorCode: "INVALID_QUEUE_ENVELOPE",
        fields: { queue: batch.queue, message_id: message.id },
      });
      message.ack();
      continue;
    }

    try {
      const body = message.body as XugouQueueMessage;

      await eventConsumer.process(body.event_id);
      message.ack();

      writeStructuredLog(env, {
        service: "queue",
        operation: "queue_message",
        result: "success",
        traceId,
        eventId: body.event_id,
        fields: {
          queue: batch.queue,
          message_id: message.id,
          attempts: message.attempts,
        },
      });
    } catch (error) {
      const body = isXugouQueueMessage(message.body) && message.body.kind === "outbox" ? message.body : undefined;
      if (body) {
        const now = new Date().toISOString();
        const detail = error instanceof Error ? error.message : String(error);
        try {
          await env.DB.prepare(
            `UPDATE domain_outbox SET attempts = attempts + 1, last_error = ?, updated_at = ?
             WHERE event_id = ?`
          )
            .bind(detail.slice(0, 2048), now, body.event_id)
            .run();
        } catch (ledgerError) {
          writeStructuredLog(env, {
            service: "queue",
            operation: "outbox_failure_record",
            result: "failure",
            traceId,
            eventId: body.event_id,
            errorCode: "OUTBOX_FAILURE_RECORD_FAILED",
            error: ledgerError,
            fields: { queue: batch.queue, message_id: message.id },
          });
        }
      }
      writeStructuredLog(env, {
        service: "queue",
        operation: "queue_message",
        result: "failure",
        traceId,
        eventId: body?.event_id,
        errorCode: "QUEUE_MESSAGE_FAILED",
        error,
        fields: {
          queue: batch.queue,
          message_id: message.id,
          attempts: message.attempts,
        },
      });
      if (batch.queue === "xugou-jobs-dlq") {
        message.ack();
      } else {
        message.retry({
          delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)),
        });
      }
    }
  }
}
