UPDATE `agent_nodes`
SET `collect_interval_ms` = 1000,
	`report_interval_ms` = 60000
WHERE `deleted_at_ms` IS NULL;--> statement-breakpoint
UPDATE `agents`
SET `collect_interval` = 1,
	`report_interval` = 60
WHERE `deleted_at` IS NULL;
