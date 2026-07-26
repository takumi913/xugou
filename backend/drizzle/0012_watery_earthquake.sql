ALTER TABLE `agent_latest_metrics` ADD `swap_total` integer;--> statement-breakpoint
ALTER TABLE `agent_latest_metrics` ADD `swap_used` integer;--> statement-breakpoint
ALTER TABLE `agent_latest_metrics` ADD `process_count` integer;--> statement-breakpoint
ALTER TABLE `agent_latest_metrics` ADD `tcp_connections` integer;--> statement-breakpoint
ALTER TABLE `agent_latest_metrics` ADD `udp_connections` integer;--> statement-breakpoint
ALTER TABLE `agent_latest_metrics` ADD `ping_json` text;--> statement-breakpoint
ALTER TABLE `agent_latest_metrics` ADD `ipv4_reachable` integer;--> statement-breakpoint
ALTER TABLE `agent_latest_metrics` ADD `ipv6_reachable` integer;--> statement-breakpoint
ALTER TABLE `agent_metrics_history` ADD `swap_total` integer;--> statement-breakpoint
ALTER TABLE `agent_metrics_history` ADD `swap_used` integer;--> statement-breakpoint
ALTER TABLE `agent_metrics_history` ADD `process_count` integer;--> statement-breakpoint
ALTER TABLE `agent_metrics_history` ADD `tcp_connections` integer;--> statement-breakpoint
ALTER TABLE `agent_metrics_history` ADD `udp_connections` integer;--> statement-breakpoint
ALTER TABLE `agent_metrics_history` ADD `ping_json` text;--> statement-breakpoint
ALTER TABLE `agent_metrics_history` ADD `ipv4_reachable` integer;--> statement-breakpoint
ALTER TABLE `agent_metrics_history` ADD `ipv6_reachable` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `boot_time` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `price` real;--> statement-breakpoint
ALTER TABLE `agents` ADD `currency` text DEFAULT 'USD';--> statement-breakpoint
ALTER TABLE `agents` ADD `billing_cycle` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `expire_date` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `auto_renewal` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `agents` ADD `is_hidden` integer DEFAULT 0;