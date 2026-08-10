-- 清理由旧 Seed 写入的 Telegram 测试渠道凭据。
-- Bot 数字 ID 本身不是 Secret；匹配时不在迁移中重复保存已泄露的完整 Token。
UPDATE `notification_channels`
SET
	`name` = CASE
		WHEN `name` = '测试Bot(https://t.me/xugou_bot)'
			THEN '旧默认 Telegram 渠道（凭据已清除）'
		ELSE `name`
	END,
	`config` = '{}',
	`enabled` = 0,
	`updated_at` = CURRENT_TIMESTAMP
WHERE
	`type` = 'telegram'
	AND (
		`name` = '测试Bot(https://t.me/xugou_bot)'
		OR `config` LIKE '%8538953065:%'
	);
--> statement-breakpoint
-- 旧快照可能包含 Monitor 完整配置；部署新白名单投影后强制重新生成。
DELETE FROM `public_status_snapshots`;
