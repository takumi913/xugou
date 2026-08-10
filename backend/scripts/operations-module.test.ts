import assert from "node:assert/strict";
import {
  QueueFailureUseCases,
  type QueueFailureRepositoryPort,
} from "../src/modules/operations/application/QueueFailureUseCases";
import type { QueueFailureView } from "../src/modules/operations/domain/models";
import {
  decodeSecurityAuditCursor,
  encodeSecurityAuditCursor,
} from "../src/platform/security/SecurityStore";

const base: QueueFailureView = {
  failure_id: "xugou-jobs-dlq:1",
  queue_name: "xugou-jobs-dlq",
  message_id: "1",
  source_kind: "job",
  source_id: "job-1",
  delivery_attempts: 6,
  last_error: "fixture",
  status: "open",
  replay_count: 0,
  replayed_at: null,
  terminated_at: null,
  created_at: "2026-08-02T00:00:00.000Z",
  updated_at: "2026-08-02T00:00:00.000Z",
};
const rows = [
  base,
  { ...base, failure_id: "xugou-jobs-dlq:2", message_id: "2", source_id: "job-2" },
  { ...base, failure_id: "xugou-jobs-dlq:3", message_id: "3", source_id: "job-3" },
];
let currentStatus = "open";
const published: unknown[] = [];
const repository: QueueFailureRepositoryPort = {
  async listPage({ afterId, limit }) {
    return rows.filter((row) => !afterId || row.failure_id > afterId).slice(0, limit);
  },
  async findById(id) {
    const row = rows.find((candidate) => candidate.failure_id === id);
    return row
      ? {
          ...row,
          status: currentStatus,
          message: { version: 1, kind: "job" as const, job_id: row.source_id! },
        }
      : null;
  },
  async prepareReplay() {
    return currentStatus === "open";
  },
  async markReplayed() {
    currentStatus = "replayed";
  },
  async terminate() {
    if (currentStatus !== "open") return false;
    currentStatus = "terminated";
    return true;
  },
  async health(now) {
    return {
      generated_at: now,
      jobs: { pending: 2 },
      outbox: { pending: 1 },
      notifications: { retry: 1 },
      open_failures: 1,
      oldest_job_available_at: null,
      oldest_outbox_available_at: null,
      job_lag_seconds: 0,
      outbox_lag_seconds: 0,
    };
  },
};
const useCases = new QueueFailureUseCases(repository, {
  async publish(message) {
    published.push(message);
  },
});

assert.deepEqual(await useCases.list({ limit: 2 }), {
  data: rows.slice(0, 2),
  next_cursor: "xugou-jobs-dlq:2",
  has_more: true,
});
await assert.rejects(useCases.list({ limit: 101 }), /page limit/);
assert.deepEqual(await useCases.replay(base.failure_id), {
  failure_id: base.failure_id,
  status: "replayed",
});
assert.deepEqual(published, [{ version: 1, kind: "job", job_id: "job-1" }]);
await assert.rejects(useCases.replay(base.failure_id), /already closed/);
currentStatus = "open";
await useCases.terminate(base.failure_id);
assert.equal(currentStatus, "terminated");
await assert.rejects(useCases.terminate("missing"), /not found/);
assert.deepEqual((await useCases.health()).jobs, { pending: 2 });

const auditCursor = encodeSecurityAuditCursor({
  createdAt: "2026-08-09T00:00:00.000Z",
  id: "018f47f2-60e5-7b47-a8ca-58c57e1be5d4",
});
assert.deepEqual(decodeSecurityAuditCursor(auditCursor), {
  createdAt: "2026-08-09T00:00:00.000Z",
  id: "018f47f2-60e5-7b47-a8ca-58c57e1be5d4",
});
assert.equal(decodeSecurityAuditCursor("invalid"), null);
