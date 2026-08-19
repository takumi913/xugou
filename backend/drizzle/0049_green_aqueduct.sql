-- T8 老表下线：v5 块存储（agent_metric_blocks）已完整承接 agent 指标的写入与读取，
-- 下面 7 张表在本次发版前就已经没有任何读写代码引用。
--
-- 一律用 IF EXISTS：agent_metrics_history_old 是运行时裸 SQL 轮换出来的表，
-- 不在 drizzle 快照里，不同实例上不一定存在。
DROP TABLE IF EXISTS `agent_report_samples`;--> statement-breakpoint
DROP TABLE IF EXISTS `agent_reports`;--> statement-breakpoint
DROP TABLE IF EXISTS `agent_metric_rollups`;--> statement-breakpoint
DROP TABLE IF EXISTS `agent_metrics_history_old`;--> statement-breakpoint
DROP TABLE IF EXISTS `agent_metrics_history`;--> statement-breakpoint
DROP TABLE IF EXISTS `agent_metrics_24h`;--> statement-breakpoint
DROP TABLE IF EXISTS `agent_latest_metrics`;
