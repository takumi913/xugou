CREATE TABLE `admin_sessions` (
	`token_digest` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `admin_sessions_user_expires_at_idx` ON `admin_sessions` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `admin_sessions_expires_at_idx` ON `admin_sessions` (`expires_at`);