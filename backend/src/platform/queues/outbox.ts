export interface StoredOutboxEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload_json: string;
  status: string;
}

export interface OutboxConsumer {
  readonly consumerName: string;
  readonly eventTypes: readonly string[];
  process(event: StoredOutboxEvent): Promise<void>;
}
