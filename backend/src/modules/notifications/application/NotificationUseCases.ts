import { ApplicationProblem } from "../../../shared/errors/ApplicationProblem";
import type {
  NotificationChannelCommand,
  NotificationChannelMutation,
  NotificationSettingCommand,
  NotificationTemplateCommand,
  NotificationResourceSettingView,
  NotificationResourceTarget,
} from "../domain/models";
import {
  decodeOrderedCursor,
  encodeOrderedCursor,
  type OrderedCursor,
} from "../../../shared/pagination/OrderedCursor";

interface MutationResult {
  success: boolean;
  id?: number;
  message?: string;
  error?: string;
}

interface BulkMutationResult extends MutationResult {
  ids?: number[];
  replayed?: boolean;
  errors?: Record<string, string[]>;
}

export interface NotificationRepositoryPort {
  getConfig(): Promise<unknown>;
  listChannels(): Promise<unknown[]>;
  getChannel(id: number): Promise<Record<string, unknown> | null>;
  prepareChannelConfig(id: number, type: string, config: unknown): Promise<unknown | null>;
  createChannel(input: NotificationChannelCommand): Promise<MutationResult>;
  updateChannel(id: number, input: NotificationChannelMutation): Promise<MutationResult>;
  deleteChannel(id: number): Promise<MutationResult>;
  testChannel(id: number): Promise<MutationResult>;
  listTemplates(): Promise<unknown[]>;
  getTemplate(id: number): Promise<Record<string, unknown> | null>;
  createTemplate(input: NotificationTemplateCommand): Promise<MutationResult>;
  updateTemplate(id: number, input: Partial<NotificationTemplateCommand>): Promise<MutationResult>;
  deleteTemplate(id: number): Promise<MutationResult>;
  saveSetting(input: NotificationSettingCommand): Promise<MutationResult>;
  saveSettingsBulk(
    inputs: NotificationSettingCommand[],
    idempotencyKey: string,
    requestHash: string
  ): Promise<BulkMutationResult>;
  listResourceSettings(input: {
    targetType: NotificationResourceTarget;
    after?: OrderedCursor;
    limit: number;
  }): Promise<NotificationResourceSettingView[]>;
  listHistory(input: {
    beforeId?: number;
    type?: string;
    targetId?: number;
    status?: string;
    limit: number;
  }): Promise<Array<Record<string, unknown> & { id: number }>>;
}

function failed<T extends MutationResult>(result: T, code: string, fallback: string): T {
  if (result.success) return result;
  const message = result.message ?? result.error ?? fallback;
  const status = message.includes("不存在")
    ? 404
    : message.includes("上限") || message.includes("幂等键")
      ? 409
      : 500;
  throw new ApplicationProblem(status, code, message);
}

export class NotificationUseCases {
  constructor(private readonly repository: NotificationRepositoryPort) {}

  getConfig() {
    return this.repository.getConfig();
  }
  listChannels() {
    return this.repository.listChannels();
  }
  async getChannel(id: number) {
    const row = await this.repository.getChannel(id);
    if (!row) throw new ApplicationProblem(404, "CHANNEL_NOT_FOUND", "Notification channel not found");
    return row;
  }
  prepareChannelConfig(id: number, type: string, config: unknown) {
    return this.repository.prepareChannelConfig(id, type, config);
  }
  async createChannel(input: NotificationChannelCommand) {
    return failed(await this.repository.createChannel(input), "CHANNEL_CREATE_FAILED", "Notification channel creation failed");
  }
  async updateChannel(id: number, input: NotificationChannelMutation) {
    return failed(await this.repository.updateChannel(id, input), "CHANNEL_UPDATE_FAILED", "Notification channel update failed");
  }
  async deleteChannel(id: number) {
    return failed(await this.repository.deleteChannel(id), "CHANNEL_DELETE_FAILED", "Notification channel deletion failed");
  }
  async testChannel(id: number) {
    return failed(await this.repository.testChannel(id), "CHANNEL_TEST_FAILED", "Notification channel test failed");
  }
  listTemplates() {
    return this.repository.listTemplates();
  }
  async getTemplate(id: number) {
    const row = await this.repository.getTemplate(id);
    if (!row) throw new ApplicationProblem(404, "TEMPLATE_NOT_FOUND", "Notification template not found");
    return row;
  }
  async createTemplate(input: NotificationTemplateCommand) {
    return failed(await this.repository.createTemplate(input), "TEMPLATE_CREATE_FAILED", "Notification template creation failed");
  }
  async updateTemplate(id: number, input: Partial<NotificationTemplateCommand>) {
    return failed(await this.repository.updateTemplate(id, input), "TEMPLATE_UPDATE_FAILED", "Notification template update failed");
  }
  async deleteTemplate(id: number) {
    return failed(await this.repository.deleteTemplate(id), "TEMPLATE_DELETE_FAILED", "Notification template deletion failed");
  }
  async saveSetting(input: NotificationSettingCommand) {
    return failed(await this.repository.saveSetting(input), "SETTING_SAVE_FAILED", "Notification setting save failed");
  }
  async saveSettingsBulk(
    inputs: NotificationSettingCommand[],
    idempotencyKey: string,
    requestHash: string
  ) {
    const result = await this.repository.saveSettingsBulk(
      inputs,
      idempotencyKey,
      requestHash
    );
    if (!result.success && result.errors) {
      throw new ApplicationProblem(
        400,
        "SETTING_BULK_VALIDATION_FAILED",
        "Notification settings validation failed",
        result.message,
        result.errors
      );
    }
    return failed(
      result,
      "SETTING_BULK_SAVE_FAILED",
      "Notification settings bulk save failed"
    );
  }
  async listResourceSettings(input: {
    target_type: NotificationResourceTarget;
    cursor?: string;
    limit: number;
  }) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new ApplicationProblem(
        400,
        "NOTIFICATION_RESOURCE_LIMIT_INVALID",
        "Invalid notification resource page limit"
      );
    }
    const after = input.cursor
      ? decodeOrderedCursor(input.cursor) ?? undefined
      : undefined;
    if (input.cursor && !after) {
      throw new ApplicationProblem(
        400,
        "NOTIFICATION_RESOURCE_CURSOR_INVALID",
        "Invalid notification resource cursor"
      );
    }
    const rows = await this.repository.listResourceSettings({
      targetType: input.target_type,
      after,
      limit: input.limit + 1,
    });
    const hasMore = rows.length > input.limit;
    const data = hasMore ? rows.slice(0, input.limit) : rows;
    const last = data.at(-1);
    return {
      data,
      next_cursor:
        hasMore && last
          ? encodeOrderedCursor({ sortOrder: last.sort_order, id: last.id })
          : null,
      has_more: hasMore,
    };
  }
  async listHistory(input: {
    cursor?: number;
    type?: string;
    target_id?: number;
    status?: string;
    limit: number;
  }) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new ApplicationProblem(
        400,
        "NOTIFICATION_HISTORY_LIMIT_INVALID",
        "Invalid notification history page limit"
      );
    }
    const rows = await this.repository.listHistory({
      beforeId: input.cursor,
      type: input.type,
      targetId: input.target_id,
      status: input.status,
      limit: input.limit + 1,
    });
    const hasMore = rows.length > input.limit;
    const data = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      data,
      next_cursor: hasMore ? data.at(-1)?.id ?? null : null,
      has_more: hasMore,
    };
  }
}
