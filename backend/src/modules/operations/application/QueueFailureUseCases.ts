import { ApplicationProblem } from "../../../shared/errors/ApplicationProblem";
import type { XugouQueueMessage } from "../../../contracts/queue";
import type { QueueFailureView } from "../domain/models";
import type { QueueLedgerHealth } from "../domain/models";

export interface QueueFailureRepositoryPort {
  listPage(input: {
    afterId?: string;
    status?: string;
    limit: number;
  }): Promise<QueueFailureView[]>;
  findById(id: string): Promise<(QueueFailureView & { message: XugouQueueMessage }) | null>;
  prepareReplay(id: string, now: string): Promise<boolean>;
  markReplayed(id: string, now: string): Promise<void>;
  terminate(id: string, now: string): Promise<boolean>;
  health(now: string): Promise<QueueLedgerHealth>;
}

export interface QueueReplayPublisherPort {
  publish(message: XugouQueueMessage): Promise<void>;
}

export class QueueFailureUseCases {
  constructor(
    private readonly repository: QueueFailureRepositoryPort,
    private readonly publisher: QueueReplayPublisherPort
  ) {}

  async list(input: { cursor?: string; status?: string; limit: number }) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new ApplicationProblem(
        400,
        "QUEUE_FAILURE_LIMIT_INVALID",
        "Invalid queue failure page limit"
      );
    }
    const rows = await this.repository.listPage({
      afterId: input.cursor,
      status: input.status,
      limit: input.limit + 1,
    });
    const hasMore = rows.length > input.limit;
    const data = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      data,
      next_cursor: hasMore ? data.at(-1)?.failure_id ?? null : null,
      has_more: hasMore,
    };
  }

  health() {
    return this.repository.health(new Date().toISOString());
  }

  private async getOpen(id: string) {
    const row = await this.repository.findById(id);
    if (!row) {
      throw new ApplicationProblem(404, "QUEUE_FAILURE_NOT_FOUND", "Queue failure not found");
    }
    if (row.status !== "open") {
      throw new ApplicationProblem(409, "QUEUE_FAILURE_CLOSED", "Queue failure is already closed");
    }
    return row;
  }

  async replay(id: string) {
    const row = await this.getOpen(id);
    const now = new Date().toISOString();
    if (!(await this.repository.prepareReplay(id, now))) {
      throw new ApplicationProblem(409, "QUEUE_REPLAY_CONFLICT", "Queue replay conflict");
    }
    try {
      await this.publisher.publish(row.message);
    } catch (error) {
      throw new ApplicationProblem(503, "QUEUE_REPLAY_UNAVAILABLE", "Queue replay is pending delivery");
    }
    await this.repository.markReplayed(id, now);
    return { failure_id: id, status: "replayed" as const };
  }

  async terminate(id: string) {
    await this.getOpen(id);
    if (!(await this.repository.terminate(id, new Date().toISOString()))) {
      throw new ApplicationProblem(409, "QUEUE_TERMINATE_CONFLICT", "Queue terminate conflict");
    }
  }
}
