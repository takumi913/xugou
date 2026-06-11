DELETE FROM `monitor_daily_stats`
WHERE `id` NOT IN (
  SELECT max(`id`)
  FROM `monitor_daily_stats`
  GROUP BY `monitor_id`, `date`
);--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_daily_stats_monitor_id_date_unique_idx` ON `monitor_daily_stats` (`monitor_id`,`date`);
