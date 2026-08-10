import { ApplicationProblem } from "../../../shared/errors/ApplicationProblem";
import type { MonitorMutation, MonitorView } from "../domain/models";
import {
  decodeOrderedCursor,
  encodeOrderedCursor,
  type OrderedCursor,
} from "../../../shared/pagination/OrderedCursor";

export interface MonitorRepositoryPort {
  listPage(input: { after?: OrderedCursor; limit: number }): Promise<MonitorView[]>;
  findById(id: number): Promise<MonitorView | null>;
  create(input: MonitorMutation): Promise<MonitorView>;
  update(id: number, input: Partial<MonitorMutation>): Promise<MonitorView | null>;
  delete(id: number): Promise<boolean>;
}

export class MonitorUseCases {
  constructor(
    private readonly repository: MonitorRepositoryPort,
    private readonly minimumIntervalSeconds: number
  ) {}

  async list(input: { cursor?: string; limit: number }) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new ApplicationProblem(
        400,
        "MONITOR_LIMIT_INVALID",
        "Invalid monitor page limit"
      );
    }
    const after = input.cursor
      ? decodeOrderedCursor(input.cursor) ?? undefined
      : undefined;
    if (input.cursor && !after) {
      throw new ApplicationProblem(400, "MONITOR_CURSOR_INVALID", "Invalid monitor cursor");
    }
    const rows = await this.repository.listPage({
      after,
      limit: input.limit + 1,
    });
    const hasMore = rows.length > input.limit;
    const data = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      data,
      next_cursor: hasMore
        ? (() => {
            const last = data.at(-1);
            return last
              ? encodeOrderedCursor({ sortOrder: last.sort_order, id: last.id })
              : null;
          })()
        : null,
      has_more: hasMore,
    };
  }

  async get(id: number) {
    const monitor = await this.repository.findById(id);
    if (!monitor) {
      throw new ApplicationProblem(404, "MONITOR_NOT_FOUND", "Monitor not found");
    }
    return monitor;
  }

  async create(input: MonitorMutation) {
    return this.repository.create({
      ...input,
      interval_seconds: Math.max(
        input.interval_seconds,
        this.minimumIntervalSeconds
      ),
    });
  }

  async update(id: number, input: Partial<MonitorMutation>) {
    await this.get(id);
    const updated = await this.repository.update(id, {
      ...input,
      ...(input.interval_seconds === undefined
        ? {}
        : {
            interval_seconds: Math.max(
              input.interval_seconds,
              this.minimumIntervalSeconds
            ),
          }),
    });
    if (!updated) {
      throw new ApplicationProblem(409, "MONITOR_UPDATE_CONFLICT", "Monitor update conflict");
    }
    return updated;
  }

  async delete(id: number) {
    await this.get(id);
    if (!(await this.repository.delete(id))) {
      throw new ApplicationProblem(409, "MONITOR_DELETE_CONFLICT", "Monitor delete conflict");
    }
  }
}
