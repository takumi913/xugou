export const QUEUE_MESSAGE_VERSION = 1 as const;

export type XugouQueueMessage =
  | {
      version: typeof QUEUE_MESSAGE_VERSION;
      kind: "job";
      job_id: string;
    }
  | {
      version: typeof QUEUE_MESSAGE_VERSION;
      kind: "outbox";
      event_id: string;
    };

export function isXugouQueueMessage(value: unknown): value is XugouQueueMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.version !== QUEUE_MESSAGE_VERSION) return false;
  return (
    (message.kind === "job" && typeof message.job_id === "string") ||
    (message.kind === "outbox" && typeof message.event_id === "string")
  );
}
