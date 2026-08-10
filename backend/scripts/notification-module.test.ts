import assert from "node:assert/strict";
import {
  NotificationUseCases,
  type NotificationRepositoryPort,
} from "../src/modules/notifications/application/NotificationUseCases";
import { channelUpdateSchema } from "../src/modules/notifications/http/schemas";

const history = [
  { id: 3, status: "success" },
  { id: 2, status: "failed" },
  { id: 1, status: "success" },
];
const repository: NotificationRepositoryPort = {
  async getConfig() { return { channels: [], templates: [], settings: {} }; },
  async listChannels() { return []; },
  async getChannel(id) { return id === 1 ? { id, type: "webhook" } : null; },
  async prepareChannelConfig(id, _type, config) { return id === 1 ? config : null; },
  async createChannel() { return { success: true, id: 1 }; },
  async updateChannel(id) { return id === 1 ? { success: true } : { success: false, message: "不存在" }; },
  async deleteChannel(id) { return id === 1 ? { success: true } : { success: false, message: "不存在" }; },
  async testChannel(id) { return id === 1 ? { success: true } : { success: false, error: "不存在" }; },
  async listTemplates() { return []; },
  async getTemplate(id) { return id === 1 ? { id, type: "agent" } : null; },
  async createTemplate() { return { success: true, id: 1 }; },
  async updateTemplate() { return { success: true }; },
  async deleteTemplate() { return { success: true }; },
  async saveSetting() { return { success: true, id: 1 }; },
  async saveSettingsBulk(_inputs, idempotencyKey) {
    return { success: true, ids: [1, 2], replayed: idempotencyKey === "replay-key" };
  },
  async listResourceSettings({ targetType, after, limit }) {
    return [
      { target_type: targetType, id: 1, name: "one", description: null, sort_order: 0, setting: null },
      { target_type: targetType, id: 2, name: "two", description: null, sort_order: 0, setting: null },
      { target_type: targetType, id: 3, name: "three", description: null, sort_order: 1, setting: null },
    ]
      .filter(
        (row) =>
          !after ||
          row.sort_order > after.sortOrder ||
          (row.sort_order === after.sortOrder && row.id > after.id)
      )
      .slice(0, limit);
  },
  async listHistory({ beforeId, limit }) {
    return history.filter((row) => beforeId === undefined || row.id < beforeId).slice(0, limit);
  },
};

const useCases = new NotificationUseCases(repository);
assert.deepEqual(await useCases.getConfig(), { channels: [], templates: [], settings: {} });
assert.equal((await useCases.getChannel(1)).type, "webhook");
await assert.rejects(useCases.getChannel(2), /not found/);
assert.deepEqual(await useCases.listHistory({ limit: 2 }), {
  data: history.slice(0, 2),
  next_cursor: 2,
  has_more: true,
});
assert.deepEqual(
  await useCases.listResourceSettings({ target_type: "monitor", limit: 2 }),
  {
    data: [
      { target_type: "monitor", id: 1, name: "one", description: null, sort_order: 0, setting: null },
      { target_type: "monitor", id: 2, name: "two", description: null, sort_order: 0, setting: null },
    ],
    next_cursor: "0:2",
    has_more: true,
  }
);
await assert.rejects(
  useCases.listResourceSettings({ target_type: "monitor", limit: 51 }),
  /page limit/
);
await assert.rejects(useCases.listHistory({ limit: 101 }), /page limit/);
await assert.rejects(useCases.updateChannel(2, { enabled: false }), /不存在/);
assert.deepEqual(
  await useCases.saveSettingsBulk([], "replay-key", "sha256"),
  { success: true, ids: [1, 2], replayed: true }
);
assert.equal(
  channelUpdateSchema.safeParse({ type: "telegram" }).success,
  false,
  "changing provider type must include the replacement config"
);
