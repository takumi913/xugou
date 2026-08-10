CREATE TABLE `migration_anomalies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`migration_key` text NOT NULL,
	`source_table` text NOT NULL,
	`source_pk` text NOT NULL,
	`error_code` text NOT NULL,
	`raw_value_json` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution_note` text,
	`first_seen_at` text NOT NULL,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `migration_anomalies_source_unique_idx` ON `migration_anomalies` (`migration_key`,`source_table`,`source_pk`,`error_code`);--> statement-breakpoint
CREATE INDEX `migration_anomalies_status_id_idx` ON `migration_anomalies` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `migration_anomalies_migration_id_idx` ON `migration_anomalies` (`migration_key`,`id`);--> statement-breakpoint
CREATE TABLE `migration_checkpoints` (
	`migration_key` text PRIMARY KEY NOT NULL,
	`phase` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_pk` text,
	`rows_read` integer DEFAULT 0 NOT NULL,
	`rows_written` integer DEFAULT 0 NOT NULL,
	`rows_skipped` integer DEFAULT 0 NOT NULL,
	`anomaly_rows` integer DEFAULT 0 NOT NULL,
	`checksum` text,
	`last_error` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `migration_checkpoints_status_updated_at_idx` ON `migration_checkpoints` (`status`,`updated_at`);