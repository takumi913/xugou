export const CONTRACT_STATIC_DROP_TABLES = [
  "status_page_monitors",
  "status_page_agents",
  "status_page_config",
  "public_status_snapshots",
  "notification_history",
  "notification_settings",
  "agent_latest_metrics",
  "agent_metrics_24h",
  "agent_metrics_history",
  "monitor_status_history_24h",
  "monitor_daily_stats",
] as const;

export const CONTRACT_AGENT_COLUMNS_TO_DROP = [
  "name",
  "status",
  "hostname",
  "ip_addresses",
  "os",
  "version",
  "keepalive",
  "last_seen_at",
  "last_state_changed_at",
  "next_offline_at",
  "history_partition_id",
  "collect_interval",
  "report_interval",
  "region",
  "geo_latitude",
  "geo_longitude",
  "geo_city",
  "geo_region_name",
  "boot_time",
  "price",
  "currency",
  "billing_cycle",
  "expire_date",
  "auto_renewal",
  "is_hidden",
  "traffic_limit_gb",
  "traffic_reset_day",
  "traffic_calc_type",
  "auto_update",
  "group_name",
  "tags",
  "sort_order",
  "deleted_at",
] as const;

export const CONTRACT_MONITOR_COLUMNS_TO_DROP = [
  "name",
  "url",
  "method",
  "interval",
  "timeout",
  "timeout_ms",
  "expected_status",
  "headers",
  "body",
  "active",
  "status",
  "response_time",
  "last_checked",
  "next_check_at",
  "deleted_at",
  "sort_order",
] as const;

export function contractDynamicHistoryIdentifier(value: string) {
  if (!/^agent_metrics_history(?:_old|_[0-9]+)$/.test(value)) {
    throw new Error(`Contract bundle contains an unsafe dynamic table: ${value}`);
  }
  return `"${value}"`;
}

function dropColumns(table: string, columns: readonly string[]) {
  return columns.map((column) => `ALTER TABLE ${table} DROP COLUMN ${column};`);
}

export function contractSchemaStatements(dynamicLegacyTables: string[]) {
  const dynamicTables = [...new Set(dynamicLegacyTables)].map(
    contractDynamicHistoryIdentifier
  );
  return [
    ...CONTRACT_STATIC_DROP_TABLES.map(
      (table) => `DROP TABLE IF EXISTS ${table};`
    ),
    ...dynamicTables.map((table) => `DROP TABLE IF EXISTS ${table};`),
    `DROP INDEX IF EXISTS agents_status_updated_at_idx;`,
    `DROP INDEX IF EXISTS agents_status_next_offline_at_idx;`,
    `UPDATE agents SET token = 'contract-anchor:' || CAST(id AS TEXT);`,
    `ALTER TABLE agents RENAME COLUMN token TO anchor_nonce;`,
    ...dropColumns("agents", CONTRACT_AGENT_COLUMNS_TO_DROP),
    `DROP INDEX IF EXISTS monitors_active_next_check_at_idx;`,
    ...dropColumns("monitors", CONTRACT_MONITOR_COLUMNS_TO_DROP),
    `ALTER TABLE notification_channels DROP COLUMN config;`,
    `ALTER TABLE notification_templates DROP COLUMN subject;`,
    `ALTER TABLE notification_templates DROP COLUMN content;`,
  ];
}
