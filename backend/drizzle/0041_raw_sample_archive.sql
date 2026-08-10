CREATE TABLE `raw_sample_archive_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL CHECK (`domain` IN ('agent', 'monitor')),
	`object_key` text NOT NULL,
	`content_sha256` text NOT NULL,
	`object_size_bytes` integer NOT NULL,
	`source_rows` integer NOT NULL,
	`range_start` text NOT NULL,
	`range_end` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending', 'verified', 'failed')),
	`attempts` integer DEFAULT 1 NOT NULL,
	`r2_version` text,
	`r2_etag` text,
	`verified_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `raw_sample_archive_batches_object_key_unique_idx` ON `raw_sample_archive_batches` (`object_key`);
--> statement-breakpoint
CREATE INDEX `raw_sample_archive_batches_status_updated_idx` ON `raw_sample_archive_batches` (`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `raw_sample_archive_members` (
	`domain` text NOT NULL CHECK (`domain` IN ('agent', 'monitor')),
	`source_key` text NOT NULL,
	`source_parent_key` text NOT NULL,
	`batch_id` text NOT NULL,
	`archived_at` text NOT NULL,
	PRIMARY KEY(`domain`, `source_key`),
	FOREIGN KEY (`batch_id`) REFERENCES `raw_sample_archive_batches`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `raw_sample_archive_members_batch_idx` ON `raw_sample_archive_members` (`batch_id`);
--> statement-breakpoint
CREATE INDEX `raw_sample_archive_members_parent_idx` ON `raw_sample_archive_members` (`domain`,`source_parent_key`);
