CREATE TABLE `notification_template_definitions` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`current_version` integer DEFAULT 1 NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`deleted_at_ms` integer,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_template_definitions_type_default_idx` ON `notification_template_definitions` (`type`,`deleted_at_ms`,`is_default`,`id`);--> statement-breakpoint
CREATE TABLE `notification_template_versions` (
	`template_id` integer NOT NULL,
	`version` integer NOT NULL,
	`subject` text NOT NULL,
	`content` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	PRIMARY KEY(`template_id`, `version`),
	FOREIGN KEY (`template_id`) REFERENCES `notification_template_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
