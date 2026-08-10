CREATE TABLE `security_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`outcome` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`subject_type` text,
	`subject_id` text,
	`request_id` text,
	`ip_digest` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `security_audit_events_created_at_idx` ON `security_audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `security_audit_events_event_created_at_idx` ON `security_audit_events` (`event_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `security_rate_limits` (
	`key_digest` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`attempts` integer NOT NULL,
	`window_started_at` text NOT NULL,
	`blocked_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `security_rate_limits_scope_blocked_idx` ON `security_rate_limits` (`scope`,`blocked_until`);