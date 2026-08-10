-- Runtime bootstrap defaults are data migrations so Worker requests never run DDL or seed loops.
DELETE FROM users WHERE id <> 1;
--> statement-breakpoint
INSERT INTO notification_templates(
  name, type, subject, content, is_default, created_at, updated_at
)
SELECT
  'Monitor监控模板',
  'monitor',
  '【${status}】${name} 监控状态变更',
  '🔔 网站监控状态变更通知\n\n📊 服务: ${name}\n🔄 状态: ${status} (之前: ${previous_status})\n🕒 时间: ${time}\n\n🔗 地址: ${url}\n⏱️ 响应时间: ${response_time}\n📝 实际状态码: ${status_code}\n🎯 期望状态码: ${expected_status}\n\n❗ 错误信息: ${error}',
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM notification_templates WHERE type = 'monitor' AND is_default = 1
);
--> statement-breakpoint
INSERT INTO notification_templates(
  name, type, subject, content, is_default, created_at, updated_at
)
SELECT
  'Agent监控模板',
  'agent',
  '【${status}】${name} 客户端状态变更',
  '🔔 客户端状态变更通知\n\n📊 主机: ${name}\n🔄 状态: ${status} (之前: ${previous_status})\n🕒 时间: ${time}\n\n🖥️ 主机信息:\n  主机名: ${hostname}\n  IP地址: ${ip_addresses}\n  操作系统: ${os}\n\n❗ 错误信息: ${error}',
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM notification_templates WHERE type = 'agent' AND is_default = 1
);
--> statement-breakpoint
INSERT INTO notification_settings(
  target_type, target_id, enabled, on_down, on_recovery, on_offline,
  on_cpu_threshold, cpu_threshold, on_memory_threshold, memory_threshold,
  on_disk_threshold, disk_threshold, cooldown_minutes, channels,
  created_at, updated_at
)
SELECT
  'global-monitor', NULL, 0, 1, 1, 1,
  0, 90, 0, 85,
  0, 90, 30, '[]',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM notification_settings WHERE target_type = 'global-monitor' AND target_id IS NULL
);
--> statement-breakpoint
INSERT INTO notification_settings(
  target_type, target_id, enabled, on_down, on_recovery, on_offline,
  on_cpu_threshold, cpu_threshold, on_memory_threshold, memory_threshold,
  on_disk_threshold, disk_threshold, cooldown_minutes, channels,
  created_at, updated_at
)
SELECT
  'global-agent', NULL, 0, 1, 1, 1,
  1, 80, 1, 80,
  1, 90, 30, '[]',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM notification_settings WHERE target_type = 'global-agent' AND target_id IS NULL
);
--> statement-breakpoint
INSERT INTO status_page_config(
  singleton_key, title, description, logo_url, custom_css, theme,
  created_at, updated_at
)
SELECT
  1, '系统状态', '实时监控系统运行状态', '', '', 'mono',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM status_page_config);
--> statement-breakpoint
INSERT OR IGNORE INTO status_page_monitors(config_id, monitor_id)
SELECT c.id, m.id
FROM status_page_config c
CROSS JOIN monitors m
WHERE c.singleton_key = 1;
--> statement-breakpoint
INSERT OR IGNORE INTO status_page_agents(config_id, agent_id)
SELECT c.id, a.id
FROM status_page_config c
CROSS JOIN agents a
WHERE c.singleton_key = 1 AND a.deleted_at IS NULL;
