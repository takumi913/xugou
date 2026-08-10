import type { Bindings } from "../../../models/db";
import { getEnvNumber } from "../../../utils/env";
import { legacyAgentHistoryCoverage } from "../../../platform/migrations/LegacyAgentHistoryBackfill";
import { legacyAgentModelCoverage } from "../../../platform/migrations/LegacyAgentModelBackfill";
import { legacyAgentCurrentMetricsCoverage } from "../../../platform/migrations/LegacyAgentCurrentMetricsBackfill";
import { legacyMonitorHistoryCoverage } from "../../../platform/migrations/LegacyMonitorHistoryBackfill";
import { legacyMonitorDailyStatsCoverage } from "../../../platform/migrations/LegacyMonitorDailyStatsBackfill";
import { legacyMonitorModelCoverage } from "../../../platform/migrations/LegacyMonitorModelBackfill";
import { legacyNotificationHistoryCoverage } from "../../../platform/migrations/LegacyNotificationHistoryBackfill";
import { legacyStatusPageCoverage } from "../../../platform/migrations/LegacyStatusPageBackfill";
import { legacyNotificationRulesCoverage } from "../../../platform/migrations/LegacyNotificationRulesBackfill";
import { legacyNotificationTemplatesCoverage } from "../../../platform/migrations/LegacyNotificationTemplatesBackfill";
import {
  dataCompatibilityMode,
  isContractMode,
} from "../../../platform/compatibility/CompatibilityMode";
import { sha256Hex } from "../../../utils/crypto";

type ReadinessRow = {
  jobs_backlog: number;
  oldest_job_available_at: string | null;
  outbox_backlog: number;
  oldest_outbox_available_at: string | null;
  notification_backlog: number;
  failed_notifications: number;
  open_queue_failures: number;
  open_migration_anomalies: number;
  incomplete_migration_checkpoints: number;
  unverified_raw_sample_archive_batches: number;
  unmigrated_agent_credentials: number;
  unmigrated_notification_endpoints: number;
  notification_secrets_outside_target_kek: number;
  active_publication_generated_at: string | null;
  management_v1_hits: number;
  agent_v1_hits: number;
  due_monitors: number;
  oldest_due_at: string | null;
  monitor_jobs_enqueued_last_minute: number;
};

type ContractReadinessRow = ReadinessRow & {
  evidence_id: string | null;
  evidence_bundle_sha256: string | null;
  evidence_release_version: string | null;
  evidence_git_sha: string | null;
  evidence_bundle_json: string | null;
  evidence_prepared_at: string | null;
  evidence_activated_at: string | null;
  evidence_phase: string | null;
};

type FrozenContractBundle = {
  formatVersion?: number;
  status?: string;
  gates?: Record<string, unknown>;
  conservation?: Array<Record<string, unknown>>;
  readinessSnapshot?: Record<string, unknown>;
};

function ageSeconds(nowMs: number, value: string | null) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.floor((nowMs - timestamp) / 1000))
    : null;
}

function check(
  key: string,
  actual: number | null,
  threshold: number,
  direction: "maximum" | "required"
) {
  const ready =
    direction === "maximum"
      ? actual !== null && actual <= threshold
      : actual !== null && actual >= threshold;
  return { key, ready, actual, threshold, direction };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function frozenCoverage(
  bundle: FrozenContractBundle,
  key: string,
  sourceTable = key
) {
  const row = bundle.conservation?.find((item) => item.key === key) ?? {};
  const sourceRows = Number(row.sourceRows ?? 0);
  const migratedRows = Number(row.migratedRows ?? 0);
  const deduplicatedRows = Number(row.deduplicatedRows ?? 0);
  const archivedRows = Number(row.archivedRows ?? 0);
  const anomalyRows = Number(row.anomalyRows ?? 0);
  const conserved = row.conserved === true;
  return {
    source_table: sourceTable,
    source_rows: sourceRows,
    mapped_rows: migratedRows + deduplicatedRows + archivedRows,
    anomaly_rows: anomalyRows,
    read_ready: conserved,
    conserved,
    frozen: true,
  };
}

export class D1ReleaseReadinessQuery {
  constructor(private readonly env: Bindings) {}

  async get(now = new Date()) {
    if (isContractMode(this.env)) return this.getContract(now);
    const nowIso = now.toISOString();
    const managementQuietDays = getEnvNumber(
      this.env,
      "MANAGEMENT_V1_QUIET_DAYS",
      7,
      { min: 1, max: 365 }
    );
    const agentQuietDays = getEnvNumber(this.env, "AGENT_V1_QUIET_DAYS", 60, {
      min: 1,
      max: 730,
    });
    const managementCutoff = new Date(
      now.getTime() - managementQuietDays * 86_400_000
    ).toISOString();
    const agentCutoff = new Date(
      now.getTime() - agentQuietDays * 86_400_000
    ).toISOString();
    const targetKekVersion = getEnvNumber(
      this.env,
      "NOTIFICATION_KEK_VERSION",
      1,
      { min: 1 }
    );
    const enqueueWindowStart = new Date(now.getTime() - 60_000).toISOString();

    const [
      row,
      legacyHistoryCoverage,
      legacyAgentModel,
      legacyAgentCurrentMetrics,
      legacyMonitorCoverage,
      legacyMonitorDailyCoverage,
      legacyMonitorModel,
      legacyNotificationCoverage,
      legacyStatusPage,
      legacyNotificationRules,
      legacyNotificationTemplates,
    ] = await Promise.all([
      this.env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM monitors
         WHERE active = 1 AND deleted_at IS NULL
           AND (next_check_at <= ? OR next_check_at IS NULL)) AS due_monitors,
        (SELECT MIN(COALESCE(next_check_at, created_at)) FROM monitors
         WHERE active = 1 AND deleted_at IS NULL
           AND (next_check_at <= ? OR next_check_at IS NULL)) AS oldest_due_at,
        (SELECT COUNT(*) FROM async_jobs
         WHERE kind = 'monitor.check' AND created_at >= ?)
           AS monitor_jobs_enqueued_last_minute,
        (SELECT COUNT(*) FROM async_jobs
         WHERE status IN ('pending', 'retry', 'processing')) AS jobs_backlog,
        (SELECT MIN(available_at) FROM async_jobs
         WHERE status IN ('pending', 'retry', 'processing')) AS oldest_job_available_at,
        (SELECT COUNT(*) FROM domain_outbox
         WHERE status IN ('pending', 'published')) AS outbox_backlog,
        (SELECT MIN(available_at) FROM domain_outbox
         WHERE status IN ('pending', 'published')) AS oldest_outbox_available_at,
        (SELECT COUNT(*) FROM notification_messages
         WHERE status IN ('pending', 'retry', 'sending')) AS notification_backlog,
        (SELECT COUNT(*) FROM notification_messages message
         WHERE message.status = 'failed'
           AND NOT EXISTS (
             SELECT 1 FROM notification_events event
             WHERE event.event_id = message.event_id
               AND event.source_event_id LIKE 'legacy-history:%'
           )) AS failed_notifications,
        (SELECT COUNT(*) FROM queue_failures WHERE status = 'open') AS open_queue_failures,
        (SELECT COUNT(*) FROM migration_anomalies
         WHERE status IN ('open', 'retry_requested')) AS open_migration_anomalies,
        (SELECT COUNT(*) FROM migration_checkpoints
         WHERE status IN ('running', 'failed')) AS incomplete_migration_checkpoints,
        (SELECT COUNT(*) FROM raw_sample_archive_batches
         WHERE status <> 'verified' OR verified_at IS NULL)
           AS unverified_raw_sample_archive_batches,
        (SELECT COUNT(*) FROM agents a
         WHERE a.deleted_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM agent_credentials c
           WHERE c.agent_id = a.id AND c.revoked_at IS NULL
         )) AS unmigrated_agent_credentials,
        (SELECT COUNT(*) FROM notification_channels c
         WHERE c.deleted_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM notification_endpoints e WHERE e.channel_id = c.id
         )) AS unmigrated_notification_endpoints,
        (SELECT COUNT(*) FROM notification_secrets
         WHERE key_version <> ?) AS notification_secrets_outside_target_kek,
        (SELECT p.generated_at FROM status_publication_state s
         JOIN status_publications p ON p.id = s.active_publication_id
         WHERE s.singleton_key = 1 LIMIT 1) AS active_publication_generated_at,
        (SELECT COALESCE(SUM(hit_count), 0) FROM api_compatibility_hits
         WHERE route_group IN (
           'monitor_management_v1', 'agent_management_v1',
           'notification_management_v1', 'status_v1'
         ) AND last_seen_at >= ?) AS management_v1_hits,
        (SELECT COALESCE(SUM(hit_count), 0) FROM api_compatibility_hits
         WHERE route_group IN ('agent_registration_v1', 'agent_report_v1')
           AND last_seen_at >= ?) AS agent_v1_hits`
      )
      .bind(
        nowIso,
        nowIso,
        enqueueWindowStart,
        targetKekVersion,
        managementCutoff,
        agentCutoff
      )
      .first<ReadinessRow>(),
      legacyAgentHistoryCoverage(this.env),
      legacyAgentModelCoverage(this.env),
      legacyAgentCurrentMetricsCoverage(this.env),
      legacyMonitorHistoryCoverage(this.env),
      legacyMonitorDailyStatsCoverage(this.env),
      legacyMonitorModelCoverage(this.env),
      legacyNotificationHistoryCoverage(this.env),
      legacyStatusPageCoverage(this.env),
      legacyNotificationRulesCoverage(this.env),
      legacyNotificationTemplatesCoverage(this.env),
    ]);
    if (!row) throw new Error("Release readiness query returned no row");

    const jobLagSeconds = ageSeconds(now.getTime(), row.oldest_job_available_at);
    const outboxLagSeconds = ageSeconds(now.getTime(), row.oldest_outbox_available_at);
    const publicationAgeSeconds = ageSeconds(
      now.getTime(),
      row.active_publication_generated_at
    );
    const schedulerLagSeconds = Number(row.due_monitors) > 0
      ? ageSeconds(now.getTime(), row.oldest_due_at)
      : 0;
    const checks = [
      check("contract_worker_compatible", 1, 1, "required"),
      check(
        "scheduler_lag_seconds",
        schedulerLagSeconds,
        getEnvNumber(this.env, "RELEASE_MAX_SCHEDULER_LAG_SECONDS", 300, {
          min: 0,
        }),
        "maximum"
      ),
      check(
        "jobs_backlog",
        Number(row.jobs_backlog),
        getEnvNumber(this.env, "RELEASE_MAX_JOBS_BACKLOG", 100, { min: 0 }),
        "maximum"
      ),
      check(
        "job_lag_seconds",
        jobLagSeconds ?? 0,
        getEnvNumber(this.env, "RELEASE_MAX_JOB_LAG_SECONDS", 300, { min: 0 }),
        "maximum"
      ),
      check(
        "outbox_backlog",
        Number(row.outbox_backlog),
        getEnvNumber(this.env, "RELEASE_MAX_OUTBOX_BACKLOG", 100, { min: 0 }),
        "maximum"
      ),
      check(
        "outbox_lag_seconds",
        outboxLagSeconds ?? 0,
        getEnvNumber(this.env, "RELEASE_MAX_OUTBOX_LAG_SECONDS", 300, {
          min: 0,
        }),
        "maximum"
      ),
      check(
        "notification_backlog",
        Number(row.notification_backlog),
        getEnvNumber(this.env, "RELEASE_MAX_NOTIFICATION_BACKLOG", 100, {
          min: 0,
        }),
        "maximum"
      ),
      check("failed_notifications", Number(row.failed_notifications), 0, "maximum"),
      check("open_queue_failures", Number(row.open_queue_failures), 0, "maximum"),
      check(
        "open_migration_anomalies",
        Number(row.open_migration_anomalies),
        0,
        "maximum"
      ),
      check(
        "incomplete_migration_checkpoints",
        Number(row.incomplete_migration_checkpoints),
        0,
        "maximum"
      ),
      check(
        "unverified_raw_sample_archive_batches",
        Number(row.unverified_raw_sample_archive_batches),
        0,
        "maximum"
      ),
      check(
        "unmigrated_agent_credentials",
        Number(row.unmigrated_agent_credentials),
        0,
        "maximum"
      ),
      check(
        "unmigrated_notification_endpoints",
        Number(row.unmigrated_notification_endpoints),
        0,
        "maximum"
      ),
      check(
        "notification_secrets_outside_target_kek",
        Number(row.notification_secrets_outside_target_kek),
        0,
        "maximum"
      ),
      check(
        "active_publication_age_seconds",
        publicationAgeSeconds,
        getEnvNumber(this.env, "RELEASE_MAX_PUBLICATION_AGE_SECONDS", 300, {
          min: 1,
        }),
        "maximum"
      ),
      check(
        "legacy_history_unconserved_tables",
        legacyHistoryCoverage.filter((item) => !item.conserved).length,
        0,
        "maximum"
      ),
      check(
        "legacy_agent_model_unconserved",
        legacyAgentModel.conserved ? 0 : 1,
        0,
        "maximum"
      ),
      check(
        "legacy_agent_current_metrics_unconserved",
        legacyAgentCurrentMetrics.conserved ? 0 : 1,
        0,
        "maximum"
      ),
      check(
        "legacy_monitor_history_unconserved",
        legacyMonitorCoverage.conserved ? 0 : 1,
        0,
        "maximum"
      ),
      check(
        "legacy_monitor_daily_stats_unconserved",
        legacyMonitorDailyCoverage.conserved ? 0 : 1,
        0,
        "maximum"
      ),
      check(
        "legacy_monitor_model_unconserved",
        legacyMonitorModel.conserved ? 0 : 1,
        0,
        "maximum"
      ),
      check(
        "legacy_notification_history_unconserved",
        legacyNotificationCoverage.conserved ? 0 : 1,
        0,
        "maximum"
      ),
      check(
        "legacy_status_page_unconserved",
        legacyStatusPage.conserved ? 0 : 1,
        0,
        "maximum"
      ),
      check(
        "legacy_notification_rules_unconserved",
        legacyNotificationRules.conserved ? 0 : 1,
        0,
        "maximum"
      ),
      check(
        "legacy_notification_templates_unconserved",
        legacyNotificationTemplates.conserved ? 0 : 1,
        0,
        "maximum"
      ),
    ];
    const credentialContractKeys = new Set([
      "open_migration_anomalies",
      "incomplete_migration_checkpoints",
      "unverified_raw_sample_archive_batches",
      "unmigrated_agent_credentials",
      "unmigrated_notification_endpoints",
      "notification_secrets_outside_target_kek",
      "legacy_history_unconserved_tables",
      "legacy_agent_model_unconserved",
      "legacy_agent_current_metrics_unconserved",
      "legacy_monitor_history_unconserved",
      "legacy_monitor_daily_stats_unconserved",
      "legacy_monitor_model_unconserved",
      "legacy_notification_history_unconserved",
      "legacy_status_page_unconserved",
      "legacy_notification_rules_unconserved",
      "legacy_notification_templates_unconserved",
    ]);

    return {
      generated_at: nowIso,
      release_version: this.env.CF_VERSION_METADATA?.id ?? "local",
      data_compatibility_mode: dataCompatibilityMode(this.env),
      contract_worker_ready: true,
      contract_evidence: null,
      release_ready: checks.every((item) => item.ready),
      credential_contract_ready: checks
        .filter((item) => credentialContractKeys.has(item.key))
        .every((item) => item.ready),
      management_v1_sunset_ready: Number(row.management_v1_hits) === 0,
      agent_v1_sunset_ready: Number(row.agent_v1_hits) === 0,
      compatibility_windows: {
        management_quiet_days: managementQuietDays,
        management_hits: Number(row.management_v1_hits),
        agent_quiet_days: agentQuietDays,
        agent_hits: Number(row.agent_v1_hits),
      },
      scheduler: {
        due_count: Number(row.due_monitors),
        oldest_due_at: row.oldest_due_at,
        lag_seconds: schedulerLagSeconds,
        enqueued_last_minute: Number(row.monitor_jobs_enqueued_last_minute),
        enqueue_rate_per_minute: Number(row.monitor_jobs_enqueued_last_minute),
      },
      legacy_history_coverage: legacyHistoryCoverage,
      legacy_agent_model_coverage: legacyAgentModel,
      legacy_agent_current_metrics_coverage: legacyAgentCurrentMetrics,
      legacy_monitor_history_coverage: legacyMonitorCoverage,
      legacy_monitor_daily_stats_coverage: legacyMonitorDailyCoverage,
      legacy_monitor_model_coverage: legacyMonitorModel,
      legacy_notification_history_coverage: legacyNotificationCoverage,
      legacy_status_page_coverage: legacyStatusPage,
      legacy_notification_rules_coverage: legacyNotificationRules,
      legacy_notification_templates_coverage: legacyNotificationTemplates,
      checks,
    };
  }

  private async getContract(now: Date) {
    const nowIso = now.toISOString();
    const managementQuietDays = getEnvNumber(
      this.env,
      "MANAGEMENT_V1_QUIET_DAYS",
      7,
      { min: 1, max: 365 }
    );
    const agentQuietDays = getEnvNumber(this.env, "AGENT_V1_QUIET_DAYS", 60, {
      min: 1,
      max: 730,
    });
    const managementCutoff = new Date(
      now.getTime() - managementQuietDays * 86_400_000
    ).toISOString();
    const agentCutoff = new Date(
      now.getTime() - agentQuietDays * 86_400_000
    ).toISOString();
    const targetKekVersion = getEnvNumber(
      this.env,
      "NOTIFICATION_KEK_VERSION",
      1,
      { min: 1 }
    );
    const enqueueWindowStart = new Date(now.getTime() - 60_000).toISOString();
    const row = await this.env.DB.prepare(
      `WITH active_evidence AS (
         SELECT evidence.id, evidence.bundle_sha256, evidence.release_version,
                evidence.git_sha, evidence.bundle_json, evidence.prepared_at,
                state.activated_at, state.phase
         FROM contract_release_state state
         JOIN contract_release_evidence evidence
           ON evidence.id = state.active_evidence_id
         WHERE state.singleton_key = 1 AND state.phase = 'active'
         LIMIT 1
       )
       SELECT
        (SELECT COUNT(*) FROM monitor_definitions definition
         JOIN monitor_runtime runtime ON runtime.monitor_id = definition.id
         WHERE definition.active = 1 AND definition.deleted_at_ms IS NULL
           AND (runtime.next_due_at_ms <= ? OR runtime.next_due_at_ms IS NULL))
           AS due_monitors,
        (SELECT MIN(CASE WHEN runtime.next_due_at_ms IS NULL
                         THEN strftime('%Y-%m-%dT%H:%M:%fZ',
                                       definition.created_at_ms / 1000.0, 'unixepoch')
                         ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                                       runtime.next_due_at_ms / 1000.0, 'unixepoch') END)
         FROM monitor_definitions definition
         JOIN monitor_runtime runtime ON runtime.monitor_id = definition.id
         WHERE definition.active = 1 AND definition.deleted_at_ms IS NULL
           AND (runtime.next_due_at_ms <= ? OR runtime.next_due_at_ms IS NULL))
           AS oldest_due_at,
        (SELECT COUNT(*) FROM async_jobs
         WHERE kind = 'monitor.check' AND created_at >= ?)
           AS monitor_jobs_enqueued_last_minute,
        (SELECT COUNT(*) FROM async_jobs
         WHERE status IN ('pending', 'retry', 'processing')) AS jobs_backlog,
        (SELECT MIN(available_at) FROM async_jobs
         WHERE status IN ('pending', 'retry', 'processing')) AS oldest_job_available_at,
        (SELECT COUNT(*) FROM domain_outbox
         WHERE status IN ('pending', 'published')) AS outbox_backlog,
        (SELECT MIN(available_at) FROM domain_outbox
         WHERE status IN ('pending', 'published')) AS oldest_outbox_available_at,
        (SELECT COUNT(*) FROM notification_messages
         WHERE status IN ('pending', 'retry', 'sending')) AS notification_backlog,
        (SELECT COUNT(*) FROM notification_messages message
         WHERE message.status = 'failed'
           AND NOT EXISTS (
             SELECT 1 FROM notification_events event
             WHERE event.event_id = message.event_id
               AND event.source_event_id LIKE 'legacy-history:%'
           )) AS failed_notifications,
        (SELECT COUNT(*) FROM queue_failures WHERE status = 'open') AS open_queue_failures,
        (SELECT COUNT(*) FROM migration_anomalies
         WHERE status IN ('open', 'retry_requested')) AS open_migration_anomalies,
        (SELECT COUNT(*) FROM migration_checkpoints
         WHERE status IN ('running', 'failed')) AS incomplete_migration_checkpoints,
        (SELECT COUNT(*) FROM raw_sample_archive_batches
         WHERE status <> 'verified' OR verified_at IS NULL)
           AS unverified_raw_sample_archive_batches,
        (SELECT COUNT(*) FROM agent_nodes node
         WHERE node.deleted_at_ms IS NULL AND NOT EXISTS (
           SELECT 1 FROM agent_credentials credential
           WHERE credential.agent_id = node.id AND credential.revoked_at IS NULL
         )) AS unmigrated_agent_credentials,
        (SELECT COUNT(*) FROM notification_channels channel
         WHERE channel.deleted_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM notification_endpoints endpoint
           WHERE endpoint.channel_id = channel.id
         )) AS unmigrated_notification_endpoints,
        (SELECT COUNT(*) FROM notification_secrets
         WHERE key_version <> ?) AS notification_secrets_outside_target_kek,
        (SELECT publication.generated_at FROM status_publication_state state
         JOIN status_publications publication
           ON publication.id = state.active_publication_id
         WHERE state.singleton_key = 1 LIMIT 1) AS active_publication_generated_at,
        (SELECT COALESCE(SUM(hit_count), 0) FROM api_compatibility_hits
         WHERE route_group IN (
           'monitor_management_v1', 'agent_management_v1',
           'notification_management_v1', 'status_v1'
         ) AND last_seen_at >= ?) AS management_v1_hits,
        (SELECT COALESCE(SUM(hit_count), 0) FROM api_compatibility_hits
         WHERE route_group IN ('agent_registration_v1', 'agent_report_v1')
           AND last_seen_at >= ?) AS agent_v1_hits,
        (SELECT id FROM active_evidence) AS evidence_id,
        (SELECT bundle_sha256 FROM active_evidence) AS evidence_bundle_sha256,
        (SELECT release_version FROM active_evidence) AS evidence_release_version,
        (SELECT git_sha FROM active_evidence) AS evidence_git_sha,
        (SELECT bundle_json FROM active_evidence) AS evidence_bundle_json,
        (SELECT prepared_at FROM active_evidence) AS evidence_prepared_at,
        (SELECT activated_at FROM active_evidence) AS evidence_activated_at,
        (SELECT phase FROM active_evidence) AS evidence_phase`
    )
      .bind(
        now.getTime(),
        now.getTime(),
        enqueueWindowStart,
        targetKekVersion,
        managementCutoff,
        agentCutoff
      )
      .first<ContractReadinessRow>();
    if (!row) throw new Error("Contract release readiness query returned no row");

    let bundle: FrozenContractBundle = {};
    try {
      bundle = row.evidence_bundle_json
        ? (JSON.parse(row.evidence_bundle_json) as FrozenContractBundle)
        : {};
    } catch {
      bundle = {};
    }
    const digestValid =
      row.evidence_bundle_json !== null &&
      row.evidence_bundle_sha256 !== null &&
      (await sha256Hex(row.evidence_bundle_json)) === row.evidence_bundle_sha256;
    const gates = record(bundle.gates);
    const frozenGatesReady = [
      "sqliteIntegrity",
      "foreignKeys",
      "credentialsAndSecrets",
      "managementV1Sunset",
      "agentV1Sunset",
      "queuesAndPublications",
      "allDataConserved",
    ].every((key) => gates[key] === true);
    const evidenceActive =
      row.evidence_phase === "active" &&
      bundle.formatVersion === 2 &&
      bundle.status === "ready" &&
      digestValid &&
      frozenGatesReady;
    const jobLagSeconds = ageSeconds(now.getTime(), row.oldest_job_available_at);
    const outboxLagSeconds = ageSeconds(now.getTime(), row.oldest_outbox_available_at);
    const publicationAgeSeconds = ageSeconds(
      now.getTime(),
      row.active_publication_generated_at
    );
    const schedulerLagSeconds = Number(row.due_monitors) > 0
      ? ageSeconds(now.getTime(), row.oldest_due_at)
      : 0;
    const checks = [
      check("contract_worker_compatible", 1, 1, "required"),
      check(
        "scheduler_lag_seconds",
        schedulerLagSeconds,
        getEnvNumber(this.env, "RELEASE_MAX_SCHEDULER_LAG_SECONDS", 300, {
          min: 0,
        }),
        "maximum"
      ),
      check("contract_evidence_active", evidenceActive ? 1 : 0, 1, "required"),
      check("contract_evidence_digest_valid", digestValid ? 1 : 0, 1, "required"),
      check(
        "frozen_all_data_conserved",
        gates.allDataConserved === true ? 1 : 0,
        1,
        "required"
      ),
      check(
        "jobs_backlog",
        Number(row.jobs_backlog),
        getEnvNumber(this.env, "RELEASE_MAX_JOBS_BACKLOG", 100, { min: 0 }),
        "maximum"
      ),
      check(
        "job_lag_seconds",
        jobLagSeconds ?? 0,
        getEnvNumber(this.env, "RELEASE_MAX_JOB_LAG_SECONDS", 300, { min: 0 }),
        "maximum"
      ),
      check(
        "outbox_backlog",
        Number(row.outbox_backlog),
        getEnvNumber(this.env, "RELEASE_MAX_OUTBOX_BACKLOG", 100, { min: 0 }),
        "maximum"
      ),
      check(
        "outbox_lag_seconds",
        outboxLagSeconds ?? 0,
        getEnvNumber(this.env, "RELEASE_MAX_OUTBOX_LAG_SECONDS", 300, {
          min: 0,
        }),
        "maximum"
      ),
      check(
        "notification_backlog",
        Number(row.notification_backlog),
        getEnvNumber(this.env, "RELEASE_MAX_NOTIFICATION_BACKLOG", 100, {
          min: 0,
        }),
        "maximum"
      ),
      check("failed_notifications", Number(row.failed_notifications), 0, "maximum"),
      check("open_queue_failures", Number(row.open_queue_failures), 0, "maximum"),
      check(
        "open_migration_anomalies",
        Number(row.open_migration_anomalies),
        0,
        "maximum"
      ),
      check(
        "incomplete_migration_checkpoints",
        Number(row.incomplete_migration_checkpoints),
        0,
        "maximum"
      ),
      check(
        "unverified_raw_sample_archive_batches",
        Number(row.unverified_raw_sample_archive_batches),
        0,
        "maximum"
      ),
      check(
        "unmigrated_agent_credentials",
        Number(row.unmigrated_agent_credentials),
        0,
        "maximum"
      ),
      check(
        "unmigrated_notification_endpoints",
        Number(row.unmigrated_notification_endpoints),
        0,
        "maximum"
      ),
      check(
        "notification_secrets_outside_target_kek",
        Number(row.notification_secrets_outside_target_kek),
        0,
        "maximum"
      ),
      check(
        "active_publication_age_seconds",
        publicationAgeSeconds,
        getEnvNumber(this.env, "RELEASE_MAX_PUBLICATION_AGE_SECONDS", 300, {
          min: 1,
        }),
        "maximum"
      ),
    ];
    const credentialContractKeys = new Set([
      "contract_worker_compatible",
      "contract_evidence_active",
      "contract_evidence_digest_valid",
      "frozen_all_data_conserved",
      "open_migration_anomalies",
      "incomplete_migration_checkpoints",
      "unverified_raw_sample_archive_batches",
      "unmigrated_agent_credentials",
      "unmigrated_notification_endpoints",
      "notification_secrets_outside_target_kek",
    ]);
    const snapshot = record(bundle.readinessSnapshot);
    const snapshotValue = (key: string, fallback: unknown) =>
      snapshot[key] === undefined ? fallback : snapshot[key];

    return {
      generated_at: nowIso,
      release_version: this.env.CF_VERSION_METADATA?.id ?? "local",
      data_compatibility_mode: dataCompatibilityMode(this.env),
      contract_worker_ready: true,
      contract_evidence: {
        id: row.evidence_id,
        bundle_sha256: row.evidence_bundle_sha256,
        release_version: row.evidence_release_version,
        git_sha: row.evidence_git_sha,
        prepared_at: row.evidence_prepared_at,
        activated_at: row.evidence_activated_at,
        digest_valid: digestValid,
      },
      release_ready: checks.every((item) => item.ready),
      credential_contract_ready: checks
        .filter((item) => credentialContractKeys.has(item.key))
        .every((item) => item.ready),
      management_v1_sunset_ready: Number(row.management_v1_hits) === 0,
      agent_v1_sunset_ready: Number(row.agent_v1_hits) === 0,
      compatibility_windows: {
        management_quiet_days: managementQuietDays,
        management_hits: Number(row.management_v1_hits),
        agent_quiet_days: agentQuietDays,
        agent_hits: Number(row.agent_v1_hits),
      },
      scheduler: {
        due_count: Number(row.due_monitors),
        oldest_due_at: row.oldest_due_at,
        lag_seconds: schedulerLagSeconds,
        enqueued_last_minute: Number(row.monitor_jobs_enqueued_last_minute),
        enqueue_rate_per_minute: Number(row.monitor_jobs_enqueued_last_minute),
      },
      legacy_history_coverage: snapshotValue("legacy_history_coverage", [
        frozenCoverage(bundle, "agent-history"),
      ]),
      legacy_agent_model_coverage: snapshotValue(
        "legacy_agent_model_coverage",
        frozenCoverage(bundle, "agent-model", "agents")
      ),
      legacy_agent_current_metrics_coverage: snapshotValue(
        "legacy_agent_current_metrics_coverage",
        frozenCoverage(bundle, "agent-current-metrics", "agent_latest_metrics")
      ),
      legacy_monitor_history_coverage: snapshotValue(
        "legacy_monitor_history_coverage",
        frozenCoverage(bundle, "monitor-history", "monitor_status_history_24h")
      ),
      legacy_monitor_daily_stats_coverage: snapshotValue(
        "legacy_monitor_daily_stats_coverage",
        frozenCoverage(bundle, "monitor-daily-stats", "monitor_daily_stats")
      ),
      legacy_monitor_model_coverage: snapshotValue(
        "legacy_monitor_model_coverage",
        frozenCoverage(bundle, "monitor-model", "monitors")
      ),
      legacy_notification_history_coverage: snapshotValue(
        "legacy_notification_history_coverage",
        frozenCoverage(bundle, "notification-history", "notification_history")
      ),
      legacy_status_page_coverage: snapshotValue(
        "legacy_status_page_coverage",
        frozenCoverage(bundle, "status-page", "status_page_config+relations")
      ),
      legacy_notification_rules_coverage: snapshotValue(
        "legacy_notification_rules_coverage",
        frozenCoverage(bundle, "notification-rules", "notification_settings")
      ),
      legacy_notification_templates_coverage: snapshotValue(
        "legacy_notification_templates_coverage",
        frozenCoverage(bundle, "notification-templates", "notification_templates")
      ),
      checks,
    };
  }

  async listCompatibilityHits(days: number, now = new Date()) {
    const cutoff = new Date(now.getTime() - (days - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return (
      await this.env.DB.prepare(
        `SELECT day, route_group, method, status_family, hit_count,
                first_seen_at, last_seen_at, last_release_version
         FROM api_compatibility_hits
         WHERE day >= ?
         ORDER BY day DESC, route_group ASC, method ASC, status_family ASC
         LIMIT 10000`
      )
        .bind(cutoff)
        .all<Record<string, unknown>>()
    ).results;
  }
}
