DELETE FROM `notification_settings` WHERE `user_id` <> 1;--> statement-breakpoint
DELETE FROM `public_status_snapshots` WHERE `user_id` <> 1;--> statement-breakpoint
DELETE FROM `status_page_monitors` WHERE `config_id` NOT IN (
	SELECT `id` FROM `status_page_config`
	ORDER BY CASE WHEN `user_id` = 1 THEN 0 ELSE 1 END, `id`
	LIMIT 1
);--> statement-breakpoint
DELETE FROM `status_page_agents` WHERE `config_id` NOT IN (
	SELECT `id` FROM `status_page_config`
	ORDER BY CASE WHEN `user_id` = 1 THEN 0 ELSE 1 END, `id`
	LIMIT 1
);--> statement-breakpoint
DELETE FROM `status_page_config` WHERE `id` NOT IN (
	SELECT `id` FROM `status_page_config`
	ORDER BY CASE WHEN `user_id` = 1 THEN 0 ELSE 1 END, `id`
	LIMIT 1
);--> statement-breakpoint
-- Rebuilding a referenced parent table makes SQLite execute its ON DELETE
-- actions even when foreign-key checks are deferred. Preserve every CASCADE
-- child after the singleton cleanup, then restore it once all parents exist.
CREATE TABLE `__preserve_0017_agent_latest_metrics` AS SELECT * FROM `agent_latest_metrics`;--> statement-breakpoint
CREATE TABLE `__preserve_0017_agent_metric_rollups` AS SELECT * FROM `agent_metric_rollups`;--> statement-breakpoint
CREATE TABLE `__preserve_0017_status_page_agents` AS SELECT * FROM `status_page_agents`;--> statement-breakpoint
CREATE TABLE `__preserve_0017_monitor_check_rollups` AS SELECT * FROM `monitor_check_rollups`;--> statement-breakpoint
CREATE TABLE `__preserve_0017_monitor_incidents` AS SELECT * FROM `monitor_incidents`;--> statement-breakpoint
CREATE TABLE `__preserve_0017_status_page_monitors` AS SELECT * FROM `status_page_monitors`;--> statement-breakpoint
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_public_status_snapshots` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`snapshot_json` text NOT NULL,
	`etag` text NOT NULL,
	`generated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`dirty_at` text,
	`refresh_after` text,
	`refreshing` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
INSERT INTO `__new_public_status_snapshots`("id", "snapshot_json", "etag", "generated_at", "expires_at", "dirty_at", "refresh_after", "refreshing", "last_error") SELECT "user_id", "snapshot_json", "etag", "generated_at", "expires_at", "dirty_at", "refresh_after", "refreshing", "last_error" FROM `public_status_snapshots`;--> statement-breakpoint
DROP TABLE `public_status_snapshots`;--> statement-breakpoint
ALTER TABLE `__new_public_status_snapshots` RENAME TO `public_status_snapshots`;--> statement-breakpoint
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
	`report_interval` integer DEFAULT 300,
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
	`sort_order` integer DEFAULT 0
);
--> statement-breakpoint
INSERT INTO `__new_agents`("id", "name", "token", "status", "created_at", "updated_at", "hostname", "ip_addresses", "os", "version", "keepalive", "last_seen_at", "last_state_changed_at", "next_offline_at", "history_partition_id", "collect_interval", "report_interval", "region", "geo_latitude", "geo_longitude", "geo_city", "geo_region_name", "boot_time", "price", "currency", "billing_cycle", "expire_date", "auto_renewal", "is_hidden", "traffic_limit_gb", "traffic_reset_day", "traffic_calc_type", "auto_update", "group_name", "tags", "sort_order") SELECT "id", "name", "token", "status", "created_at", "updated_at", "hostname", "ip_addresses", "os", "version", "keepalive", "last_seen_at", "last_state_changed_at", "next_offline_at", "history_partition_id", "collect_interval", "report_interval", "region", "geo_latitude", "geo_longitude", "geo_city", "geo_region_name", "boot_time", "price", "currency", "billing_cycle", "expire_date", "auto_renewal", "is_hidden", "traffic_limit_gb", "traffic_reset_day", "traffic_calc_type", "auto_update", "group_name", "tags", "sort_order" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_token_unique` ON `agents` (`token`);--> statement-breakpoint
CREATE INDEX `agents_created_at_idx` ON `agents` (`created_at`);--> statement-breakpoint
CREATE INDEX `agents_status_updated_at_idx` ON `agents` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `agents_status_next_offline_at_idx` ON `agents` (`status`,`next_offline_at`);--> statement-breakpoint
CREATE TABLE `__new_monitors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`method` text NOT NULL,
	`interval` integer NOT NULL,
	`timeout` integer NOT NULL,
	`expected_status` integer NOT NULL,
	`headers` text NOT NULL,
	`body` text,
	`active` integer NOT NULL,
	`status` text DEFAULT 'pending',
	`response_time` integer DEFAULT 0,
	`last_checked` text,
	`next_check_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`sort_order` integer DEFAULT 0
);
--> statement-breakpoint
INSERT INTO `__new_monitors`("id", "name", "url", "method", "interval", "timeout", "expected_status", "headers", "body", "active", "status", "response_time", "last_checked", "next_check_at", "created_at", "updated_at", "sort_order") SELECT "id", "name", "url", "method", "interval", "timeout", "expected_status", "headers", "body", "active", "status", "response_time", "last_checked", "next_check_at", "created_at", "updated_at", "sort_order" FROM `monitors`;--> statement-breakpoint
DROP TABLE `monitors`;--> statement-breakpoint
ALTER TABLE `__new_monitors` RENAME TO `monitors`;--> statement-breakpoint
CREATE INDEX `monitors_active_next_check_at_idx` ON `monitors` (`active`,`next_check_at`);--> statement-breakpoint
CREATE INDEX `monitors_created_at_idx` ON `monitors` (`created_at`);--> statement-breakpoint
CREATE TABLE `__new_notification_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP',
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP'
);
--> statement-breakpoint
INSERT INTO `__new_notification_channels`("id", "name", "type", "config", "enabled", "created_at", "updated_at") SELECT "id", "name", "type", "config", "enabled", "created_at", "updated_at" FROM `notification_channels`;--> statement-breakpoint
DROP TABLE `notification_channels`;--> statement-breakpoint
ALTER TABLE `__new_notification_channels` RENAME TO `notification_channels`;--> statement-breakpoint
CREATE INDEX `notification_channels_id_idx` ON `notification_channels` (`id`);--> statement-breakpoint
CREATE TABLE `__new_notification_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_type` text DEFAULT 'global' NOT NULL,
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
	`channels` text DEFAULT '[]',
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP',
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP'
);
--> statement-breakpoint
INSERT INTO `__new_notification_settings`("id", "target_type", "target_id", "enabled", "on_down", "on_recovery", "on_offline", "on_cpu_threshold", "cpu_threshold", "on_memory_threshold", "memory_threshold", "on_disk_threshold", "disk_threshold", "cooldown_minutes", "channels", "created_at", "updated_at") SELECT "id", "target_type", "target_id", "enabled", "on_down", "on_recovery", "on_offline", "on_cpu_threshold", "cpu_threshold", "on_memory_threshold", "memory_threshold", "on_disk_threshold", "disk_threshold", "cooldown_minutes", "channels", "created_at", "updated_at" FROM `notification_settings`;--> statement-breakpoint
DROP TABLE `notification_settings`;--> statement-breakpoint
ALTER TABLE `__new_notification_settings` RENAME TO `notification_settings`;--> statement-breakpoint
CREATE INDEX `notification_settings_lookup_idx` ON `notification_settings` (`target_type`,`target_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `__new_notification_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`subject` text NOT NULL,
	`content` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP',
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP'
);
--> statement-breakpoint
INSERT INTO `__new_notification_templates`("id", "name", "type", "subject", "content", "is_default", "created_at", "updated_at") SELECT "id", "name", "type", "subject", "content", "is_default", "created_at", "updated_at" FROM `notification_templates`;--> statement-breakpoint
DROP TABLE `notification_templates`;--> statement-breakpoint
ALTER TABLE `__new_notification_templates` RENAME TO `notification_templates`;--> statement-breakpoint
CREATE TABLE `__new_status_page_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`singleton_key` integer DEFAULT 1 NOT NULL,
	`title` text DEFAULT '系统状态' NOT NULL,
	`description` text DEFAULT '系统当前运行状态',
	`logo_url` text DEFAULT '',
	`custom_css` text DEFAULT '',
	`theme` text DEFAULT 'mono',
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP',
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP'
);
--> statement-breakpoint
INSERT INTO `__new_status_page_config`("id", "singleton_key", "title", "description", "logo_url", "custom_css", "theme", "created_at", "updated_at") SELECT "id", 1, "title", "description", "logo_url", "custom_css", "theme", "created_at", "updated_at" FROM `status_page_config`;--> statement-breakpoint
DROP TABLE `status_page_config`;--> statement-breakpoint
ALTER TABLE `__new_status_page_config` RENAME TO `status_page_config`;--> statement-breakpoint
CREATE UNIQUE INDEX `status_page_config_singleton_idx` ON `status_page_config` (`singleton_key`);--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `role`;--> statement-breakpoint
INSERT INTO `agent_latest_metrics` SELECT * FROM `__preserve_0017_agent_latest_metrics`;--> statement-breakpoint
INSERT INTO `agent_metric_rollups` SELECT * FROM `__preserve_0017_agent_metric_rollups`;--> statement-breakpoint
INSERT INTO `status_page_agents` SELECT * FROM `__preserve_0017_status_page_agents`;--> statement-breakpoint
INSERT INTO `monitor_check_rollups` SELECT * FROM `__preserve_0017_monitor_check_rollups`;--> statement-breakpoint
INSERT INTO `monitor_incidents` SELECT * FROM `__preserve_0017_monitor_incidents`;--> statement-breakpoint
INSERT INTO `status_page_monitors` SELECT * FROM `__preserve_0017_status_page_monitors`;--> statement-breakpoint
DROP TABLE `__preserve_0017_agent_latest_metrics`;--> statement-breakpoint
DROP TABLE `__preserve_0017_agent_metric_rollups`;--> statement-breakpoint
DROP TABLE `__preserve_0017_status_page_agents`;--> statement-breakpoint
DROP TABLE `__preserve_0017_monitor_check_rollups`;--> statement-breakpoint
DROP TABLE `__preserve_0017_monitor_incidents`;--> statement-breakpoint
DROP TABLE `__preserve_0017_status_page_monitors`;--> statement-breakpoint
-- The final schema passes foreign_key_check. Reset SQLite's deferred-violation
-- counter, which still remembers the transient parent-table drops.
PRAGMA defer_foreign_keys = false;
