CREATE TABLE `notification_rule_endpoints` (
	`rule_id` integer NOT NULL,
	`channel_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`rule_id`, `channel_id`),
	FOREIGN KEY (`rule_id`) REFERENCES `notification_rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_rule_endpoints_channel_idx` ON `notification_rule_endpoints` (`channel_id`,`rule_id`);--> statement-breakpoint
CREATE TABLE `notification_rules` (
	`id` integer PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` integer,
	`enabled` integer DEFAULT 1 NOT NULL,
	`on_down` integer DEFAULT 1 NOT NULL,
	`on_recovery` integer DEFAULT 1 NOT NULL,
	`on_offline` integer DEFAULT 1 NOT NULL,
	`on_cpu_threshold` integer DEFAULT 0 NOT NULL,
	`cpu_threshold` integer DEFAULT 90 NOT NULL,
	`on_memory_threshold` integer DEFAULT 0 NOT NULL,
	`memory_threshold` integer DEFAULT 85 NOT NULL,
	`on_disk_threshold` integer DEFAULT 0 NOT NULL,
	`disk_threshold` integer DEFAULT 90 NOT NULL,
	`cooldown_minutes` integer DEFAULT 30 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_rules_lookup_idx` ON `notification_rules` (`target_type`,`target_id`,`enabled`,`id`);