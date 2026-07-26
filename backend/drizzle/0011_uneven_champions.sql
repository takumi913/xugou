ALTER TABLE `agents` ADD `collect_interval` integer DEFAULT 60;--> statement-breakpoint
ALTER TABLE `agents` ADD `report_interval` integer DEFAULT 300;--> statement-breakpoint
ALTER TABLE `agents` ADD `region` text;