CREATE TABLE `notification_setting_commands` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`status` text NOT NULL,
	`response_json` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_setting_commands_status_updated_idx` ON `notification_setting_commands` (`status`,`updated_at`);