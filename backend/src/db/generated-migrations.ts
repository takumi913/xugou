// 此文件由 generate-migrations.ts 自动生成
// 请不要手动修改

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: "0000_romantic_next_avengers.sql",
    sql: `CREATE TABLE IF NOT EXISTS \`agent_metrics_24h\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`agent_id\` integer NOT NULL,
	\`timestamp\` text DEFAULT 'CURRENT_TIMESTAMP',
	\`cpu_usage\` real,
	\`cpu_cores\` integer,
	\`cpu_model\` text,
	\`memory_total\` integer,
	\`memory_used\` integer,
	\`memory_free\` integer,
	\`memory_usage_rate\` real,
	\`load_1\` real,
	\`load_5\` real,
	\`load_15\` real,
	\`disk_metrics\` text,
	\`network_metrics\` text,
	FOREIGN KEY (\`agent_id\`) REFERENCES \`agents\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`agents\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`name\` text NOT NULL,
	\`token\` text NOT NULL,
	\`created_by\` integer NOT NULL,
	\`status\` text DEFAULT 'inactive',
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	\`hostname\` text,
	\`ip_addresses\` text,
	\`os\` text,
	\`version\` text,
	\`keepalive\` text,
	\`cpu_usage\` real,
	\`memory_total\` integer,
	\`memory_used\` integer,
	\`disk_total\` integer,
	\`disk_used\` integer,
	\`network_rx\` integer,
	\`network_tx\` integer,
	FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS \`agents_token_unique\` ON \`agents\` (\`token\`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`monitor_daily_stats\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`monitor_id\` integer NOT NULL,
	\`date\` text NOT NULL,
	\`total_checks\` integer DEFAULT 0 NOT NULL,
	\`up_checks\` integer DEFAULT 0 NOT NULL,
	\`down_checks\` integer DEFAULT 0 NOT NULL,
	\`avg_response_time\` integer DEFAULT 0,
	\`min_response_time\` integer DEFAULT 0,
	\`max_response_time\` integer DEFAULT 0,
	\`availability\` real DEFAULT 0,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`monitor_id\`) REFERENCES \`monitors\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`monitor_status_history_24h\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`monitor_id\` integer NOT NULL,
	\`status\` text NOT NULL,
	\`timestamp\` text DEFAULT 'CURRENT_TIMESTAMP',
	\`response_time\` integer,
	\`status_code\` integer,
	\`error\` text,
	FOREIGN KEY (\`monitor_id\`) REFERENCES \`monitors\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`monitors\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`name\` text NOT NULL,
	\`url\` text NOT NULL,
	\`method\` text NOT NULL,
	\`interval\` integer NOT NULL,
	\`timeout\` integer NOT NULL,
	\`expected_status\` integer NOT NULL,
	\`headers\` text NOT NULL,
	\`body\` text,
	\`created_by\` integer NOT NULL,
	\`active\` integer NOT NULL,
	\`status\` text DEFAULT 'pending',
	\`response_time\` integer DEFAULT 0,
	\`last_checked\` text,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`notification_channels\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`name\` text NOT NULL,
	\`type\` text NOT NULL,
	\`config\` text NOT NULL,
	\`enabled\` integer DEFAULT 1 NOT NULL,
	\`created_by\` integer NOT NULL,
	\`created_at\` text DEFAULT 'CURRENT_TIMESTAMP',
	\`updated_at\` text DEFAULT 'CURRENT_TIMESTAMP',
	FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`notification_history\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`type\` text NOT NULL,
	\`target_id\` integer,
	\`channel_id\` integer NOT NULL,
	\`template_id\` integer NOT NULL,
	\`status\` text NOT NULL,
	\`content\` text NOT NULL,
	\`error\` text,
	\`sent_at\` text DEFAULT 'CURRENT_TIMESTAMP',
	FOREIGN KEY (\`channel_id\`) REFERENCES \`notification_channels\`(\`id\`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (\`template_id\`) REFERENCES \`notification_templates\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`notification_settings\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`user_id\` integer NOT NULL,
	\`target_type\` text DEFAULT 'global' NOT NULL,
	\`target_id\` integer,
	\`enabled\` integer DEFAULT 1 NOT NULL,
	\`on_down\` integer DEFAULT 1 NOT NULL,
	\`on_recovery\` integer DEFAULT 1 NOT NULL,
	\`on_offline\` integer DEFAULT 1 NOT NULL,
	\`on_cpu_threshold\` integer DEFAULT 0 NOT NULL,
	\`cpu_threshold\` integer DEFAULT 90 NOT NULL,
	\`on_memory_threshold\` integer DEFAULT 0 NOT NULL,
	\`memory_threshold\` integer DEFAULT 85 NOT NULL,
	\`on_disk_threshold\` integer DEFAULT 0 NOT NULL,
	\`disk_threshold\` integer DEFAULT 90 NOT NULL,
	\`channels\` text DEFAULT '[]',
	\`created_at\` text DEFAULT 'CURRENT_TIMESTAMP',
	\`updated_at\` text DEFAULT 'CURRENT_TIMESTAMP',
	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`notification_templates\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`name\` text NOT NULL,
	\`type\` text NOT NULL,
	\`subject\` text NOT NULL,
	\`content\` text NOT NULL,
	\`is_default\` integer DEFAULT 0 NOT NULL,
	\`created_by\` integer NOT NULL,
	\`created_at\` text DEFAULT 'CURRENT_TIMESTAMP',
	\`updated_at\` text DEFAULT 'CURRENT_TIMESTAMP',
	FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`status_page_agents\` (
	\`config_id\` integer NOT NULL,
	\`agent_id\` integer NOT NULL,
	PRIMARY KEY(\`config_id\`, \`agent_id\`),
	FOREIGN KEY (\`config_id\`) REFERENCES \`status_page_config\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`agent_id\`) REFERENCES \`agents\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`status_page_config\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`user_id\` integer NOT NULL,
	\`title\` text DEFAULT '系统状态' NOT NULL,
	\`description\` text DEFAULT '系统当前运行状态',
	\`logo_url\` text DEFAULT '',
	\`custom_css\` text DEFAULT '',
	\`created_at\` text DEFAULT 'CURRENT_TIMESTAMP',
	\`updated_at\` text DEFAULT 'CURRENT_TIMESTAMP',
	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`status_page_monitors\` (
	\`config_id\` integer NOT NULL,
	\`monitor_id\` integer NOT NULL,
	PRIMARY KEY(\`config_id\`, \`monitor_id\`),
	FOREIGN KEY (\`config_id\`) REFERENCES \`status_page_config\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`monitor_id\`) REFERENCES \`monitors\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`users\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`username\` text NOT NULL,
	\`password\` text NOT NULL,
	\`email\` text,
	\`role\` text NOT NULL,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS \`users_username_unique\` ON \`users\` (\`username\`);`
  },
  {
    name: "0001_fluffy_pestilence.sql",
    sql: `ALTER TABLE \`agents\` DROP COLUMN \`cpu_usage\`;
--> statement-breakpoint
ALTER TABLE \`agents\` DROP COLUMN \`memory_total\`;
--> statement-breakpoint
ALTER TABLE \`agents\` DROP COLUMN \`memory_used\`;
--> statement-breakpoint
ALTER TABLE \`agents\` DROP COLUMN \`disk_total\`;
--> statement-breakpoint
ALTER TABLE \`agents\` DROP COLUMN \`disk_used\`;
--> statement-breakpoint
ALTER TABLE \`agents\` DROP COLUMN \`network_rx\`;
--> statement-breakpoint
ALTER TABLE \`agents\` DROP COLUMN \`network_tx\`;`
  },
  {
    name: "0002_public_domino.sql",
    sql: `CREATE INDEX IF NOT EXISTS \`agent_metrics_24h_agent_timestamp_idx\` ON \`agent_metrics_24h\` (\`agent_id\`,\`timestamp\`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`monitor_daily_stats_monitor_id_date_idx\` ON \`monitor_daily_stats\` (\`monitor_id\`,\`date\`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`monitor_status_history_24h_monitor_timestamp_idx\` ON \`monitor_status_history_24h\` (\`monitor_id\`,\`timestamp\`);`
  },
  {
    name: "0003_reflective_random.sql",
    sql: `CREATE INDEX IF NOT EXISTS \`monitor_status_history_24h_timestamp_idx\` ON \`monitor_status_history_24h\` (\`timestamp\`);`
  },
  {
    name: "0004_many_avengers.sql",
    sql: `CREATE TABLE IF NOT EXISTS \`settings\` (
	\`key\` text PRIMARY KEY NOT NULL,
	\`value\` text
);`
  },
  {
    name: "0005_sloppy_vulture.sql",
    sql: `CREATE INDEX IF NOT EXISTS \`agents_created_by_created_at_idx\` ON \`agents\` (\`created_by\`,\`created_at\`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`agents_status_updated_at_idx\` ON \`agents\` (\`status\`,\`updated_at\`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`monitors_active_last_checked_idx\` ON \`monitors\` (\`active\`,\`last_checked\`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`monitors_created_by_created_at_idx\` ON \`monitors\` (\`created_by\`,\`created_at\`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`notification_channels_created_by_id_idx\` ON \`notification_channels\` (\`created_by\`,\`id\`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`notification_history_channel_sent_at_idx\` ON \`notification_history\` (\`channel_id\`,\`sent_at\`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`notification_settings_lookup_idx\` ON \`notification_settings\` (\`user_id\`,\`target_type\`,\`target_id\`,\`enabled\`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`status_page_config_user_id_idx\` ON \`status_page_config\` (\`user_id\`);`
  },
  {
    name: "0006_youthful_misty_knight.sql",
    sql: `DROP INDEX IF EXISTS \`monitors_active_last_checked_idx\`;
--> statement-breakpoint
ALTER TABLE \`monitors\` ADD \`next_check_at\` text;
--> statement-breakpoint
UPDATE \`monitors\`
SET \`next_check_at\` = CASE
  WHEN \`active\` = 1 AND \`last_checked\` IS NOT NULL
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime(\`last_checked\`, '+' || \`interval\` || ' seconds'))
  WHEN \`active\` = 1
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ELSE NULL
END;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`monitors_active_next_check_at_idx\` ON \`monitors\` (\`active\`,\`next_check_at\`);`
  },
  {
    name: "0007_little_cannonball.sql",
    sql: `DELETE FROM \`monitor_daily_stats\`
WHERE \`id\` NOT IN (
  SELECT max(\`id\`)
  FROM \`monitor_daily_stats\`
  GROUP BY \`monitor_id\`, \`date\`
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS \`monitor_daily_stats_monitor_id_date_unique_idx\` ON \`monitor_daily_stats\` (\`monitor_id\`,\`date\`);`
  },
  {
    name: "0008_notification_cooldown.sql",
    sql: `ALTER TABLE \`notification_settings\` ADD \`cooldown_minutes\` integer DEFAULT 30 NOT NULL;`
  },
  {
    name: "0009_cooing_songbird.sql",
    sql: `CREATE TABLE IF NOT EXISTS \`agent_latest_metrics\` (
	\`agent_id\` integer PRIMARY KEY NOT NULL,
	\`metrics_json\` text NOT NULL,
	\`collected_at\` text,
	\`reported_at\` text NOT NULL,
	\`cpu_usage\` real,
	\`memory_usage_rate\` real,
	\`disk_usage_rate\` real,
	\`updated_at\` text NOT NULL,
	FOREIGN KEY (\`agent_id\`) REFERENCES \`agents\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`agent_latest_metrics_reported_at_idx\` ON \`agent_latest_metrics\` (\`reported_at\`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`agent_metric_rollups\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`agent_id\` integer NOT NULL,
	\`bucket_start\` text NOT NULL,
	\`bucket_size_seconds\` integer NOT NULL,
	\`sample_count\` integer DEFAULT 0 NOT NULL,
	\`cpu_avg\` real,
	\`cpu_min\` real,
	\`cpu_max\` real,
	\`cpu_p95\` real,
	\`memory_avg\` real,
	\`memory_min\` real,
	\`memory_max\` real,
	\`memory_p95\` real,
	\`disk_max\` real,
	\`load_avg\` real,
	\`network_delta_json\` text,
	\`threshold_events_json\` text,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`agent_id\`) REFERENCES \`agents\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS \`agent_metric_rollups_agent_bucket_unique_idx\` ON \`agent_metric_rollups\` (\`agent_id\`,\`bucket_start\`,\`bucket_size_seconds\`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`agent_metric_rollups_agent_bucket_idx\` ON \`agent_metric_rollups\` (\`agent_id\`,\`bucket_start\`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`monitor_check_rollups\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`monitor_id\` integer NOT NULL,
	\`bucket_start\` text NOT NULL,
	\`bucket_size_seconds\` integer NOT NULL,
	\`total_checks\` integer DEFAULT 0 NOT NULL,
	\`up_checks\` integer DEFAULT 0 NOT NULL,
	\`down_checks\` integer DEFAULT 0 NOT NULL,
	\`last_status\` text,
	\`response_time_avg\` integer DEFAULT 0,
	\`response_time_p95\` integer DEFAULT 0,
	\`response_time_max\` integer DEFAULT 0,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	FOREIGN KEY (\`monitor_id\`) REFERENCES \`monitors\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS \`monitor_check_rollups_monitor_bucket_unique_idx\` ON \`monitor_check_rollups\` (\`monitor_id\`,\`bucket_start\`,\`bucket_size_seconds\`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`monitor_check_rollups_monitor_bucket_idx\` ON \`monitor_check_rollups\` (\`monitor_id\`,\`bucket_start\`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`monitor_incidents\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`monitor_id\` integer NOT NULL,
	\`from_status\` text,
	\`to_status\` text NOT NULL,
	\`started_at\` text NOT NULL,
	\`ended_at\` text,
	\`reason\` text,
	\`last_error\` text,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	FOREIGN KEY (\`monitor_id\`) REFERENCES \`monitors\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`monitor_incidents_monitor_started_at_idx\` ON \`monitor_incidents\` (\`monitor_id\`,\`started_at\`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`public_status_snapshots\` (
	\`user_id\` integer PRIMARY KEY NOT NULL,
	\`snapshot_json\` text NOT NULL,
	\`etag\` text NOT NULL,
	\`generated_at\` text NOT NULL,
	\`expires_at\` text NOT NULL,
	\`dirty_at\` text,
	\`refresh_after\` text,
	\`refreshing\` integer DEFAULT 0 NOT NULL,
	\`last_error\` text,
	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE \`agents\` ADD \`last_seen_at\` text;
--> statement-breakpoint
ALTER TABLE \`agents\` ADD \`last_state_changed_at\` text;
--> statement-breakpoint
ALTER TABLE \`agents\` ADD \`next_offline_at\` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS \`agents_status_next_offline_at_idx\` ON \`agents\` (\`status\`,\`next_offline_at\`);`
  }
];
