CREATE TABLE `agent_latest_metrics` (
	`agent_id` integer PRIMARY KEY NOT NULL,
	`metrics_json` text NOT NULL,
	`collected_at` text,
	`reported_at` text NOT NULL,
	`cpu_usage` real,
	`memory_usage_rate` real,
	`disk_usage_rate` real,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_latest_metrics_reported_at_idx` ON `agent_latest_metrics` (`reported_at`);--> statement-breakpoint
CREATE TABLE `agent_metric_rollups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` integer NOT NULL,
	`bucket_start` text NOT NULL,
	`bucket_size_seconds` integer NOT NULL,
	`sample_count` integer DEFAULT 0 NOT NULL,
	`cpu_avg` real,
	`cpu_min` real,
	`cpu_max` real,
	`cpu_p95` real,
	`memory_avg` real,
	`memory_min` real,
	`memory_max` real,
	`memory_p95` real,
	`disk_max` real,
	`load_avg` real,
	`network_delta_json` text,
	`threshold_events_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_metric_rollups_agent_bucket_unique_idx` ON `agent_metric_rollups` (`agent_id`,`bucket_start`,`bucket_size_seconds`);--> statement-breakpoint
CREATE INDEX `agent_metric_rollups_agent_bucket_idx` ON `agent_metric_rollups` (`agent_id`,`bucket_start`);--> statement-breakpoint
CREATE TABLE `monitor_check_rollups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`monitor_id` integer NOT NULL,
	`bucket_start` text NOT NULL,
	`bucket_size_seconds` integer NOT NULL,
	`total_checks` integer DEFAULT 0 NOT NULL,
	`up_checks` integer DEFAULT 0 NOT NULL,
	`down_checks` integer DEFAULT 0 NOT NULL,
	`last_status` text,
	`response_time_avg` integer DEFAULT 0,
	`response_time_p95` integer DEFAULT 0,
	`response_time_max` integer DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_check_rollups_monitor_bucket_unique_idx` ON `monitor_check_rollups` (`monitor_id`,`bucket_start`,`bucket_size_seconds`);--> statement-breakpoint
CREATE INDEX `monitor_check_rollups_monitor_bucket_idx` ON `monitor_check_rollups` (`monitor_id`,`bucket_start`);--> statement-breakpoint
CREATE TABLE `monitor_incidents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`monitor_id` integer NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`reason` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `monitor_incidents_monitor_started_at_idx` ON `monitor_incidents` (`monitor_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `public_status_snapshots` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`snapshot_json` text NOT NULL,
	`etag` text NOT NULL,
	`generated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`dirty_at` text,
	`refresh_after` text,
	`refreshing` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `last_seen_at` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `last_state_changed_at` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `next_offline_at` text;--> statement-breakpoint
CREATE INDEX `agents_status_next_offline_at_idx` ON `agents` (`status`,`next_offline_at`);