CREATE TABLE `api_compatibility_hits` (
	`day` text NOT NULL,
	`route_group` text NOT NULL,
	`method` text NOT NULL,
	`status_family` text NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_release_version` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`day`, `route_group`, `method`, `status_family`)
);
--> statement-breakpoint
CREATE INDEX `api_compatibility_hits_group_seen_idx` ON `api_compatibility_hits` (`route_group`,`last_seen_at`);