CREATE TABLE `agent_metrics_history` (
	`id` integer PRIMARY KEY NOT NULL,
	`agent_id` integer NOT NULL,
	`timestamp` text,
	`cpu_usage` real,
	`cpu_cores` integer,
	`cpu_model` text,
	`memory_total` integer,
	`memory_used` integer,
	`memory_free` integer,
	`memory_usage_rate` real,
	`load_1` real,
	`load_5` real,
	`load_15` real,
	`disk_metrics` text,
	`network_metrics` text
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `history_partition_id` integer DEFAULT 0;