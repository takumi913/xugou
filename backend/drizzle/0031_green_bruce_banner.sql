CREATE TABLE `legacy_id_map` (
	`source_table` text NOT NULL,
	`source_id` text NOT NULL,
	`target_table` text NOT NULL,
	`target_id` text NOT NULL,
	`payload_checksum` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`source_table`, `source_id`)
);
--> statement-breakpoint
CREATE INDEX `legacy_id_map_target_idx` ON `legacy_id_map` (`target_table`,`target_id`);