CREATE TABLE `notification_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`source_event_id` text NOT NULL,
	`type` text NOT NULL,
	`target_id` integer,
	`event_key` text NOT NULL,
	`variables_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_source_event_id_unique_idx` ON `notification_events` (`source_event_id`);--> statement-breakpoint
CREATE INDEX `notification_events_status_updated_at_idx` ON `notification_events` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `notification_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`channel_id` integer NOT NULL,
	`template_id` integer NOT NULL,
	`subject` text NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`available_at` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`provider_status_code` integer,
	`last_error` text,
	`sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `notification_events`(`event_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `notification_templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_messages_event_channel_unique_idx` ON `notification_messages` (`event_id`,`channel_id`);--> statement-breakpoint
CREATE INDEX `notification_messages_status_available_at_idx` ON `notification_messages` (`status`,`available_at`);--> statement-breakpoint
CREATE TABLE `notification_attempts` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`success` integer NOT NULL,
	`provider_status_code` integer,
	`error_category` text,
	`error` text,
	`retryable` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `notification_messages`(`message_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_attempts_message_attempt_unique_idx` ON `notification_attempts` (`message_id`,`attempt_number`);--> statement-breakpoint
CREATE TABLE `notification_cooldowns` (
	`cooldown_key` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`target_id` integer,
	`channel_id` integer NOT NULL,
	`event_key` text NOT NULL,
	`last_sent_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_cooldowns_lookup_idx` ON `notification_cooldowns` (`type`,`target_id`,`channel_id`,`event_key`);--> statement-breakpoint
CREATE TABLE `queue_failures` (
	`failure_id` text PRIMARY KEY NOT NULL,
	`queue_name` text NOT NULL,
	`message_id` text NOT NULL,
	`message_json` text NOT NULL,
	`source_kind` text,
	`source_id` text,
	`delivery_attempts` integer NOT NULL,
	`last_error` text,
	`status` text DEFAULT 'open' NOT NULL,
	`replay_count` integer DEFAULT 0 NOT NULL,
	`replayed_at` text,
	`terminated_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `queue_failures_queue_message_unique_idx` ON `queue_failures` (`queue_name`,`message_id`);--> statement-breakpoint
CREATE INDEX `queue_failures_status_updated_at_idx` ON `queue_failures` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `status_publications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_event_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`etag` text NOT NULL,
	`generated_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `status_publications_source_event_id_unique_idx` ON `status_publications` (`source_event_id`);--> statement-breakpoint
CREATE INDEX `status_publications_generated_at_idx` ON `status_publications` (`generated_at`);
CREATE TABLE `status_publication_state` (
	`singleton_key` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`active_publication_id` integer,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`active_publication_id`) REFERENCES `status_publications`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
