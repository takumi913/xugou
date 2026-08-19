-- 逐网卡累计计数器基准。旧实现按「所有网卡求和」再差分，接口集合一变（tun0/docker0
-- 这类会来去的接口）总和就掉一截，被当成计数器归零，于是 month += 当前总和，
-- 一次接口消失凭空记进一整个总量。线上 agent 38 的 month_rx 因此长到了
-- last_total_rx 的 19.7 倍。
ALTER TABLE `agent_current_metrics` ADD `traffic_baselines_json` text;--> statement-breakpoint

-- 修复前累计出来的月度值全部不可信，就地清零，让改好的逐网卡逻辑从下一次上报
-- 重新累计。基准列留空 → 首个样本只建基准、不累计，不会把历史计数当成本月新增。
-- 影响范围仅限当前计费周期，下个重置日起数据完整。
UPDATE `agent_current_metrics`
SET `month_rx` = 0,
    `month_tx` = 0,
    `last_total_rx` = NULL,
    `last_total_tx` = NULL,
    `traffic_baselines_json` = NULL;
