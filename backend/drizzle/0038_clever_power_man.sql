CREATE TABLE `status_components` (
	`page_id` integer NOT NULL,
	`component_type` text NOT NULL,
	`component_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`page_id`, `component_type`, `component_id`),
	FOREIGN KEY (`page_id`) REFERENCES `status_pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `status_components_page_type_order_idx` ON `status_components` (`page_id`,`component_type`,`sort_order`,`component_id`);--> statement-breakpoint
CREATE TABLE `status_pages` (
	`id` integer PRIMARY KEY NOT NULL,
	`singleton_key` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`logo_url` text,
	`custom_css` text,
	`theme` text DEFAULT 'mono' NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `status_pages_singleton_key_unique_idx` ON `status_pages` (`singleton_key`);