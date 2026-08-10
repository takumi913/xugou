CREATE TABLE `agent_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` integer NOT NULL,
	`token_digest` text NOT NULL,
	`token_hint` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_credentials_token_digest_unique_idx` ON `agent_credentials` (`token_digest`);--> statement-breakpoint
CREATE INDEX `agent_credentials_agent_revoked_at_idx` ON `agent_credentials` (`agent_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `agent_enrollment_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_digest` text NOT NULL,
	`issued_by` integer NOT NULL,
	`agent_id` integer,
	`expires_at` text NOT NULL,
	`used_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`issued_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_enrollment_tokens_token_digest_unique_idx` ON `agent_enrollment_tokens` (`token_digest`);--> statement-breakpoint
CREATE INDEX `agent_enrollment_tokens_expiry_state_idx` ON `agent_enrollment_tokens` (`expires_at`,`used_at`,`revoked_at`);--> statement-breakpoint
ALTER TABLE `agents` ADD `deleted_at` text;