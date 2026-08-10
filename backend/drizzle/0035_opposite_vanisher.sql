CREATE TABLE `monitor_definitions` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`method` text NOT NULL,
	`headers_json` text DEFAULT '{}' NOT NULL,
	`body` text,
	`interval_ms` integer NOT NULL,
	`timeout_ms` integer NOT NULL,
	`expected_status` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`deleted_at_ms` integer
);
--> statement-breakpoint
CREATE INDEX `monitor_definitions_active_created_idx` ON `monitor_definitions` (`active`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `monitor_runtime` (
	`monitor_id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`response_time_ms` integer DEFAULT 0 NOT NULL,
	`last_checked_at_ms` integer,
	`next_due_at_ms` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitor_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `monitor_runtime_next_due_idx` ON `monitor_runtime` (`next_due_at_ms`);--> statement-breakpoint
ALTER TABLE `monitors` ADD `deleted_at` text;