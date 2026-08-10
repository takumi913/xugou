import type { JobPublisherPort } from "../../modules/agents/application/AgentUseCases";
import {
  QUEUE_MESSAGE_VERSION,
  type XugouQueueMessage,
} from "./messages";

export class QueueJobPublisher implements JobPublisherPort {
  constructor(
    private readonly queue: Cloudflare.Env["XUGOU_JOBS"]
  ) {}

  async publishJob(jobId: string) {
    await this.queue.send({
      version: QUEUE_MESSAGE_VERSION,
      kind: "job",
      job_id: jobId,
    });
  }

  async publishJobs(jobIds: string[]) {
    if (jobIds.length === 0) return;
    await this.queue.sendBatch(
      jobIds.map((jobId) => ({
        body: {
          version: QUEUE_MESSAGE_VERSION,
          kind: "job" as const,
          job_id: jobId,
        },
      }))
    );
  }

  async publishOutbox(eventId: string) {
    await this.queue.send({
      version: QUEUE_MESSAGE_VERSION,
      kind: "outbox",
      event_id: eventId,
    });
  }

  async publishOutboxEvents(eventIds: string[]) {
    if (eventIds.length === 0) return;
    await this.queue.sendBatch(
      eventIds.map((eventId) => ({
        body: {
          version: QUEUE_MESSAGE_VERSION,
          kind: "outbox" as const,
          event_id: eventId,
        },
      }))
    );
  }
}
