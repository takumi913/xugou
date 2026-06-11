CREATE INDEX `agents_created_by_created_at_idx` ON `agents` (`created_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `agents_status_updated_at_idx` ON `agents` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `monitors_active_last_checked_idx` ON `monitors` (`active`,`last_checked`);--> statement-breakpoint
CREATE INDEX `monitors_created_by_created_at_idx` ON `monitors` (`created_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `notification_channels_created_by_id_idx` ON `notification_channels` (`created_by`,`id`);--> statement-breakpoint
CREATE INDEX `notification_history_channel_sent_at_idx` ON `notification_history` (`channel_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `notification_settings_lookup_idx` ON `notification_settings` (`user_id`,`target_type`,`target_id`,`enabled`);--> statement-breakpoint
CREATE INDEX `status_page_config_user_id_idx` ON `status_page_config` (`user_id`);