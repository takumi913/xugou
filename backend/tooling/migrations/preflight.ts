import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface MigrationPreflightReport {
  generatedAt: string;
  database: string;
  emptyDatabase: boolean;
  readyForExpand: boolean;
  readyForCredentialContract: boolean;
  blockers: string[];
  warnings: string[];
  counts: Record<string, number>;
  conservation: DataConservationCheck[];
  schema: {
    tables: string[];
    legacyHistoryTables: string[];
    latestEmbeddedMigration: string | null;
    quickCheck: string;
    integrityCheck: string;
  };
}

export interface DataConservationCheck {
  key: string;
  sourceRows: number;
  migratedRows: number;
  deduplicatedRows: number;
  archivedRows: number;
  anomalyRows: number;
  difference: number | null;
  conserved: boolean;
}

function conservationCheck(
  key: string,
  sourceRows: number,
  migratedRows: number,
  anomalyRows: number
): DataConservationCheck {
  const values = [sourceRows, migratedRows, anomalyRows];
  const known = values.every((value) => Number.isSafeInteger(value) && value >= 0);
  const difference = known ? sourceRows - migratedRows - anomalyRows : null;
  return {
    key,
    sourceRows,
    migratedRows,
    deduplicatedRows: 0,
    archivedRows: 0,
    anomalyRows,
    difference,
    conserved: difference === 0,
  };
}

function runSql(databasePath: string, sql: string) {
  return execFileSync("sqlite3", [databasePath], {
    encoding: "utf8",
    input: sql,
  }).trim();
}

function scalar(databasePath: string, sql: string) {
  const value = Number(runSql(databasePath, sql));
  return Number.isFinite(value) ? value : 0;
}

export function runMigrationPreflight(
  databasePath: string,
  options: { allowEmpty?: boolean; notificationKekVersion?: number } = {}
): MigrationPreflightReport {
  const resolvedDatabase = resolve(databasePath);
  const tableNames = runSql(
    resolvedDatabase,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
  )
    .split("\n")
    .filter(Boolean);
  const tables = new Set(tableNames);
  const notificationChannelsHaveDeletedAt =
    tables.has("notification_channels") &&
    scalar(
      resolvedDatabase,
      "SELECT count(*) FROM pragma_table_info('notification_channels') WHERE name = 'deleted_at';"
    ) === 1;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const requiredTables = ["users", "agents", "notification_channels"];
  const emptyDatabase = requiredTables.every((table) => !tables.has(table));

  const quickCheck = runSql(resolvedDatabase, "PRAGMA quick_check;");
  if (quickCheck !== "ok") blockers.push(`PRAGMA quick_check: ${quickCheck}`);
  const integrityCheck = runSql(resolvedDatabase, "PRAGMA integrity_check;");
  if (integrityCheck !== "ok") {
    blockers.push(`PRAGMA integrity_check: ${integrityCheck}`);
  }

  counts.foreignKeyViolations = scalar(
    resolvedDatabase,
    "SELECT count(*) FROM pragma_foreign_key_check;"
  );
  if (counts.foreignKeyViolations > 0) {
    blockers.push(`存在 ${counts.foreignKeyViolations} 条外键异常`);
  }

  if (!(emptyDatabase && options.allowEmpty)) {
    for (const table of requiredTables) {
      if (!tables.has(table)) blockers.push(`缺少基础表 ${table}`);
    }
  }

  if (tables.has("users")) {
    counts.adminUsers = scalar(resolvedDatabase, "SELECT count(*) FROM users;");
    const legacyRoleColumn =
      scalar(
        resolvedDatabase,
        "SELECT count(*) FROM pragma_table_info('users') WHERE name = 'role';"
      ) === 1;
    if (counts.adminUsers === 0) {
      warnings.push("管理员尚未初始化，首次登录将使用 ADMIN_INITIAL_PASSWORD 创建");
    } else if (counts.adminUsers > 1 && legacyRoleColumn) {
      warnings.push(
        `${counts.adminUsers - 1} 个旧用户将在单实例数据迁移中移除，业务资源保持实例级数据`
      );
    } else if (counts.adminUsers !== 1) {
      blockers.push(`管理员记录数为 ${counts.adminUsers}，目标值为 1`);
    }
  }

  if (tables.has("notification_channels")) {
    counts.notificationChannels = scalar(
      resolvedDatabase,
      "SELECT count(*) FROM notification_channels;"
    );
    counts.invalidNotificationConfigJson = scalar(
      resolvedDatabase,
      "SELECT count(*) FROM notification_channels WHERE json_valid(config) = 0;"
    );
    if (counts.invalidNotificationConfigJson > 0) {
      blockers.push(
        `存在 ${counts.invalidNotificationConfigJson} 条非法通知配置 JSON`
      );
    }
  }

  if (tables.has("status_page_monitors") && tables.has("monitors")) {
    counts.orphanStatusMonitors = scalar(
      resolvedDatabase,
      "SELECT count(*) FROM status_page_monitors s LEFT JOIN monitors m ON m.id=s.monitor_id WHERE m.id IS NULL;"
    );
    if (counts.orphanStatusMonitors > 0) {
      blockers.push(
        `存在 ${counts.orphanStatusMonitors} 条孤立状态页 Monitor 关系`
      );
    }
  }

  if (tables.has("status_page_agents") && tables.has("agents")) {
    counts.orphanStatusAgents = scalar(
      resolvedDatabase,
      "SELECT count(*) FROM status_page_agents s LEFT JOIN agents a ON a.id=s.agent_id WHERE a.id IS NULL;"
    );
    if (counts.orphanStatusAgents > 0) {
      blockers.push(
        `存在 ${counts.orphanStatusAgents} 条孤立状态页 Agent 关系`
      );
    }
  }

  counts.unmigratedAgentCredentials =
    tables.has("agent_credentials") && tables.has("agents")
      ? scalar(
          resolvedDatabase,
          "SELECT count(*) FROM agents a WHERE a.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM agent_credentials c WHERE c.agent_id=a.id AND c.revoked_at IS NULL);"
        )
      : -1;
  if (counts.unmigratedAgentCredentials > 0) {
    warnings.push(
      `${counts.unmigratedAgentCredentials} 个有效 Agent 等待 Credential 摘要回填`
    );
  }

  counts.unmigratedNotificationEndpoints =
    tables.has("notification_endpoints") && tables.has("notification_channels")
      ? scalar(
          resolvedDatabase,
          `SELECT count(*) FROM notification_channels c
           WHERE ${notificationChannelsHaveDeletedAt ? "c.deleted_at IS NULL AND" : ""}
             NOT EXISTS (SELECT 1 FROM notification_endpoints e WHERE e.channel_id=c.id);`
        )
      : -1;
  if (counts.unmigratedNotificationEndpoints > 0) {
    warnings.push(
      `${counts.unmigratedNotificationEndpoints} 个通知渠道等待 Endpoint/Secret 回填`
    );
  }

  const targetKekVersion = Math.max(
    1,
    Math.trunc(options.notificationKekVersion ?? 1)
  );
  counts.notificationSecretRows = tables.has("notification_secrets")
    ? scalar(resolvedDatabase, "SELECT count(*) FROM notification_secrets;")
    : -1;
  counts.notificationSecretsOutsideTargetKek = tables.has("notification_secrets")
    ? scalar(
        resolvedDatabase,
        `SELECT count(*) FROM notification_secrets WHERE key_version <> ${targetKekVersion};`
      )
    : -1;
  if (counts.notificationSecretsOutsideTargetKek > 0) {
    warnings.push(
      `${counts.notificationSecretsOutsideTargetKek} 个通知 Secret 等待 KEK v${targetKekVersion} 重包装`
    );
  }

  counts.openMigrationAnomalies = tables.has("migration_anomalies")
    ? scalar(
        resolvedDatabase,
        "SELECT count(*) FROM migration_anomalies WHERE status IN ('open', 'retry_requested');"
      )
    : -1;
  if (counts.openMigrationAnomalies > 0) {
    warnings.push(
      `${counts.openMigrationAnomalies} 条迁移异常等待重试或人工确认`
    );
  }

  counts.incompleteMigrationCheckpoints = tables.has("migration_checkpoints")
    ? scalar(
        resolvedDatabase,
        "SELECT count(*) FROM migration_checkpoints WHERE status IN ('running', 'failed');"
      )
    : -1;
  if (counts.incompleteMigrationCheckpoints > 0) {
    warnings.push(
      `${counts.incompleteMigrationCheckpoints} 个迁移 Checkpoint 尚未完成`
    );
  }

  counts.completedMigrationCheckpointsWithAnomalies = tables.has(
    "migration_checkpoints"
  )
    ? scalar(
        resolvedDatabase,
        "SELECT count(*) FROM migration_checkpoints WHERE status = 'completed_with_anomalies';"
      )
    : -1;

  const legacyHistoryTables = tableNames.filter(
    (name) =>
      name === "agent_metrics_history_old" ||
      /^agent_metrics_history_\d+$/.test(name)
  );
  if (legacyHistoryTables.length > 0) {
    warnings.push(`发现 ${legacyHistoryTables.length} 张旧 Agent 历史表`);
  }

  counts.monitors = tables.has("monitors")
    ? scalar(resolvedDatabase, "SELECT count(*) FROM monitors;")
    : 0;
  counts.agents = tables.has("agents")
    ? scalar(resolvedDatabase, "SELECT count(*) FROM agents;")
    : 0;
  counts.agentMetricsHistoryRows = tables.has("agent_metrics_history")
    ? scalar(resolvedDatabase, "SELECT count(*) FROM agent_metrics_history;")
    : 0;
  counts.legacyAgentMetricsHistoryRows = legacyHistoryTables.reduce(
    (total, table) =>
      total + scalar(resolvedDatabase, `SELECT count(*) FROM "${table}";`),
    0
  );
  counts.agentHistoricalRowsTotal =
    counts.agentMetricsHistoryRows + counts.legacyAgentMetricsHistoryRows;
  counts.agentMetrics24hRows = tables.has("agent_metrics_24h")
    ? scalar(resolvedDatabase, "SELECT count(*) FROM agent_metrics_24h;")
    : 0;
  counts.legacyAgentHistorySourceRows =
    counts.agentHistoricalRowsTotal + counts.agentMetrics24hRows;
  counts.mappedLegacyAgentHistoryRows = tables.has("legacy_id_map")
    ? scalar(
        resolvedDatabase,
        `SELECT count(*) FROM legacy_id_map
         WHERE target_table = 'agent_report_samples'
           AND (source_table = 'agent_metrics_24h'
             OR source_table = 'agent_metrics_history'
             OR source_table = 'agent_metrics_history_old'
             OR source_table GLOB 'agent_metrics_history_[0-9]*');`
      )
    : -1;
  counts.activeLegacyAgentHistoryAnomalies = tables.has("migration_anomalies")
    ? scalar(
        resolvedDatabase,
        `SELECT count(*) FROM migration_anomalies
         WHERE migration_key LIKE 'legacy-agent-history-v1:%'
           AND status IN ('open', 'retry_requested', 'ignored');`
      )
    : -1;
  counts.unconservedLegacyAgentHistoryRows =
    counts.mappedLegacyAgentHistoryRows < 0 ||
    counts.activeLegacyAgentHistoryAnomalies < 0
      ? -1
      : Math.max(
          0,
          counts.legacyAgentHistorySourceRows -
            counts.mappedLegacyAgentHistoryRows -
            counts.activeLegacyAgentHistoryAnomalies
        );
  if (counts.unconservedLegacyAgentHistoryRows > 0) {
    warnings.push(
      `${counts.unconservedLegacyAgentHistoryRows} 条旧 Agent 历史尚未映射或隔离`
    );
  }
  counts.agentModelSourceRows = tables.has("agents")
    ? scalar(resolvedDatabase, "SELECT count(*) FROM agents;")
    : 0;
  counts.mappedLegacyAgentModelRows =
    tables.has("legacy_id_map") &&
    tables.has("agent_nodes") &&
    tables.has("agent_runtime")
      ? scalar(
          resolvedDatabase,
          `SELECT count(*) FROM legacy_id_map map
           JOIN agent_nodes node ON node.id = CAST(map.target_id AS INTEGER)
           JOIN agent_runtime runtime ON runtime.agent_id = node.id
           WHERE map.source_table = 'agents'
             AND map.target_table = 'agent_nodes';`
        )
      : -1;
  counts.activeLegacyAgentModelAnomalies = tables.has("migration_anomalies")
    ? scalar(
        resolvedDatabase,
        `SELECT count(*) FROM migration_anomalies
         WHERE migration_key = 'legacy-agent-model-v2'
           AND status IN ('open', 'retry_requested', 'ignored');`
      )
    : -1;
  counts.unconservedLegacyAgentModelRows =
    counts.mappedLegacyAgentModelRows < 0 ||
    counts.activeLegacyAgentModelAnomalies < 0
      ? -1
      : Math.max(
          0,
          counts.agentModelSourceRows -
            counts.mappedLegacyAgentModelRows -
            counts.activeLegacyAgentModelAnomalies
        );
  if (counts.unconservedLegacyAgentModelRows > 0) {
    warnings.push(
      `${counts.unconservedLegacyAgentModelRows} 个旧 Agent 尚未拆分为 Node/Runtime`
    );
  }
  counts.agentLatestMetricsRows = tables.has("agent_latest_metrics")
    ? scalar(resolvedDatabase, "SELECT count(*) FROM agent_latest_metrics;")
    : 0;
  counts.mappedLegacyAgentCurrentMetricsRows =
    tables.has("legacy_id_map") && tables.has("agent_current_metrics")
      ? scalar(
          resolvedDatabase,
          `SELECT count(*) FROM legacy_id_map map
           JOIN agent_current_metrics target
             ON target.agent_id = CAST(map.target_id AS INTEGER)
           WHERE map.source_table = 'agent_latest_metrics'
             AND map.target_table = 'agent_current_metrics';`
        )
      : -1;
  counts.activeLegacyAgentCurrentMetricsAnomalies = tables.has(
    "migration_anomalies"
  )
    ? scalar(
        resolvedDatabase,
        `SELECT count(*) FROM migration_anomalies
         WHERE migration_key = 'legacy-agent-current-metrics-v1'
           AND status IN ('open', 'retry_requested', 'ignored');`
      )
    : -1;
  counts.unconservedLegacyAgentCurrentMetricsRows =
    counts.mappedLegacyAgentCurrentMetricsRows < 0 ||
    counts.activeLegacyAgentCurrentMetricsAnomalies < 0
      ? -1
      : Math.max(
          0,
          counts.agentLatestMetricsRows -
            counts.mappedLegacyAgentCurrentMetricsRows -
            counts.activeLegacyAgentCurrentMetricsAnomalies
        );
  if (counts.unconservedLegacyAgentCurrentMetricsRows > 0) {
    warnings.push(
      `${counts.unconservedLegacyAgentCurrentMetricsRows} 条旧 Agent 当前指标尚未映射或隔离`
    );
  }
  counts.monitorStatusHistoryRows = tables.has("monitor_status_history_24h")
    ? scalar(resolvedDatabase, "SELECT count(*) FROM monitor_status_history_24h;")
    : 0;
  counts.mappedLegacyMonitorHistoryRows = tables.has("legacy_id_map")
    ? scalar(
        resolvedDatabase,
        `SELECT count(*) FROM legacy_id_map
         WHERE source_table = 'monitor_status_history_24h'
           AND target_table = 'monitor_check_samples';`
      )
    : -1;
  counts.activeLegacyMonitorHistoryAnomalies = tables.has("migration_anomalies")
    ? scalar(
        resolvedDatabase,
        `SELECT count(*) FROM migration_anomalies
         WHERE migration_key = 'legacy-monitor-history-v1'
           AND status IN ('open', 'retry_requested', 'ignored');`
      )
    : -1;
  counts.unconservedLegacyMonitorHistoryRows =
    counts.mappedLegacyMonitorHistoryRows < 0 ||
    counts.activeLegacyMonitorHistoryAnomalies < 0
      ? -1
      : Math.max(
          0,
          counts.monitorStatusHistoryRows -
            counts.mappedLegacyMonitorHistoryRows -
            counts.activeLegacyMonitorHistoryAnomalies
        );
  if (counts.unconservedLegacyMonitorHistoryRows > 0) {
    warnings.push(
      `${counts.unconservedLegacyMonitorHistoryRows} 条旧 Monitor 历史尚未映射或隔离`
    );
  }
  counts.monitorModelSourceRows = tables.has("monitors")
    ? scalar(resolvedDatabase, "SELECT count(*) FROM monitors;")
    : 0;
  counts.mappedLegacyMonitorModelRows =
    tables.has("legacy_id_map") &&
    tables.has("monitor_definitions") &&
    tables.has("monitor_runtime")
      ? scalar(
          resolvedDatabase,
          `SELECT count(*) FROM legacy_id_map map
           JOIN monitor_definitions definition
             ON definition.id = CAST(map.target_id AS INTEGER)
           JOIN monitor_runtime runtime ON runtime.monitor_id = definition.id
           WHERE map.source_table = 'monitors'
             AND map.target_table = 'monitor_definitions';`
        )
      : -1;
  counts.activeLegacyMonitorModelAnomalies = tables.has("migration_anomalies")
    ? scalar(
        resolvedDatabase,
        `SELECT count(*) FROM migration_anomalies
         WHERE migration_key = 'legacy-monitor-model-v2'
           AND status IN ('open', 'retry_requested', 'ignored');`
      )
    : -1;
  counts.unconservedLegacyMonitorModelRows =
    counts.mappedLegacyMonitorModelRows < 0 ||
    counts.activeLegacyMonitorModelAnomalies < 0
      ? -1
      : Math.max(
          0,
          counts.monitorModelSourceRows -
            counts.mappedLegacyMonitorModelRows -
            counts.activeLegacyMonitorModelAnomalies
        );
  if (counts.unconservedLegacyMonitorModelRows > 0) {
    warnings.push(
      `${counts.unconservedLegacyMonitorModelRows} 个旧 Monitor 尚未拆分为 Definition/Runtime`
    );
  }
  counts.monitorDailyStatsRows = tables.has("monitor_daily_stats")
    ? scalar(resolvedDatabase, "SELECT count(*) FROM monitor_daily_stats;")
    : 0;
  counts.mappedLegacyMonitorDailyStatsRows = tables.has("legacy_id_map")
    ? scalar(
        resolvedDatabase,
        `SELECT count(*) FROM legacy_id_map map
         JOIN monitor_daily_stats source
           ON source.id = CAST(map.source_id AS INTEGER)
         JOIN monitor_check_rollups target
           ON target.monitor_id = source.monitor_id
          AND target.bucket_start = source.date || 'T00:00:00.000Z'
          AND target.bucket_size_seconds = 86400
         WHERE map.source_table = 'monitor_daily_stats'
           AND map.target_table = 'monitor_check_rollups';`
      )
    : -1;
  counts.activeLegacyMonitorDailyStatsAnomalies = tables.has(
    "migration_anomalies"
  )
    ? scalar(
        resolvedDatabase,
        `SELECT count(*) FROM migration_anomalies
         WHERE migration_key = 'legacy-monitor-daily-stats-v1'
           AND status IN ('open', 'retry_requested', 'ignored');`
      )
    : -1;
  counts.unconservedLegacyMonitorDailyStatsRows =
    counts.mappedLegacyMonitorDailyStatsRows < 0 ||
    counts.activeLegacyMonitorDailyStatsAnomalies < 0
      ? -1
      : Math.max(
          0,
          counts.monitorDailyStatsRows -
            counts.mappedLegacyMonitorDailyStatsRows -
            counts.activeLegacyMonitorDailyStatsAnomalies
        );
  if (counts.unconservedLegacyMonitorDailyStatsRows > 0) {
    warnings.push(
      `${counts.unconservedLegacyMonitorDailyStatsRows} 条旧 Monitor 日统计尚未映射或隔离`
    );
  }
  counts.notificationHistoryRows = tables.has("notification_history")
    ? scalar(resolvedDatabase, "SELECT count(*) FROM notification_history;")
    : 0;
  counts.mappedLegacyNotificationHistoryRows = tables.has("legacy_id_map")
    ? scalar(
        resolvedDatabase,
        `SELECT count(*) FROM legacy_id_map
         WHERE source_table = 'notification_history'
           AND target_table = 'notification_messages';`
      )
    : -1;
  counts.activeLegacyNotificationHistoryAnomalies = tables.has(
    "migration_anomalies"
  )
    ? scalar(
        resolvedDatabase,
        `SELECT count(*) FROM migration_anomalies
         WHERE migration_key = 'legacy-notification-history-v1'
           AND status IN ('open', 'retry_requested', 'ignored');`
      )
    : -1;
  counts.unconservedLegacyNotificationHistoryRows =
    counts.mappedLegacyNotificationHistoryRows < 0 ||
    counts.activeLegacyNotificationHistoryAnomalies < 0
      ? -1
      : Math.max(
          0,
          counts.notificationHistoryRows -
            counts.mappedLegacyNotificationHistoryRows -
            counts.activeLegacyNotificationHistoryAnomalies
        );
  if (counts.unconservedLegacyNotificationHistoryRows > 0) {
    warnings.push(
      `${counts.unconservedLegacyNotificationHistoryRows} 条旧 Notification History 尚未映射或隔离`
    );
  }
  counts.legacyStatusPageRows =
    (tables.has("status_page_config")
      ? scalar(resolvedDatabase, "SELECT count(*) FROM status_page_config;")
      : 0) +
    (tables.has("status_page_monitors")
      ? scalar(resolvedDatabase, "SELECT count(*) FROM status_page_monitors;")
      : 0) +
    (tables.has("status_page_agents")
      ? scalar(resolvedDatabase, "SELECT count(*) FROM status_page_agents;")
      : 0);
  counts.mappedLegacyStatusPageRows =
    tables.has("legacy_id_map") &&
    tables.has("status_pages") &&
    tables.has("status_components")
      ? scalar(
          resolvedDatabase,
          `SELECT
             (SELECT COUNT(*) FROM legacy_id_map map
              JOIN status_page_config source
                ON map.source_id = CAST(source.id AS TEXT)
              JOIN status_pages target ON target.id = source.id
              WHERE map.source_table = 'status_page_config'
                AND map.target_table = 'status_pages') +
             (SELECT COUNT(*) FROM legacy_id_map map
              JOIN status_page_monitors source
                ON map.source_id = CAST(source.config_id AS TEXT) || ':' ||
                                   CAST(source.monitor_id AS TEXT)
              JOIN status_components target
                ON target.page_id = source.config_id
               AND target.component_type = 'monitor'
               AND target.component_id = source.monitor_id
              WHERE map.source_table = 'status_page_monitors'
                AND map.target_table = 'status_components') +
             (SELECT COUNT(*) FROM legacy_id_map map
              JOIN status_page_agents source
                ON map.source_id = CAST(source.config_id AS TEXT) || ':' ||
                                   CAST(source.agent_id AS TEXT)
              JOIN status_components target
                ON target.page_id = source.config_id
               AND target.component_type = 'agent'
               AND target.component_id = source.agent_id
              WHERE map.source_table = 'status_page_agents'
                AND map.target_table = 'status_components');`
        )
      : -1;
  counts.statusPageTargetRows =
    tables.has("status_pages") && tables.has("status_components")
      ? scalar(
          resolvedDatabase,
          `SELECT (SELECT count(*) FROM status_pages) +
                  (SELECT count(*) FROM status_components);`
        )
      : -1;
  counts.activeLegacyStatusPageAnomalies = tables.has("migration_anomalies")
    ? scalar(
        resolvedDatabase,
        `SELECT count(*) FROM migration_anomalies
         WHERE migration_key = 'legacy-status-page-v1'
           AND status IN ('open', 'retry_requested', 'ignored');`
      )
    : -1;
  counts.unconservedLegacyStatusPageRows =
    counts.mappedLegacyStatusPageRows < 0 ||
    counts.statusPageTargetRows < 0 ||
    counts.activeLegacyStatusPageAnomalies < 0
      ? -1
      : counts.statusPageTargetRows !== counts.mappedLegacyStatusPageRows
        ? Math.max(1, Math.abs(
            counts.statusPageTargetRows - counts.mappedLegacyStatusPageRows
          ))
        : Math.max(
            0,
            counts.legacyStatusPageRows -
              counts.mappedLegacyStatusPageRows -
              counts.activeLegacyStatusPageAnomalies
          );
  if (counts.unconservedLegacyStatusPageRows > 0) {
    warnings.push(
      `${counts.unconservedLegacyStatusPageRows} 条状态页配置/组件尚未映射、隔离或清理陈旧目标`
    );
  }

  counts.legacyNotificationRuleSourceRows = tables.has("notification_settings")
    ? scalar(
        resolvedDatabase,
        `SELECT COUNT(*) + COALESCE(SUM(
           CASE WHEN json_valid(COALESCE(channels, '[]')) = 1
                THEN CASE
                  WHEN json_type(COALESCE(channels, '[]')) = 'array'
                  THEN json_array_length(channels) ELSE 0 END
                ELSE 0 END
         ), 0) FROM notification_settings;`
      )
    : 0;
  counts.mappedLegacyNotificationRuleRows =
    tables.has("legacy_id_map") &&
    tables.has("notification_rules") &&
    tables.has("notification_rule_endpoints")
      ? scalar(
          resolvedDatabase,
          `SELECT
             (SELECT COUNT(*) FROM legacy_id_map map
              JOIN notification_settings source
                ON map.source_id = CAST(source.id AS TEXT)
              JOIN notification_rules target ON target.id = source.id
              WHERE map.source_table = 'notification_settings'
                AND map.target_table = 'notification_rules') +
             (SELECT COUNT(*)
              FROM notification_settings source
              JOIN json_each(
                CASE WHEN json_valid(COALESCE(source.channels, '[]')) = 1
                     THEN CASE
                       WHEN json_type(COALESCE(source.channels, '[]')) = 'array'
                       THEN source.channels ELSE '[]' END
                     ELSE '[]' END
              ) channel
              JOIN legacy_id_map map
                ON map.source_table = 'notification_settings_channels'
               AND map.source_id = CAST(source.id AS TEXT) || ':' ||
                                   CAST(channel.key AS TEXT)
              JOIN notification_rule_endpoints target
                ON target.rule_id = source.id
               AND target.channel_id = CAST(channel.value AS INTEGER)
              WHERE map.target_table = 'notification_rule_endpoints');`
        )
      : -1;
  counts.notificationRuleTargetRows =
    tables.has("notification_rules") &&
    tables.has("notification_rule_endpoints")
      ? scalar(
          resolvedDatabase,
          `SELECT (SELECT COUNT(*) FROM notification_rules) +
                  (SELECT COUNT(*) FROM notification_rule_endpoints);`
        )
      : -1;
  counts.activeLegacyNotificationRuleAnomalies = tables.has(
    "migration_anomalies"
  )
    ? scalar(
        resolvedDatabase,
        `SELECT COUNT(*) FROM migration_anomalies
         WHERE migration_key = 'legacy-notification-rules-v1'
           AND status IN ('open', 'retry_requested', 'ignored');`
      )
    : -1;
  counts.unconservedLegacyNotificationRuleRows =
    counts.mappedLegacyNotificationRuleRows < 0 ||
    counts.notificationRuleTargetRows < 0 ||
    counts.activeLegacyNotificationRuleAnomalies < 0
      ? -1
      : counts.notificationRuleTargetRows !==
          counts.mappedLegacyNotificationRuleRows
        ? Math.max(
            1,
            Math.abs(
              counts.notificationRuleTargetRows -
                counts.mappedLegacyNotificationRuleRows
            )
          )
        : Math.max(
            0,
            counts.legacyNotificationRuleSourceRows -
              counts.mappedLegacyNotificationRuleRows -
              counts.activeLegacyNotificationRuleAnomalies
          );
  if (counts.unconservedLegacyNotificationRuleRows > 0) {
    warnings.push(
      `${counts.unconservedLegacyNotificationRuleRows} 条通知规则/端点关系尚未映射、隔离或清理陈旧目标`
    );
  }

  counts.legacyNotificationTemplateRows = tables.has("notification_templates")
    ? scalar(resolvedDatabase, "SELECT COUNT(*) FROM notification_templates;")
    : 0;
  counts.mappedLegacyNotificationTemplateRows =
    tables.has("legacy_id_map") &&
    tables.has("notification_template_definitions") &&
    tables.has("notification_template_versions")
      ? scalar(
          resolvedDatabase,
          `SELECT COUNT(*)
           FROM notification_templates source
           JOIN legacy_id_map map
             ON map.source_table = 'notification_templates'
            AND map.source_id = CAST(source.id AS TEXT)
            AND map.target_table = 'notification_template_definitions'
           JOIN notification_template_definitions definition
             ON definition.id = source.id
           JOIN notification_template_versions version
             ON version.template_id = definition.id
            AND version.version = definition.current_version
           WHERE version.subject = source.subject
             AND version.content = source.content;`
        )
      : -1;
  counts.notificationTemplateTargetRows = tables.has(
    "notification_template_definitions"
  )
    ? scalar(
        resolvedDatabase,
        "SELECT COUNT(*) FROM notification_template_definitions;"
      )
    : -1;
  counts.activeLegacyNotificationTemplateAnomalies = tables.has(
    "migration_anomalies"
  )
    ? scalar(
        resolvedDatabase,
        `SELECT COUNT(*) FROM migration_anomalies
         WHERE migration_key = 'legacy-notification-templates-v1'
           AND status IN ('open', 'retry_requested', 'ignored');`
      )
    : -1;
  counts.unconservedLegacyNotificationTemplateRows =
    counts.mappedLegacyNotificationTemplateRows < 0 ||
    counts.notificationTemplateTargetRows < 0 ||
    counts.activeLegacyNotificationTemplateAnomalies < 0
      ? -1
      : counts.notificationTemplateTargetRows !==
          counts.mappedLegacyNotificationTemplateRows
        ? Math.max(
            1,
            Math.abs(
              counts.notificationTemplateTargetRows -
                counts.mappedLegacyNotificationTemplateRows
            )
          )
        : Math.max(
            0,
            counts.legacyNotificationTemplateRows -
              counts.mappedLegacyNotificationTemplateRows -
              counts.activeLegacyNotificationTemplateAnomalies
          );
  if (counts.unconservedLegacyNotificationTemplateRows > 0) {
    warnings.push(
      `${counts.unconservedLegacyNotificationTemplateRows} 个通知模板尚未映射、隔离或同步当前版本`
    );
  }

  const latestEmbeddedMigration = tables.has("migrations")
    ? runSql(
        resolvedDatabase,
        "SELECT name FROM migrations ORDER BY id DESC LIMIT 1;"
      ) || null
    : null;

  const conservation = [
    conservationCheck(
      "agent-history",
      counts.legacyAgentHistorySourceRows,
      counts.mappedLegacyAgentHistoryRows,
      counts.activeLegacyAgentHistoryAnomalies
    ),
    conservationCheck(
      "agent-model",
      counts.agentModelSourceRows,
      counts.mappedLegacyAgentModelRows,
      counts.activeLegacyAgentModelAnomalies
    ),
    conservationCheck(
      "agent-current-metrics",
      counts.agentLatestMetricsRows,
      counts.mappedLegacyAgentCurrentMetricsRows,
      counts.activeLegacyAgentCurrentMetricsAnomalies
    ),
    conservationCheck(
      "monitor-history",
      counts.monitorStatusHistoryRows,
      counts.mappedLegacyMonitorHistoryRows,
      counts.activeLegacyMonitorHistoryAnomalies
    ),
    conservationCheck(
      "monitor-model",
      counts.monitorModelSourceRows,
      counts.mappedLegacyMonitorModelRows,
      counts.activeLegacyMonitorModelAnomalies
    ),
    conservationCheck(
      "monitor-daily-stats",
      counts.monitorDailyStatsRows,
      counts.mappedLegacyMonitorDailyStatsRows,
      counts.activeLegacyMonitorDailyStatsAnomalies
    ),
    conservationCheck(
      "notification-history",
      counts.notificationHistoryRows,
      counts.mappedLegacyNotificationHistoryRows,
      counts.activeLegacyNotificationHistoryAnomalies
    ),
    conservationCheck(
      "status-page",
      counts.legacyStatusPageRows,
      counts.mappedLegacyStatusPageRows,
      counts.activeLegacyStatusPageAnomalies
    ),
    conservationCheck(
      "notification-rules",
      counts.legacyNotificationRuleSourceRows,
      counts.mappedLegacyNotificationRuleRows,
      counts.activeLegacyNotificationRuleAnomalies
    ),
    conservationCheck(
      "notification-templates",
      counts.legacyNotificationTemplateRows,
      counts.mappedLegacyNotificationTemplateRows,
      counts.activeLegacyNotificationTemplateAnomalies
    ),
  ];
  for (const item of conservation) {
    if (!item.conserved) {
      warnings.push(
        `${item.key} 数据守恒差额为 ${item.difference ?? "unknown"}`
      );
    }
  }

  const contractReady =
    counts.adminUsers === 1 &&
    counts.unmigratedAgentCredentials === 0 &&
    counts.unmigratedNotificationEndpoints === 0 &&
    counts.notificationSecretsOutsideTargetKek === 0 &&
    counts.openMigrationAnomalies === 0 &&
    counts.incompleteMigrationCheckpoints === 0 &&
    counts.unconservedLegacyAgentHistoryRows === 0 &&
    counts.unconservedLegacyAgentModelRows === 0 &&
    counts.unconservedLegacyAgentCurrentMetricsRows === 0 &&
    counts.unconservedLegacyMonitorHistoryRows === 0 &&
    counts.unconservedLegacyMonitorModelRows === 0 &&
    counts.unconservedLegacyMonitorDailyStatsRows === 0 &&
    counts.unconservedLegacyNotificationHistoryRows === 0 &&
    counts.unconservedLegacyStatusPageRows === 0 &&
    counts.unconservedLegacyNotificationRuleRows === 0 &&
    counts.unconservedLegacyNotificationTemplateRows === 0 &&
    conservation.every((item) => item.conserved);

  return {
    generatedAt: new Date().toISOString(),
    database: resolvedDatabase,
    emptyDatabase,
    readyForExpand: blockers.length === 0,
    readyForCredentialContract: blockers.length === 0 && contractReady,
    blockers,
    warnings,
    counts,
    conservation,
    schema: {
      tables: tableNames,
      legacyHistoryTables,
      latestEmbeddedMigration,
      quickCheck,
      integrityCheck,
    },
  };
}

export function runMigrationPreflightSqlExport(
  sqlExportPath: string,
  options: { allowEmpty?: boolean; notificationKekVersion?: number } = {}
) {
  const tempDirectory = mkdtempSync(join(tmpdir(), "xugou-preflight-sql-"));
  const databasePath = join(tempDirectory, "export.sqlite");
  try {
    execFileSync("sqlite3", [databasePath], {
      encoding: "utf8",
      input: readFileSync(resolve(sqlExportPath), "utf8"),
    });
    return {
      ...runMigrationPreflight(databasePath, options),
      database: resolve(sqlExportPath),
    };
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function parseDatabaseArgument() {
  const index = process.argv.indexOf("--database");
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseSqlExportArgument() {
  const index = process.argv.indexOf("--sql-export");
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseIntegerArgument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const databasePath = parseDatabaseArgument();
  const sqlExportPath = parseSqlExportArgument();
  if (!databasePath && !sqlExportPath) {
    console.error(
      "用法: pnpm migration:preflight -- --database PATH | --sql-export PATH [--allow-empty] [--notification-kek-version N]"
    );
    process.exitCode = 2;
  } else {
    const options = {
      allowEmpty: process.argv.includes("--allow-empty"),
      notificationKekVersion: parseIntegerArgument("--notification-kek-version"),
    };
    const report = sqlExportPath
      ? runMigrationPreflightSqlExport(sqlExportPath, options)
      : runMigrationPreflight(databasePath!, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.readyForExpand) process.exitCode = 2;
  }
}
