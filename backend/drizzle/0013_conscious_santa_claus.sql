ALTER TABLE `agent_latest_metrics` ADD `network_rx_speed` real;--> statement-breakpoint
ALTER TABLE `agent_latest_metrics` ADD `network_tx_speed` real;--> statement-breakpoint
ALTER TABLE `agent_latest_metrics` ADD `month_rx` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `agent_latest_metrics` ADD `month_tx` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `agent_latest_metrics` ADD `last_total_rx` integer;--> statement-breakpoint
ALTER TABLE `agent_latest_metrics` ADD `last_total_tx` integer;--> statement-breakpoint
ALTER TABLE `agent_latest_metrics` ADD `month_reset_at` text;--> statement-breakpoint
ALTER TABLE `agent_metrics_history` ADD `network_rx_speed` real;--> statement-breakpoint
ALTER TABLE `agent_metrics_history` ADD `network_tx_speed` real;--> statement-breakpoint
ALTER TABLE `agents` ADD `traffic_limit_gb` real;--> statement-breakpoint
ALTER TABLE `agents` ADD `traffic_reset_day` integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE `agents` ADD `traffic_calc_type` text DEFAULT 'sum';