CREATE TABLE `agent_nodes` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`collect_interval_ms` integer NOT NULL,
	`report_interval_ms` integer NOT NULL,
	`group_name` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`price` real,
	`currency` text,
	`billing_cycle` text,
	`expire_date` text,
	`auto_renewal` integer DEFAULT 0 NOT NULL,
	`is_hidden` integer DEFAULT 0 NOT NULL,
	`traffic_limit_gb` real,
	`traffic_reset_day` integer DEFAULT 1 NOT NULL,
	`traffic_calc_type` text DEFAULT 'sum' NOT NULL,
	`auto_update` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`deleted_at_ms` integer
);
--> statement-breakpoint
CREATE INDEX `agent_nodes_active_created_idx` ON `agent_nodes` (`deleted_at_ms`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `agent_runtime` (
	`agent_id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'inactive' NOT NULL,
	`hostname` text,
	`ip_addresses_json` text DEFAULT '[]' NOT NULL,
	`os` text,
	`agent_version` text,
	`keepalive_seconds` integer,
	`boot_time` integer,
	`last_seen_at_ms` integer,
	`last_state_changed_at_ms` integer,
	`next_offline_at_ms` integer,
	`region` text,
	`geo_latitude` real,
	`geo_longitude` real,
	`geo_city` text,
	`geo_region_name` text,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_runtime_status_offline_idx` ON `agent_runtime` (`status`,`next_offline_at_ms`);