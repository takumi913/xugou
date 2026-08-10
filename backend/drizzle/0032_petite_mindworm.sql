ALTER TABLE `migration_checkpoints` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `migration_checkpoints` ADD `lease_expires_at` text;