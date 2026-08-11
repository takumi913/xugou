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
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

// 管理端不透明会话。浏览器持有随机令牌，数据库只保存 HMAC 摘要。
export const adminSessions = sqliteTable(
  "admin_sessions",
  {
    token_digest: text("token_digest").primaryKey(),
    user_id: int("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires_at: text("expires_at").notNull(),
    last_seen_at: text("last_seen_at").notNull(),
    revoked_at: text("revoked_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    userExpiresAtIdx: index("admin_sessions_user_expires_at_idx").on(
      table.user_id,
      table.expires_at
    ),
    expiresAtIdx: index("admin_sessions_expires_at_idx").on(table.expires_at),
  })
);

// 安全敏感操作的 D1 原子限流状态；key 为 HMAC 摘要，不保存用户名或 IP 原文。
export const securityRateLimits = sqliteTable(
  "security_rate_limits",
  {
    key_digest: text("key_digest").primaryKey(),
    scope: text("scope").notNull(),
    attempts: int("attempts").notNull(),
    window_started_at: text("window_started_at").notNull(),
    blocked_until: text("blocked_until"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    scopeBlockedIdx: index("security_rate_limits_scope_blocked_idx").on(
      table.scope,
      table.blocked_until
    ),
  })
);

// 结构化安全审计事件；metadata 只允许调用方写入非敏感标量。
export const securityAuditEvents = sqliteTable(
  "security_audit_events",
  {
    id: text("id").primaryKey(),
    event_type: text("event_type").notNull(),
    outcome: text("outcome").notNull(),
    actor_type: text("actor_type").notNull(),
    actor_id: text("actor_id"),
    subject_type: text("subject_type"),
    subject_id: text("subject_id"),
    request_id: text("request_id"),
    ip_digest: text("ip_digest"),
    metadata_json: text("metadata_json").notNull().default("{}"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    createdAtIdx: index("security_audit_events_created_at_idx").on(
      table.created_at
    ),
    eventCreatedAtIdx: index(
      "security_audit_events_event_created_at_idx"
    ).on(table.event_type, table.created_at),
  })
);

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
    timeout_ms: int("timeout_ms").notNull().default(30000),
    expected_status: int("expected_status").notNull(),
    headers: text("headers").notNull(),
    body: text("body"),
    active: int("active").notNull(), // SQLite 没有布尔类型，用 int 代替
    status: text("status").default("pending"),
    response_time: int("response_time").default(0),
    last_checked: text("last_checked"),
    next_check_at: text("next_check_at"),
    deleted_at: text("deleted_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    // 手动排序权重（列表按 sort_order asc, id asc）
    sort_order: int("sort_order").default(0),
  },
  (table) => ({
    activeNextCheckAtIdx: index("monitors_active_next_check_at_idx").on(
      table.active,
      table.next_check_at
    ),
    createdAtIdx: index("monitors_created_at_idx").on(table.created_at),
  })
);

// v2 Monitor 配置事实；旧 monitors 在兼容窗口内作为同 ID 回切投影。
export const monitorDefinitions = sqliteTable(
  "monitor_definitions",
  {
    id: int("id").primaryKey(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    method: text("method").notNull(),
    headers_json: text("headers_json").notNull().default("{}"),
    body: text("body"),
    interval_ms: int("interval_ms").notNull(),
    timeout_ms: int("timeout_ms").notNull(),
    expected_status: int("expected_status").notNull(),
    active: int("active").notNull().default(1),
    sort_order: int("sort_order").notNull().default(0),
    created_at_ms: int("created_at_ms").notNull(),
    updated_at_ms: int("updated_at_ms").notNull(),
    deleted_at_ms: int("deleted_at_ms"),
  },
  (table) => ({
    activeCreatedIdx: index("monitor_definitions_active_created_idx").on(
      table.active,
      table.created_at_ms
    ),
  })
);

// v2 Monitor 高频运行态；调度与检查只更新本表，避免覆盖配置编辑。
export const monitorRuntime = sqliteTable(
  "monitor_runtime",
  {
    monitor_id: int("monitor_id")
      .primaryKey()
      .references(() => monitorDefinitions.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    response_time_ms: int("response_time_ms").notNull().default(0),
    last_checked_at_ms: int("last_checked_at_ms"),
    next_due_at_ms: int("next_due_at_ms"),
    version: int("version").notNull().default(0),
    created_at_ms: int("created_at_ms").notNull(),
    updated_at_ms: int("updated_at_ms").notNull(),
  },
  (table) => ({
    nextDueIdx: index("monitor_runtime_next_due_idx").on(table.next_due_at_ms),
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

// Queue 驱动的不可变检查样本；job_id 同时是业务幂等键。
export const monitorCheckSamples = sqliteTable(
  "monitor_check_samples",
  {
    job_id: text("job_id").primaryKey(),
    monitor_id: int("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    scheduled_for_ms: int("scheduled_for_ms").notNull(),
    checked_at: text("checked_at").notNull(),
    status: text("status").notNull(),
    response_time_ms: int("response_time_ms").notNull(),
    status_code: int("status_code"),
    error: text("error"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    monitorCheckedIdx: index("monitor_check_samples_monitor_checked_at_idx").on(
      table.monitor_id,
      table.checked_at
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
    // 历史指标分区 ID（1-900），历史行主键 = partitionId * 10^13 + YYMMDDHHmmss
    history_partition_id: int("history_partition_id").default(0),
    // 旧表 DDL 保留 60 秒默认值以避免仅为改默认值重建父表并级联凭据；
    // 运行时事实源 agent_nodes 始终显式写入 1 秒采集配置。
    collect_interval: int("collect_interval").default(60),
    report_interval: int("report_interval").default(60),
    // 上报来源地区（Cloudflare request.cf.country，ISO 3166-1 两位码）
    region: text("region"),
    // 上报来源地理位置（Cloudflare request.cf.latitude/longitude/city/region，
    // 城市级精度，仅管理端使用；公开状态页白名单绝不输出这些字段）
    geo_latitude: real("geo_latitude"),
    geo_longitude: real("geo_longitude"),
    geo_city: text("geo_city"),
    geo_region_name: text("geo_region_name"),
    // 主机启动时间（Unix 秒，探针上报的稳定元数据）
    boot_time: int("boot_time"),
    // 账单信息：价格/币种/计费周期（monthly/quarterly/yearly/once）/到期日（YYYY-MM-DD）/自动续费
    price: real("price"),
    currency: text("currency").default("USD"),
    billing_cycle: text("billing_cycle"),
    expire_date: text("expire_date"),
    auto_renewal: int("auto_renewal").default(0),
    // 公开状态页隐藏开关（1=即使被勾选进状态页也不对外展示）
    is_hidden: int("is_hidden").default(0),
    // 流量管理：月流量上限（GB，空=不限）/ 重置日（1-28，UTC）/ 计费方式（sum|rx|tx）
    traffic_limit_gb: real("traffic_limit_gb"),
    traffic_reset_day: int("traffic_reset_day").default(1),
    traffic_calc_type: text("traffic_calc_type").default("sum"),
    // 服务端触发探针自升级开关（协议 v3 起在上报响应中附加 update=1）
    auto_update: int("auto_update").default(0),
    // 分组名（空=归入默认「客户端监控」段）与标签（逗号分隔）
    group_name: text("group_name"),
    tags: text("tags"),
    // 手动排序权重（列表按 sort_order asc, id asc）
    sort_order: int("sort_order").default(0),
    // 软删除时间；删除后保留历史数据并吊销凭据。
    deleted_at: text("deleted_at"),
  },
  (table) => ({
    createdAtIdx: index("agents_created_at_idx").on(table.created_at),
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

// v2 Agent 管理配置；凭据继续由 agent_credentials 独立保存。
export const agentNodes = sqliteTable(
  "agent_nodes",
  {
    id: int("id").primaryKey(),
    name: text("name").notNull(),
    collect_interval_ms: int("collect_interval_ms").notNull(),
    report_interval_ms: int("report_interval_ms").notNull(),
    group_name: text("group_name"),
    tags_json: text("tags_json").notNull().default("[]"),
    price: real("price"),
    currency: text("currency"),
    billing_cycle: text("billing_cycle"),
    expire_date: text("expire_date"),
    auto_renewal: int("auto_renewal").notNull().default(0),
    is_hidden: int("is_hidden").notNull().default(0),
    traffic_limit_gb: real("traffic_limit_gb"),
    traffic_reset_day: int("traffic_reset_day").notNull().default(1),
    traffic_calc_type: text("traffic_calc_type").notNull().default("sum"),
    auto_update: int("auto_update").notNull().default(0),
    sort_order: int("sort_order").notNull().default(0),
    created_at_ms: int("created_at_ms").notNull(),
    updated_at_ms: int("updated_at_ms").notNull(),
    deleted_at_ms: int("deleted_at_ms"),
  },
  (table) => ({
    activeCreatedIdx: index("agent_nodes_active_created_idx").on(
      table.deleted_at_ms,
      table.created_at_ms
    ),
  })
);

// v2 Agent 高频心跳与运行态，与管理员配置写入隔离。
export const agentRuntime = sqliteTable(
  "agent_runtime",
  {
    agent_id: int("agent_id")
      .primaryKey()
      .references(() => agentNodes.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("inactive"),
    hostname: text("hostname"),
    ip_addresses_json: text("ip_addresses_json").notNull().default("[]"),
    os: text("os"),
    agent_version: text("agent_version"),
    keepalive_seconds: int("keepalive_seconds"),
    boot_time: int("boot_time"),
    last_seen_at_ms: int("last_seen_at_ms"),
    last_state_changed_at_ms: int("last_state_changed_at_ms"),
    next_offline_at_ms: int("next_offline_at_ms"),
    region: text("region"),
    geo_latitude: real("geo_latitude"),
    geo_longitude: real("geo_longitude"),
    geo_city: text("geo_city"),
    geo_region_name: text("geo_region_name"),
    version: int("version").notNull().default(0),
    created_at_ms: int("created_at_ms").notNull(),
    updated_at_ms: int("updated_at_ms").notNull(),
  },
  (table) => ({
    statusOfflineIdx: index("agent_runtime_status_offline_idx").on(
      table.status,
      table.next_offline_at_ms
    ),
  })
);

// Agent 长期凭据。原始 Token 只存在于 Agent 本地，服务端保存 pepper HMAC 摘要。
export const agentCredentials = sqliteTable(
  "agent_credentials",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    agent_id: int("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    token_digest: text("token_digest").notNull(),
    token_hint: text("token_hint").notNull(),
    last_used_at: text("last_used_at"),
    revoked_at: text("revoked_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    tokenDigestUniqueIdx: uniqueIndex(
      "agent_credentials_token_digest_unique_idx"
    ).on(table.token_digest),
    agentRevokedAtIdx: index("agent_credentials_agent_revoked_at_idx").on(
      table.agent_id,
      table.revoked_at
    ),
  })
);

// 管理端签发的一次性注册令牌；注册成功后同一明文 Token 继续作为旧 Agent 的长期凭据。
export const agentEnrollmentTokens = sqliteTable(
  "agent_enrollment_tokens",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    token_digest: text("token_digest").notNull(),
    issued_by: int("issued_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agent_id: int("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    expires_at: text("expires_at").notNull(),
    used_at: text("used_at"),
    revoked_at: text("revoked_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    tokenDigestUniqueIdx: uniqueIndex(
      "agent_enrollment_tokens_token_digest_unique_idx"
    ).on(table.token_digest),
    expiryStateIdx: index("agent_enrollment_tokens_expiry_state_idx").on(
      table.expires_at,
      table.used_at,
      table.revoked_at
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
    swap_total: int("swap_total"),
    swap_used: int("swap_used"),
    process_count: int("process_count"),
    tcp_connections: int("tcp_connections"),
    udp_connections: int("udp_connections"),
    ping_json: text("ping_json"),
    ipv4_reachable: int("ipv4_reachable"),
    ipv6_reachable: int("ipv6_reachable"),
    updated_at: text("updated_at").notNull(),
    // 服务端计算的实时网速（bytes/s，无法计算时为空）
    network_rx_speed: real("network_rx_speed"),
    network_tx_speed: real("network_tx_speed"),
    // 月流量累计状态（字节；last_total_* 为上次上报的累计计数器基准）
    month_rx: int("month_rx").default(0),
    month_tx: int("month_tx").default(0),
    last_total_rx: int("last_total_rx"),
    last_total_tx: int("last_total_tx"),
    // 当前流量周期起点（UTC，YYYY-MM-DD）
    month_reset_at: text("month_reset_at"),
  },
  (table) => ({
    reportedAtIdx: index("agent_latest_metrics_reported_at_idx").on(
      table.reported_at
    ),
  })
);

// v2 Agent 当前指标；时间统一为 Unix 毫秒，兼容期与 agent_latest_metrics 双写。
export const agentCurrentMetrics = sqliteTable(
  "agent_current_metrics",
  {
    agent_id: int("agent_id")
      .primaryKey()
      .references(() => agentNodes.id, { onDelete: "cascade" }),
    metrics_json: text("metrics_json").notNull(),
    collected_at_ms: int("collected_at_ms"),
    reported_at_ms: int("reported_at_ms").notNull(),
    cpu_usage: real("cpu_usage"),
    memory_usage_rate: real("memory_usage_rate"),
    disk_usage_rate: real("disk_usage_rate"),
    swap_total: int("swap_total"),
    swap_used: int("swap_used"),
    process_count: int("process_count"),
    tcp_connections: int("tcp_connections"),
    udp_connections: int("udp_connections"),
    ping_json: text("ping_json"),
    ipv4_reachable: int("ipv4_reachable"),
    ipv6_reachable: int("ipv6_reachable"),
    network_rx_speed: real("network_rx_speed"),
    network_tx_speed: real("network_tx_speed"),
    month_rx: int("month_rx").notNull().default(0),
    month_tx: int("month_tx").notNull().default(0),
    last_total_rx: int("last_total_rx"),
    last_total_tx: int("last_total_tx"),
    traffic_period_start: text("traffic_period_start"),
    version: int("version").notNull().default(0),
    created_at_ms: int("created_at_ms").notNull(),
    updated_at_ms: int("updated_at_ms").notNull(),
  },
  (table) => ({
    reportedAtIdx: index("agent_current_metrics_reported_at_idx").on(
      table.reported_at_ms
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

// 客户端历史指标表（整型分区主键：partitionId * 10^13 + YYMMDDHHmmss）
// 兼容旧历史的只读表；每周轮换出的 agent_metrics_history_old 由运行时裸 SQL管理。
// 新 v4 样本事实源是 agent_report_samples，本表仅用于升级窗口内的旧数据查询。
export const agentMetricsHistory = sqliteTable("agent_metrics_history", {
  id: int("id").primaryKey(),
  agent_id: int("agent_id").notNull(),
  timestamp: text("timestamp"),
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
  swap_total: int("swap_total"),
  swap_used: int("swap_used"),
  process_count: int("process_count"),
  tcp_connections: int("tcp_connections"),
  udp_connections: int("udp_connections"),
  ping_json: text("ping_json"),
  ipv4_reachable: int("ipv4_reachable"),
  ipv6_reachable: int("ipv6_reachable"),
  // 服务端计算的实时网速（bytes/s，无法计算时为空）
  network_rx_speed: real("network_rx_speed"),
  network_tx_speed: real("network_tx_speed"),
});

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

// Agent v4 上报幂等账本。HTTP 入口直接完成轻量化 D1 批量写入，
// payload_json 处理完成后立即清空，report_id + digest 用于识别安全重投。
export const agentReports = sqliteTable(
  "agent_reports",
  {
    report_id: text("report_id").primaryKey(),
    agent_id: int("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    payload_digest: text("payload_digest").notNull(),
    payload_json: text("payload_json").notNull(),
    sample_count: int("sample_count").notNull(),
    status: text("status").notNull().default("pending"),
    received_at: text("received_at").notNull(),
    processed_at: text("processed_at"),
    last_error: text("last_error"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    agentReceivedIdx: index("agent_reports_agent_received_at_idx").on(
      table.agent_id,
      table.received_at
    ),
    statusUpdatedIdx: index("agent_reports_status_updated_at_idx").on(
      table.status,
      table.updated_at
    ),
  })
);

// v4 原始样本按 report_id + sample_index 不可变落库；重投同一 Report 不重复写行。
export const agentReportSamples = sqliteTable(
  "agent_report_samples",
  {
    report_id: text("report_id")
      .notNull()
      .references(() => agentReports.report_id, { onDelete: "cascade" }),
    sample_index: int("sample_index").notNull(),
    agent_id: int("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    collected_at: text("collected_at").notNull(),
    metrics_json: text("metrics_json").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.report_id, table.sample_index] }),
    agentCollectedIdx: index(
      "agent_report_samples_agent_collected_at_idx"
    ).on(table.agent_id, table.collected_at),
  })
);

// 仅状态变化、告警和状态页合并重建等低频副作用写入 Outbox。
export const domainOutbox = sqliteTable(
  "domain_outbox",
  {
    event_id: text("event_id").primaryKey(),
    event_type: text("event_type").notNull(),
    aggregate_type: text("aggregate_type").notNull(),
    aggregate_id: text("aggregate_id").notNull(),
    payload_json: text("payload_json").notNull().default("{}"),
    status: text("status").notNull().default("pending"),
    attempts: int("attempts").notNull().default(0),
    available_at: text("available_at").notNull(),
    published_at: text("published_at"),
    processed_at: text("processed_at"),
    last_error: text("last_error"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    dueIdx: index("domain_outbox_status_available_at_idx").on(
      table.status,
      table.available_at
    ),
    aggregateIdx: index("domain_outbox_aggregate_idx").on(
      table.aggregate_type,
      table.aggregate_id
    ),
  })
);

// 每个消费者维护独立幂等收件箱，保证领域事件至少一次投递时副作用只提交一次。
export const processedEvents = sqliteTable(
  "processed_events",
  {
    consumer: text("consumer").notNull(),
    event_id: text("event_id").notNull(),
    processed_at: text("processed_at").notNull(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.consumer, table.event_id] }),
    processedAtIdx: index("processed_events_processed_at_idx").on(
      table.processed_at
    ),
  })
);

// 状态页配置表
export const statusPageConfig = sqliteTable(
  "status_page_config",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    singleton_key: int("singleton_key").notNull().default(1),
    title: text("title").notNull().default("系统状态"),
    description: text("description").default("系统当前运行状态"),
    logo_url: text("logo_url").default(""),
    custom_css: text("custom_css").default(""),
    // 状态页主题 id（对应前端 frontend/src/themes/<id>/，未知 id 前端回退默认主题）
    theme: text("theme").default("mono"),
    created_at: text("created_at").default("CURRENT_TIMESTAMP"),
    updated_at: text("updated_at").default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    singletonIdx: uniqueIndex("status_page_config_singleton_idx").on(
      table.singleton_key
    ),
  })
);

// v2 单例状态页配置；兼容期与 status_page_config 双写。
export const statusPages = sqliteTable(
  "status_pages",
  {
    id: int("id").primaryKey(),
    singleton_key: int("singleton_key").notNull().default(1),
    title: text("title").notNull(),
    description: text("description"),
    logo_url: text("logo_url"),
    custom_css: text("custom_css"),
    theme: text("theme").notNull().default("mono"),
    created_at_ms: int("created_at_ms").notNull(),
    updated_at_ms: int("updated_at_ms").notNull(),
  },
  (table) => ({
    singletonUniqueIdx: uniqueIndex("status_pages_singleton_key_unique_idx").on(
      table.singleton_key
    ),
  })
);

// v2 状态页组件统一关联；component_type 明确区分 Monitor 与 Agent。
export const statusComponents = sqliteTable(
  "status_components",
  {
    page_id: int("page_id")
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    component_type: text("component_type").notNull(),
    component_id: int("component_id").notNull(),
    sort_order: int("sort_order").notNull().default(0),
    created_at_ms: int("created_at_ms").notNull(),
    updated_at_ms: int("updated_at_ms").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.page_id, table.component_type, table.component_id],
    }),
    typeOrderIdx: index("status_components_page_type_order_idx").on(
      table.page_id,
      table.component_type,
      table.sort_order,
      table.component_id
    ),
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
    response_time_min: int("response_time_min").notNull().default(0),
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
  id: int("id").primaryKey().default(1),
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
    deleted_at: text("deleted_at"),
    created_at: text("created_at").default("CURRENT_TIMESTAMP"),
    updated_at: text("updated_at").default("CURRENT_TIMESTAMP"),
  },
  (table) => ({
    idIdx: index("notification_channels_id_idx").on(table.id),
  })
);

// 通知渠道非敏感 Endpoint 配置，与加密 Secret 分离。
export const notificationEndpoints = sqliteTable("notification_endpoints", {
  channel_id: int("channel_id")
    .primaryKey()
    .references(() => notificationChannels.id, { onDelete: "cascade" }),
  public_config_json: text("public_config_json").notNull(),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

// 每个渠道独立 DEK；DEK 由 Worker Secret 中的 KEK 包装。
export const notificationSecrets = sqliteTable("notification_secrets", {
  channel_id: int("channel_id")
    .primaryKey()
    .references(() => notificationChannels.id, { onDelete: "cascade" }),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  wrapped_dek: text("wrapped_dek").notNull(),
  wrap_iv: text("wrap_iv").notNull(),
  key_version: int("key_version").notNull().default(1),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

// 通知模板表
export const notificationTemplates = sqliteTable("notification_templates", {
  id: int("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  subject: text("subject").notNull(),
    content: text("content").notNull(),
    is_default: int("is_default").notNull().default(0),
    deleted_at: text("deleted_at"),
    created_at: text("created_at").default("CURRENT_TIMESTAMP"),
  updated_at: text("updated_at").default("CURRENT_TIMESTAMP"),
});

// 通知模板当前定义；旧模板 ID 保持稳定，内容由不可变版本表承载。
export const notificationTemplateDefinitions = sqliteTable(
  "notification_template_definitions",
  {
    id: int("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    current_version: int("current_version").notNull().default(1),
    is_default: int("is_default").notNull().default(0),
    deleted_at_ms: int("deleted_at_ms"),
    created_at_ms: int("created_at_ms").notNull(),
    updated_at_ms: int("updated_at_ms").notNull(),
  },
  (table) => ({
    typeDefaultIdx: index("notification_template_definitions_type_default_idx").on(
      table.type,
      table.deleted_at_ms,
      table.is_default,
      table.id
    ),
  })
);

export const notificationTemplateVersions = sqliteTable(
  "notification_template_versions",
  {
    template_id: int("template_id")
      .notNull()
      .references(() => notificationTemplateDefinitions.id, {
        onDelete: "cascade",
      }),
    version: int("version").notNull(),
    subject: text("subject").notNull(),
    content: text("content").notNull(),
    created_at_ms: int("created_at_ms").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.template_id, table.version] }),
  })
);

// 通知设置表
export const notificationSettings = sqliteTable(
  "notification_settings",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
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
      table.target_type,
      table.target_id,
      table.enabled
    ),
  })
);

// 规范化通知规则。迁移期与 notification_settings 双写，ID 保持一致以兼容旧数据。
export const notificationRules = sqliteTable(
  "notification_rules",
  {
    id: int("id").primaryKey(),
    target_type: text("target_type").notNull(),
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
    created_at_ms: int("created_at_ms").notNull(),
    updated_at_ms: int("updated_at_ms").notNull(),
  },
  (table) => ({
    lookupIdx: index("notification_rules_lookup_idx").on(
      table.target_type,
      table.target_id,
      table.enabled,
      table.id
    ),
  })
);

// 规则与投递端点的有序关联，替代 notification_settings.channels JSON 数组。
export const notificationRuleEndpoints = sqliteTable(
  "notification_rule_endpoints",
  {
    rule_id: int("rule_id")
      .notNull()
      .references(() => notificationRules.id, { onDelete: "cascade" }),
    channel_id: int("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    sort_order: int("sort_order").notNull().default(0),
    created_at_ms: int("created_at_ms").notNull(),
    updated_at_ms: int("updated_at_ms").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.rule_id, table.channel_id] }),
    channelIdx: index("notification_rule_endpoints_channel_idx").on(
      table.channel_id,
      table.rule_id
    ),
  })
);

// 通知设置批量命令账本：请求键与请求摘要绑定，完成响应可安全重放。
export const notificationSettingCommands = sqliteTable(
  "notification_setting_commands",
  {
    idempotency_key: text("idempotency_key").primaryKey(),
    request_hash: text("request_hash").notNull(),
    status: text("status").notNull(),
    response_json: text("response_json"),
    last_error: text("last_error"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    statusUpdatedIdx: index("notification_setting_commands_status_updated_idx").on(
      table.status,
      table.updated_at
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

// 由领域 Outbox 投影出的通知事件；source_event_id 保证重复消费只生成一组消息。
export const notificationEvents = sqliteTable(
  "notification_events",
  {
    event_id: text("event_id").primaryKey(),
    source_event_id: text("source_event_id").notNull(),
    type: text("type").notNull(),
    target_id: int("target_id"),
    event_key: text("event_key").notNull(),
    variables_json: text("variables_json").notNull(),
    status: text("status").notNull().default("pending"),
    completed_at: text("completed_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    sourceUniqueIdx: uniqueIndex("notification_events_source_event_id_unique_idx").on(
      table.source_event_id
    ),
    statusUpdatedIdx: index("notification_events_status_updated_at_idx").on(
      table.status,
      table.updated_at
    ),
  })
);

// 每个事件、每个渠道一条持久化投递消息；供应商调用由租约保护。
export const notificationMessages = sqliteTable(
  "notification_messages",
  {
    message_id: text("message_id").primaryKey(),
    event_id: text("event_id")
      .notNull()
      .references(() => notificationEvents.event_id, { onDelete: "cascade" }),
    channel_id: int("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    template_id: int("template_id")
      .notNull()
      .references(() => notificationTemplates.id),
    subject: text("subject").notNull(),
    content: text("content").notNull(),
    cooldown_minutes: int("cooldown_minutes").notNull().default(30),
    status: text("status").notNull().default("pending"),
    attempts: int("attempts").notNull().default(0),
    max_attempts: int("max_attempts").notNull().default(5),
    available_at: text("available_at").notNull(),
    lease_token: text("lease_token"),
    lease_expires_at: text("lease_expires_at"),
    provider_status_code: int("provider_status_code"),
    last_error: text("last_error"),
    sent_at: text("sent_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    eventChannelUniqueIdx: uniqueIndex(
      "notification_messages_event_channel_unique_idx"
    ).on(table.event_id, table.channel_id),
    dueIdx: index("notification_messages_status_available_at_idx").on(
      table.status,
      table.available_at
    ),
  })
);

export const notificationAttempts = sqliteTable(
  "notification_attempts",
  {
    attempt_id: text("attempt_id").primaryKey(),
    message_id: text("message_id")
      .notNull()
      .references(() => notificationMessages.message_id, { onDelete: "cascade" }),
    attempt_number: int("attempt_number").notNull(),
    started_at: text("started_at").notNull(),
    completed_at: text("completed_at").notNull(),
    duration_ms: int("duration_ms").notNull(),
    success: int("success").notNull(),
    provider_status_code: int("provider_status_code"),
    error_category: text("error_category"),
    error: text("error"),
    retryable: int("retryable").notNull().default(0),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    messageAttemptUniqueIdx: uniqueIndex(
      "notification_attempts_message_attempt_unique_idx"
    ).on(table.message_id, table.attempt_number),
  })
);

export const notificationCooldowns = sqliteTable(
  "notification_cooldowns",
  {
    cooldown_key: text("cooldown_key").primaryKey(),
    type: text("type").notNull(),
    target_id: int("target_id"),
    channel_id: int("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    event_key: text("event_key").notNull(),
    last_sent_at: text("last_sent_at").notNull(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    lookupIdx: index("notification_cooldowns_lookup_idx").on(
      table.type,
      table.target_id,
      table.channel_id,
      table.event_key
    ),
  })
);

// 不可变公共发布物及其单例活动指针。
export const statusPublications = sqliteTable(
  "status_publications",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    source_event_id: text("source_event_id").notNull(),
    payload_json: text("payload_json").notNull(),
    etag: text("etag").notNull(),
    generated_at: text("generated_at").notNull(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    sourceUniqueIdx: uniqueIndex("status_publications_source_event_id_unique_idx").on(
      table.source_event_id
    ),
    generatedIdx: index("status_publications_generated_at_idx").on(
      table.generated_at
    ),
  })
);

export const statusPublicationState = sqliteTable("status_publication_state", {
  singleton_key: int("singleton_key").primaryKey().default(1),
  active_publication_id: int("active_publication_id").references(
    () => statusPublications.id,
    { onDelete: "set null" }
  ),
  updated_at: text("updated_at").notNull(),
});

// Agent 历史指标与主状态发布物绑定；活动指针切换时两类匿名数据同步生效。
export const statusMetricPublications = sqliteTable(
  "status_metric_publications",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    status_publication_id: int("status_publication_id")
      .notNull()
      .references(() => statusPublications.id, { onDelete: "cascade" }),
    agent_id: int("agent_id").notNull(),
    payload_json: text("payload_json").notNull(),
    etag: text("etag").notNull(),
    generated_at: text("generated_at").notNull(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    publicationAgentUniqueIdx: uniqueIndex(
      "status_metric_publications_publication_agent_unique_idx"
    ).on(table.status_publication_id, table.agent_id),
    agentGeneratedIdx: index(
      "status_metric_publications_agent_generated_at_idx"
    ).on(table.agent_id, table.generated_at),
  })
);


// 仅用于数据库迁移版本等实例级元数据。
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});
