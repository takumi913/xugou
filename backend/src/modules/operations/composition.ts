import { createDb } from "../../config/db";
import type { Bindings } from "../../models/db";
import { QueueFailureUseCases } from "./application/QueueFailureUseCases";
import { DrizzleQueueFailureRepository } from "./persistence/DrizzleQueueFailureRepository";

export function createQueueFailureUseCases(env: Bindings) {
  return new QueueFailureUseCases(new DrizzleQueueFailureRepository(createDb(env)), {
    async publish(message) {
      await env.XUGOU_JOBS.send(message);
    },
  });
}
