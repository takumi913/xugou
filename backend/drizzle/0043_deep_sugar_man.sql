CREATE TABLE `status_metric_publications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status_publication_id` integer NOT NULL,
	`agent_id` integer NOT NULL,
	`payload_json` text NOT NULL,
	`etag` text NOT NULL,
	`generated_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`status_publication_id`) REFERENCES `status_publications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `status_metric_publications_publication_agent_unique_idx` ON `status_metric_publications` (`status_publication_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `status_metric_publications_agent_generated_at_idx` ON `status_metric_publications` (`agent_id`,`generated_at`);--> statement-breakpoint
INSERT OR IGNORE INTO domain_outbox
  (event_id, event_type, aggregate_type, aggregate_id, payload_json, status,
   attempts, available_at, created_at, updated_at)
VALUES
  ('status.rebuild.requested:migration:0043', 'status.rebuild.requested',
   'status_page', '1',
   '{"reason":"migration.0043","aggregate_type":"status_page","aggregate_id":"1"}',
   'pending', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
