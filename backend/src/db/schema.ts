import {
  int,
  sqliteTable,
  text,
  real,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// 用户表
export const users = sqliteTable("users", {
  id: int("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  email: text("email"),
  role: text("role").notNull(),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

// 监控表
export const monitors = sqliteTable(
  "monitors",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    method: text("method").notNull(),
    interval: int("interval").notNull(),
    timeout: int("timeout").notNull(),
    expected_status: int("expected_status").notNull(),
    headers: text("headers").notNull(),
    body: text("body"),
    created_by: int("created_by")
      .notNull()
      .references(() => users.id),
    active: int("active").notNull(), // SQLite 没有布尔类型，用 int 代替
    status: text("status").default("pending"),
    response_time: int("response_time").default(0),
    last_checked: text("last_checked"),
    next_check_at: text("next_check_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    activeNextCheckAtIdx: index("monitors_active_next_check_at_idx").on(
      table.active,
      table.next_check_at
    ),
    createdByCreatedAtIdx: index("monitors_created_by_created_at_idx").on(
      table.created_by,
      table.created_at
    ),
  })
);

// 24小时监控状态历史表
export const monitorStatusHistory24h = sqliteTable(
  "monitor_status_history_24h",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    monitor_id: int("monitor_id")
      .notNull()
      .references(() => monitors.id),
    status: text("status").notNull(),
    timestamp: text("timestamp").default("CURRENT_TIMESTAMP"),
    response_time: int("response_time"),
    status_code: int("status_code"),
    error: text("error"),
  },
  (table) => ({
    // monitor_id 和 timestamp 的联合索引，用于优化按监控项和时间查询的性能
    monitorTimestampIdx: index(
      "monitor_status_history_24h_monitor_timestamp_idx"
    ).on(table.monitor_id, table.timestamp),
    // timestamp 单独索引，用于优化按时间排序和范围查询的性能
    timestampIdx: index("monitor_status_history_24h_timestamp_idx").on(
      table.timestamp
    ),
  })
);

// 监控每日统计表
export const monitorDailyStats = sqliteTable(
  "monitor_daily_stats",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    monitor_id: int("monitor_id")
      .notNull()
      .references(() => monitors.id),
    date: text("date").notNull(),
    total_checks: int("total_checks").notNull().default(0),
    up_checks: int("up_checks").notNull().default(0),
    down_checks: int("down_checks").notNull().default(0),
    avg_response_time: int("avg_response_time").default(0),
    min_response_time: int("min_response_time").default(0),
    max_response_time: int("max_response_time").default(0),
    availability: real("availability").default(0),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    monitorDateIdx: index("monitor_daily_stats_monitor_id_date_idx").on(
      table.monitor_id,
      table.date
    ),
    monitorDateUniqueIdx: uniqueIndex(
      "monitor_daily_stats_monitor_id_date_unique_idx"
    ).on(table.monitor_id, table.date),
  })
);

// 客户端表
export const agents = sqliteTable(
  "agents",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    token: text("token").notNull().unique(),
    created_by: int("created_by")
      .notNull()
      .references(() => users.id),
    status: text("status").default("inactive"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    hostname: text("hostname"),
    ip_addresses: text("ip_addresses"),
    os: text("os"),
    version: text("version"),
    keepalive: text("keepalive"),
    last_seen_at: text("last_seen_at"),
    last_state_changed_at: text("last_state_changed_at"),
    next_offline_at: text("next_offline_at"),
  },
  (table) => ({
    createdByCreatedAtIdx: index("agents_created_by_created_at_idx").on(
      table.created_by,
      table.created_at
    ),
    statusUpdatedAtIdx: index("agents_status_updated_at_idx").on(
      table.status,
      table.updated_at
    ),
    statusNextOfflineAtIdx: index("agents_status_next_offline_at_idx").on(
      table.status,
      table.next_offline_at
    ),
  })
);

// 客户端最新资源指标表
export const agentLatestMetrics = sqliteTable(
  "agent_latest_metrics",
  {
    agent_id: int("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    metrics_json: text("metrics_json").notNull(),
    collected_at: text("collected_at"),
    reported_at: text("reported_at").notNull(),
    cpu_usage: real("cpu_usage"),
    memory_usage_rate: real("memory_usage_rate"),
    disk_usage_rate: real("disk_usage_rate"),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    reportedAtIdx: index("agent_latest_metrics_reported_at_idx").on(
      table.reported_at
    ),
  })
);

// 客户端资源指标表
export const agentMetrics24h = sqliteTable(
  "agent_metrics_24h",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    agent_id: int("agent_id")
      .notNull()
      .references(() => agents.id),
    timestamp: text("timestamp").default("CURRENT_TIMESTAMP"),
    cpu_usage: real("cpu_usage"),
    cpu_cores: int("cpu_cores"),
    cpu_model: text("cpu_model"),
    memory_total: int("memory_total"),
    memory_used: int("memory_used"),
    memory_free: int("memory_free"),
    memory_usage_rate: real("memory_usage_rate"),
    load_1: real("load_1"),
    load_5: real("load_5"),
    load_15: real("load_15"),
    disk_metrics: text("disk_metrics"),
    network_metrics: text("network_metrics"),
  },
  (table) => ({
    // agent_id 和 timestamp 的联合索引，用于优化按代理和时间查询的性能
    agentTimestampIdx: index("agent_metrics_24h_agent_timestamp_idx").on(
      table.agent_id,
      table.timestamp
    ),
  })
);

// 客户端聚合指标表
export const agentMetricRollups = sqliteTable(
  "agent_metric_rollups",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    agent_id: int("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    bucket_start: text("bucket_start").notNull(),
    bucket_size_seconds: int("bucket_size_seconds").notNull(),
    sample_count: int("sample_count").notNull().default(0),
    cpu_avg: real("cpu_avg"),
    cpu_min: real("cpu_min"),
    cpu_max: real("cpu_max"),
    cpu_p95: real("cpu_p95"),
    memory_avg: real("memory_avg"),
    memory_min: real("memory_min"),
    memory_max: real("memory_max"),
    memory_p95: real("memory_p95"),
    disk_max: real("disk_max"),
    load_avg: real("load_avg"),
    network_delta_json: text("network_delta_json"),
    threshold_events_json: text("threshold_events_json"),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    agentBucketUniqueIdx: uniqueIndex(
      "agent_metric_rollups_agent_bucket_unique_idx"
    ).on(table.agent_id, table.bucket_start, table.bucket_size_seconds),
    agentBucketIdx: index("agent_metric_rollups_agent_bucket_idx").on(
      table.agent_id,
      table.bucket_start
    ),
  })
);

// 状态页配置表
export const statusPageConfig = sqliteTable(
  "status_page_config",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    user_id: int("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull().default("系统状态"),
    description: text("description").default("系统当前运行状态"),
    logo_url: text("logo_url").default(""),
    custom_css: text("custom_css").default(""),
    created_at: text("created_at").default("CURRENT_TIMESTAMP"),
    updated_at: text("updated_at").default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    userIdx: index("status_page_config_user_id_idx").on(table.user_id),
  })
);

// 状态页监控项关联表
export const statusPageMonitors = sqliteTable(
  "status_page_monitors",
  {
    config_id: int("config_id")
      .notNull()
      .references(() => statusPageConfig.id, { onDelete: "cascade" }),
    monitor_id: int("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.config_id, table.monitor_id] }),
  })
);

// 状态页客户端关联表
export const statusPageAgents = sqliteTable(
  "status_page_agents",
  {
    config_id: int("config_id")
      .notNull()
      .references(() => statusPageConfig.id, { onDelete: "cascade" }),
    agent_id: int("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.config_id, table.agent_id] }),
  })
);

// HTTP 监控聚合检查表
export const monitorCheckRollups = sqliteTable(
  "monitor_check_rollups",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    monitor_id: int("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    bucket_start: text("bucket_start").notNull(),
    bucket_size_seconds: int("bucket_size_seconds").notNull(),
    total_checks: int("total_checks").notNull().default(0),
    up_checks: int("up_checks").notNull().default(0),
    down_checks: int("down_checks").notNull().default(0),
    last_status: text("last_status"),
    response_time_avg: int("response_time_avg").default(0),
    response_time_p95: int("response_time_p95").default(0),
    response_time_max: int("response_time_max").default(0),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    monitorBucketUniqueIdx: uniqueIndex(
      "monitor_check_rollups_monitor_bucket_unique_idx"
    ).on(table.monitor_id, table.bucket_start, table.bucket_size_seconds),
    monitorBucketIdx: index("monitor_check_rollups_monitor_bucket_idx").on(
      table.monitor_id,
      table.bucket_start
    ),
  })
);

// HTTP 监控状态变化事件表
export const monitorIncidents = sqliteTable(
  "monitor_incidents",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    monitor_id: int("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    from_status: text("from_status"),
    to_status: text("to_status").notNull(),
    started_at: text("started_at").notNull(),
    ended_at: text("ended_at"),
    reason: text("reason"),
    last_error: text("last_error"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    monitorStartedAtIdx: index("monitor_incidents_monitor_started_at_idx").on(
      table.monitor_id,
      table.started_at
    ),
  })
);

// 公共状态页快照表
export const publicStatusSnapshots = sqliteTable("public_status_snapshots", {
  user_id: int("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  snapshot_json: text("snapshot_json").notNull(),
  etag: text("etag").notNull(),
  generated_at: text("generated_at").notNull(),
  expires_at: text("expires_at").notNull(),
  dirty_at: text("dirty_at"),
  refresh_after: text("refresh_after"),
  refreshing: int("refreshing").notNull().default(0),
  last_error: text("last_error"),
});

// 通知渠道表
export const notificationChannels = sqliteTable(
  "notification_channels",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    config: text("config").notNull(),
    enabled: int("enabled").notNull().default(1),
    created_by: int("created_by")
      .notNull()
      .references(() => users.id),
    created_at: text("created_at").default("CURRENT_TIMESTAMP"),
    updated_at: text("updated_at").default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    createdByIdIdx: index("notification_channels_created_by_id_idx").on(
      table.created_by,
      table.id
    ),
  })
);

// 通知模板表
export const notificationTemplates = sqliteTable("notification_templates", {
  id: int("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  subject: text("subject").notNull(),
  content: text("content").notNull(),
  is_default: int("is_default").notNull().default(0),
  created_by: int("created_by")
    .notNull()
    .references(() => users.id),
  created_at: text("created_at").default("CURRENT_TIMESTAMP"),
  updated_at: text("updated_at").default("CURRENT_TIMESTAMP"),
});

// 通知设置表
export const notificationSettings = sqliteTable(
  "notification_settings",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    user_id: int("user_id")
      .notNull()
      .references(() => users.id),
    target_type: text("target_type").notNull().default("global"),
    target_id: int("target_id"),
    enabled: int("enabled").notNull().default(1),
    on_down: int("on_down").notNull().default(1),
    on_recovery: int("on_recovery").notNull().default(1),
    on_offline: int("on_offline").notNull().default(1),
    on_cpu_threshold: int("on_cpu_threshold").notNull().default(0),
    cpu_threshold: int("cpu_threshold").notNull().default(90),
    on_memory_threshold: int("on_memory_threshold").notNull().default(0),
    memory_threshold: int("memory_threshold").notNull().default(85),
    on_disk_threshold: int("on_disk_threshold").notNull().default(0),
    disk_threshold: int("disk_threshold").notNull().default(90),
    cooldown_minutes: int("cooldown_minutes").notNull().default(30),
    channels: text("channels").default("[]"),
    created_at: text("created_at").default("CURRENT_TIMESTAMP"),
    updated_at: text("updated_at").default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    lookupIdx: index("notification_settings_lookup_idx").on(
      table.user_id,
      table.target_type,
      table.target_id,
      table.enabled
    ),
  })
);

// 通知历史记录表
export const notificationHistory = sqliteTable(
  "notification_history",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    target_id: int("target_id"),
    channel_id: int("channel_id")
      .notNull()
      .references(() => notificationChannels.id),
    template_id: int("template_id")
      .notNull()
      .references(() => notificationTemplates.id),
    status: text("status").notNull(),
    content: text("content").notNull(),
    error: text("error"),
    sent_at: text("sent_at").default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    channelSentAtIdx: index("notification_history_channel_sent_at_idx").on(
      table.channel_id,
      table.sent_at
    ),
  })
);

// 新增：应用设置表
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});
