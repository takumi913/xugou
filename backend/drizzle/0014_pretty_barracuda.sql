ALTER TABLE `agents` ADD `auto_update` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `agents` ADD `group_name` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `tags` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `sort_order` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `monitors` ADD `sort_order` integer DEFAULT 0;