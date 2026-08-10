CREATE TABLE `agent_reports` (
	`report_id` text PRIMARY KEY NOT NULL,
	`agent_id` integer NOT NULL,
	`payload_digest` text NOT NULL,
	`payload_json` text NOT NULL,
	`sample_count` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`received_at` text NOT NULL,
	`processed_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_reports_agent_received_at_idx` ON `agent_reports` (`agent_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `agent_reports_status_updated_at_idx` ON `agent_reports` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `agent_report_samples` (
	`report_id` text NOT NULL,
	`sample_index` integer NOT NULL,
	`agent_id` integer NOT NULL,
	`collected_at` text NOT NULL,
	`metrics_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`report_id`, `sample_index`),
	FOREIGN KEY (`report_id`) REFERENCES `agent_reports`(`report_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_report_samples_agent_collected_at_idx` ON `agent_report_samples` (`agent_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE `async_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`dedup_key` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 8 NOT NULL,
	`available_at` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`last_error` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `async_jobs_dedup_key_unique_idx` ON `async_jobs` (`dedup_key`);--> statement-breakpoint
CREATE INDEX `async_jobs_status_available_at_idx` ON `async_jobs` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `async_jobs_aggregate_idx` ON `async_jobs` (`aggregate_type`,`aggregate_id`);--> statement-breakpoint
CREATE TABLE `domain_outbox` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` text NOT NULL,
	`published_at` text,
	`processed_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `domain_outbox_status_available_at_idx` ON `domain_outbox` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `domain_outbox_aggregate_idx` ON `domain_outbox` (`aggregate_type`,`aggregate_id`);--> statement-breakpoint
CREATE TABLE `processed_events` (
	`consumer` text NOT NULL,
	`event_id` text NOT NULL,
	`processed_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`consumer`, `event_id`)
);
--> statement-breakpoint
CREATE INDEX `processed_events_processed_at_idx` ON `processed_events` (`processed_at`);