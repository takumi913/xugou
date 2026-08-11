PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE `async_jobs`;--> statement-breakpoint
DROP TABLE `contract_release_evidence`;--> statement-breakpoint
DROP TABLE `contract_release_state`;--> statement-breakpoint
DROP TABLE `queue_failures`;--> statement-breakpoint
DROP TABLE `raw_sample_archive_members`;--> statement-breakpoint
DROP TABLE `raw_sample_archive_batches`;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token` text NOT NULL,
	`status` text DEFAULT 'inactive',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`hostname` text,
	`ip_addresses` text,
	`os` text,
	`version` text,
	`keepalive` text,
	`last_seen_at` text,
	`last_state_changed_at` text,
	`next_offline_at` text,
	`history_partition_id` integer DEFAULT 0,
	`collect_interval` integer DEFAULT 60,
	`report_interval` integer DEFAULT 60,
	`region` text,
	`geo_latitude` real,
	`geo_longitude` real,
	`geo_city` text,
	`geo_region_name` text,
	`boot_time` integer,
	`price` real,
	`currency` text DEFAULT 'USD',
	`billing_cycle` text,
	`expire_date` text,
	`auto_renewal` integer DEFAULT 0,
	`is_hidden` integer DEFAULT 0,
	`traffic_limit_gb` real,
	`traffic_reset_day` integer DEFAULT 1,
	`traffic_calc_type` text DEFAULT 'sum',
	`auto_update` integer DEFAULT 0,
	`group_name` text,
	`tags` text,
	`sort_order` integer DEFAULT 0,
	`deleted_at` text
);
--> statement-breakpoint
INSERT INTO `__new_agents`("id", "name", "token", "status", "created_at", "updated_at", "hostname", "ip_addresses", "os", "version", "keepalive", "last_seen_at", "last_state_changed_at", "next_offline_at", "history_partition_id", "collect_interval", "report_interval", "region", "geo_latitude", "geo_longitude", "geo_city", "geo_region_name", "boot_time", "price", "currency", "billing_cycle", "expire_date", "auto_renewal", "is_hidden", "traffic_limit_gb", "traffic_reset_day", "traffic_calc_type", "auto_update", "group_name", "tags", "sort_order", "deleted_at") SELECT "id", "name", "token", "status", "created_at", "updated_at", "hostname", "ip_addresses", "os", "version", "keepalive", "last_seen_at", "last_state_changed_at", "next_offline_at", "history_partition_id", "collect_interval", "report_interval", "region", "geo_latitude", "geo_longitude", "geo_city", "geo_region_name", "boot_time", "price", "currency", "billing_cycle", "expire_date", "auto_renewal", "is_hidden", "traffic_limit_gb", "traffic_reset_day", "traffic_calc_type", "auto_update", "group_name", "tags", "sort_order", "deleted_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_token_unique` ON `agents` (`token`);--> statement-breakpoint
CREATE INDEX `agents_created_at_idx` ON `agents` (`created_at`);--> statement-breakpoint
CREATE INDEX `agents_status_updated_at_idx` ON `agents` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `agents_status_next_offline_at_idx` ON `agents` (`status`,`next_offline_at`);
