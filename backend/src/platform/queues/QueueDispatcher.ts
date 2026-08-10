import type { Bindings } from "../../models/db";
import {
  AgentReportProcessor,
} from "../../modules/agents/queue/AgentReportProcessor";
import { isXugouQueueMessage, type XugouQueueMessage } from "./messages";
import { MonitorCheckProcessor } from "../../modules/monitors/queue/MonitorCheckProcessor";
import { OutboxDispatcher } from "./OutboxDispatcher";
import { captureDeadLetters } from "./DlqHandler";
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
  if (batch.queue === "xugou-jobs-dlq") {
    await captureDeadLetters(batch, env);
    return;
  }
  const reportProcessor = new AgentReportProcessor(env);
  const monitorProcessor = new MonitorCheckProcessor(env);
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
      const body: XugouQueueMessage = message.body;
      let logResult: "success" | "deferred" = "success";
      if (body.kind === "job") {
        const storedJob = await env.DB.prepare(
          `SELECT kind FROM async_jobs WHERE id = ? LIMIT 1`
        )
          .bind(body.job_id)
          .first<{ kind: string }>();
        if (!storedJob) {
          // Queue 可能晚于作业清理到达；没有事实行时直接确认，避免无意义重试。
          message.ack();
          continue;
        }
        const result =
          storedJob.kind === "monitor.check"
            ? await monitorProcessor.process(body.job_id)
            : storedJob.kind === "agent.report.process"
              ? await reportProcessor.process(body.job_id)
              : await markUnsupportedJob(env, body.job_id, storedJob.kind);
        if (result.outcome === "retry") {
          message.retry({ delaySeconds: result.delaySeconds });
          logResult = "deferred";
        } else {
          message.ack();
        }
      } else {
        await eventConsumer.process(body.event_id);
        message.ack();
      }
      writeStructuredLog(env, {
        service: "queue",
        operation: "queue_message",
        result: logResult,
        traceId,
        jobId: body.kind === "job" ? body.job_id : undefined,
        eventId: body.kind === "outbox" ? body.event_id : undefined,
        fields: {
          queue: batch.queue,
          message_id: message.id,
          attempts: message.attempts,
        },
      });
    } catch (error) {
      const body = isXugouQueueMessage(message.body) ? message.body : undefined;
      if (body) {
        const now = new Date().toISOString();
        const detail = error instanceof Error ? error.message : String(error);
        try {
          if (body.kind === "job") {
            await env.DB.prepare(
              `UPDATE async_jobs SET last_error = ?, updated_at = ? WHERE id = ?`
            )
              .bind(detail.slice(0, 2048), now, body.job_id)
              .run();
          } else {
            await env.DB.prepare(
              `UPDATE domain_outbox SET attempts = attempts + 1, last_error = ?, updated_at = ?
               WHERE event_id = ?`
            )
              .bind(detail.slice(0, 2048), now, body.event_id)
              .run();
          }
        } catch (ledgerError) {
          // D1 维护窗口可能同时影响业务处理与失败原因回写；回写失败不应
          // 打断显式退避，否则平台会按批次异常快速重试并提前送入 DLQ。
          writeStructuredLog(env, {
            service: "queue",
            operation: "queue_failure_ledger",
            result: "failure",
            traceId,
            jobId: body.kind === "job" ? body.job_id : undefined,
            eventId: body.kind === "outbox" ? body.event_id : undefined,
            errorCode: "QUEUE_FAILURE_LEDGER_WRITE_FAILED",
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
        jobId: body?.kind === "job" ? body.job_id : undefined,
        eventId: body?.kind === "outbox" ? body.event_id : undefined,
        errorCode: "QUEUE_MESSAGE_FAILED",
        error,
        fields: {
          queue: batch.queue,
          message_id: message.id,
          attempts: message.attempts,
        },
      });
      message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) });
    }
  }
}

async function markUnsupportedJob(
  env: Bindings,
  jobId: string,
  kind: string
): Promise<{ outcome: "ignored" }> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE async_jobs
     SET status = 'failed', last_error = ?, completed_at = COALESCE(completed_at, ?),
         lease_token = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND status IN ('pending', 'retry', 'processing')`
  )
    .bind(`Unsupported queue job kind: ${kind}`.slice(0, 2048), now, now, jobId)
    .run();
  return { outcome: "ignored" };
}
