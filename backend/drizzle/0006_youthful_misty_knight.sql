DROP INDEX `monitors_active_last_checked_idx`;--> statement-breakpoint
ALTER TABLE `monitors` ADD `next_check_at` text;--> statement-breakpoint
UPDATE `monitors`
SET `next_check_at` = CASE
  WHEN `active` = 1 AND `last_checked` IS NOT NULL
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime(`last_checked`, '+' || `interval` || ' seconds'))
  WHEN `active` = 1
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ELSE NULL
END;--> statement-breakpoint
CREATE INDEX `monitors_active_next_check_at_idx` ON `monitors` (`active`,`next_check_at`);
