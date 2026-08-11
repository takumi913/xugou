import {
  QUEUE_MESSAGE_VERSION,
  type XugouQueueMessage,
} from "./messages";

export class QueueJobPublisher {
  constructor(
    private readonly queue: Cloudflare.Env["XUGOU_JOBS"]
  ) {}

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
