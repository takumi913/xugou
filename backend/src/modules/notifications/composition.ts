import type { Bindings } from "../../models/db";
import { NotificationUseCases } from "./application/NotificationUseCases";
import { D1NotificationRepository } from "./persistence/D1NotificationRepository";

export function createNotificationUseCases(env: Bindings) {
  return new NotificationUseCases(new D1NotificationRepository(env));
}
