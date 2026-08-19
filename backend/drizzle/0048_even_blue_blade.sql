CREATE TABLE `agent_metric_blocks` (
	`id` integer PRIMARY KEY NOT NULL,
	`agent_id` integer NOT NULL,
	`resolution` integer NOT NULL,
	`bucket_start` integer NOT NULL,
	`point_count` integer NOT NULL,
	`codec` integer NOT NULL,
	`byte_size` integer NOT NULL,
	`data` blob NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_metric_blocks_key_idx` ON `agent_metric_blocks` (`agent_id`,`resolution`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `agent_metric_blocks_gc_idx` ON `agent_metric_blocks` (`resolution`,`bucket_start`);