ALTER TABLE `monitors` ADD `timeout_ms` integer DEFAULT 30000 NOT NULL;--> statement-breakpoint
UPDATE `monitors`
SET `timeout_ms` = CASE
  WHEN `timeout` > 0 THEN `timeout` * 1000
  ELSE 30000
END;
