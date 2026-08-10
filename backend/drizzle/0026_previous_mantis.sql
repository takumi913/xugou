CREATE TABLE `monitor_check_samples` (
	`job_id` text PRIMARY KEY NOT NULL,
	`monitor_id` integer NOT NULL,
	`scheduled_for_ms` integer NOT NULL,
	`checked_at` text NOT NULL,
	`status` text NOT NULL,
	`response_time_ms` integer NOT NULL,
	`status_code` integer,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `monitor_check_samples_monitor_checked_at_idx` ON `monitor_check_samples` (`monitor_id`,`checked_at`);