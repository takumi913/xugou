import type { Bindings } from "../../../models/db";
import type {
  OutboxConsumer,
  StoredOutboxEvent,
} from "../../../platform/queues/outbox";
import { sendRenderedNotification as sendThroughProvider } from "../persistence/NotificationProviderAdapter";


interface MonitorCheckedPayload {
  changed?: boolean;
  previous_status?: string | null;
  status?: string;
  response_time_ms?: number;
  status_code?: number | null;
  error?: string | null;
}

interface AgentEventPayload {
  previous_status?: string | null;
  status?: string;
  changed_at?: string;
  observed_at?: string;
  cpu?: number | null;
  memory?: number | null;
  disk?: number | null;
  expire_date?: string;
  days_remaining?: number;
  billing_cycle?: string | null;
  auto_renewal?: boolean;
}

interface NotificationProjection {
  type: "monitor" | "agent";
  targetId: number;
  eventKey: string;
  variables: Record<string, string>;
  channelIds: number[];
  cooldownMinutes: number;
  template: { id: number; subject: string; content: string };
}

interface NotificationMessageRow {
  message_id: string;
  event_id: string;
  channel_id: number;
  template_id: number;
  subject: string;
  content: string;
  cooldown_minutes: number;
  status: string;
  attempts: number;
  max_attempts: number;
  available_at: string;
}

function render(template: string, variables: Record<string, string>) {
  return Object.entries(variables).reduce(
    (result, [key, value]) => result.replaceAll(`\${${key}}`, value),
    template
  );
}

function parseChannelIds(value: string | null) {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0))]
      : [];
  } catch {
    return [];
  }
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2048);
}

function formatIpAddresses(value: string | null) {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      const addresses = parsed.filter((item): item is string => typeof item === "string");
      return addresses.length > 0 ? addresses.join(", ") : "未知";
    }
  } catch {
    // 旧数据可能保存为普通字符串。
  }
  return value?.trim() || "未知";
}

export class NotificationOutboxConsumer implements OutboxConsumer {
  readonly consumerName = "notifications.v1";
  readonly eventTypes = [
    "monitor.checked",
    "agent.status.changed",
    "agent.metrics.observed",
    "agent.expiry.reminder",
  ] as const;

  constructor(
    private readonly env: Bindings,
    private readonly sender: (
      channelId: number,
      subject: string,
      content: string,
      env: Bindings
    ) => Promise<{ success: boolean; error?: string }> = (
      channelId,
      subject,
      content,
      env
    ) => sendThroughProvider(env, channelId, subject, content)
  ) {}

  private async findSetting(
    specificType: "monitor" | "agent",
    targetId: number,
    globalType: "global-monitor" | "global-agent"
  ) {
    const select = `SELECT rule.*,
                COALESCE((
                  SELECT json_group_array(channel_id) FROM (
                    SELECT endpoint.channel_id
                    FROM notification_rule_endpoints endpoint
                    WHERE endpoint.rule_id = rule.id
                    ORDER BY endpoint.sort_order, endpoint.channel_id
                  )
                ), '[]') AS channels
         FROM notification_rules rule`;
    const specific = await this.env.DB.prepare(
      `${select}
       WHERE target_type = ? AND target_id = ? AND enabled = 1
       ORDER BY id LIMIT 1`
    )
      .bind(specificType, targetId)
      .first<Record<string, unknown>>();
    return (
      specific ??
      (await this.env.DB.prepare(
        `${select}
         WHERE target_type = ? AND enabled = 1
         ORDER BY id LIMIT 1`
      )
        .bind(globalType)
        .first<Record<string, unknown>>())
    );
  }

  private async findTemplate(type: "monitor" | "agent") {
    return this.env.DB.prepare(
      `SELECT definition.id, version.subject, version.content
       FROM notification_template_definitions definition
       JOIN notification_template_versions version
         ON version.template_id = definition.id
        AND version.version = definition.current_version
       WHERE definition.type = ? AND definition.deleted_at_ms IS NULL
       ORDER BY definition.is_default DESC, definition.id ASC LIMIT 1`
    )
      .bind(type)
      .first<{ id: number; subject: string; content: string }>();
  }

  private async buildMonitorProjection(
    event: StoredOutboxEvent
  ): Promise<NotificationProjection | null> {
    const payload = JSON.parse(event.payload_json) as MonitorCheckedPayload;
    if (!payload.changed || !payload.status) return null;
    const monitorId = Number(event.aggregate_id);
    if (!Number.isSafeInteger(monitorId) || monitorId <= 0) return null;
    const monitor = await this.env.DB.prepare(
      `SELECT id, name, url, expected_status
       FROM monitor_definitions
       WHERE id = ? AND deleted_at_ms IS NULL LIMIT 1`
    )
      .bind(monitorId)
      .first<{ id: number; name: string; url: string; expected_status: number }>();
    if (!monitor) return null;

    const setting = await this.findSetting(
      "monitor",
      monitorId,
      "global-monitor"
    );
    if (!setting) return null;
    const previousStatus = payload.previous_status ?? "unknown";
    const shouldSend =
      (previousStatus !== "down" && payload.status === "down" && Number(setting.on_down) === 1) ||
      (previousStatus === "down" && payload.status === "up" && Number(setting.on_recovery) === 1);
    if (!shouldSend) return null;
    const channelIds = parseChannelIds(String(setting.channels ?? "[]"));
    if (channelIds.length === 0) return null;
    const template = await this.findTemplate("monitor");
    if (!template) throw new Error("Monitor notification template is missing");

    const error =
      payload.status === "up"
        ? "服务已恢复访问 🟢"
        : `${payload.error ?? "服务无法访问"} 🔴`;
    const variables = {
      name: monitor.name,
      status: payload.status,
      previous_status: previousStatus,
      time: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      url: monitor.url,
      response_time: `${payload.response_time_ms ?? 0}ms`,
      status_code: payload.status_code?.toString() ?? "无",
      expected_status: String(monitor.expected_status),
      error,
      details: `URL: ${monitor.url}\n响应时间: ${payload.response_time_ms ?? 0}ms\n状态码: ${payload.status_code ?? "无"}\n错误信息: ${payload.error ?? "无"}`,
    };
    return {
      type: "monitor",
      targetId: monitorId,
      eventKey: payload.status,
      variables,
      channelIds,
      cooldownMinutes: Math.max(
        0,
        Math.min(1440, Number(setting.cooldown_minutes ?? 30))
      ),
      template,
    };
  }

  private async buildAgentProjection(
    event: StoredOutboxEvent
  ): Promise<NotificationProjection | null> {
    const payload = JSON.parse(event.payload_json) as AgentEventPayload;
    const agentId = Number(event.aggregate_id);
    if (!Number.isSafeInteger(agentId) || agentId <= 0) return null;
    const agent = await this.env.DB.prepare(
      `SELECT n.id, n.name, r.hostname,
              r.ip_addresses_json AS ip_addresses, r.os,
              CASE WHEN r.last_seen_at_ms IS NULL THEN NULL
                   ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
                                 r.last_seen_at_ms / 1000.0, 'unixepoch') END
                AS last_seen_at,
              strftime('%Y-%m-%dT%H:%M:%fZ',
                       r.updated_at_ms / 1000.0, 'unixepoch') AS updated_at
       FROM agent_nodes n JOIN agent_runtime r ON r.agent_id = n.id
       WHERE n.id = ? AND n.deleted_at_ms IS NULL LIMIT 1`
    )
      .bind(agentId)
      .first<{
        id: number;
        name: string;
        hostname: string | null;
        ip_addresses: string | null;
        os: string | null;
        last_seen_at: string | null;
        updated_at: string;
      }>();
    if (!agent) return null;

    const setting = await this.findSetting("agent", agentId, "global-agent");
    if (!setting) return null;

    const channelIds = parseChannelIds(String(setting.channels ?? "[]"));
    if (channelIds.length === 0) return null;
    const template = await this.findTemplate("agent");
    if (!template) throw new Error("Agent notification template is missing");

    const ipAddresses = formatIpAddresses(agent.ip_addresses);
    let eventKey: string;
    let status: string;
    let previousStatus: string;
    let error: string;
    let details: string;
    let occurredAt: string;

    if (event.event_type === "agent.status.changed") {
      if (!payload.status) return null;
      previousStatus = payload.previous_status ?? "unknown";
      const shouldSend =
        (payload.status === "offline" && Number(setting.on_offline) === 1) ||
        (payload.status === "online" &&
          previousStatus === "offline" &&
          Number(setting.on_recovery) === 1);
      if (!shouldSend) return null;
      eventKey = payload.status;
      status = payload.status;
      occurredAt = payload.changed_at ?? new Date().toISOString();
      error =
        payload.status === "online"
          ? "客户端连接已恢复 🟢"
          : "客户端连接超时 🔴";
      details =
        payload.status === "online"
          ? `主机名: ${agent.hostname || "未知"}\nIP地址: ${ipAddresses}\n操作系统: ${agent.os || "未知"}\n恢复时间: ${occurredAt}`
          : `主机名: ${agent.hostname || "未知"}\nIP地址: ${ipAddresses}\n操作系统: ${agent.os || "未知"}\n最后连接时间: ${agent.last_seen_at ?? agent.updated_at}`;
    } else if (event.event_type === "agent.expiry.reminder") {
      if (!payload.expire_date || !Number.isSafeInteger(payload.days_remaining)) {
        return null;
      }
      eventKey = `expiry:${payload.expire_date}`;
      status = `即将到期（剩余 ${payload.days_remaining} 天）`;
      previousStatus = "active";
      occurredAt = payload.observed_at ?? new Date().toISOString();
      error = `客户端将于 ${payload.expire_date} 到期 ⏰`;
      details =
        `到期日期: ${payload.expire_date}\n` +
        `剩余天数: ${payload.days_remaining} 天\n` +
        `计费周期: ${payload.billing_cycle || "未设置"}\n` +
        `自动续费: ${payload.auto_renewal ? "已开启" : "未开启"}`;
    } else {
      const thresholdEvents = [
        {
          name: "CPU使用率",
          value: payload.cpu,
          threshold: Number(setting.cpu_threshold ?? 90),
          enabled: Number(setting.on_cpu_threshold) === 1,
        },
        {
          name: "内存使用率",
          value: payload.memory,
          threshold: Number(setting.memory_threshold ?? 85),
          enabled: Number(setting.on_memory_threshold) === 1,
        },
        {
          name: "磁盘使用率",
          value: payload.disk,
          threshold: Number(setting.disk_threshold ?? 90),
          enabled: Number(setting.on_disk_threshold) === 1,
        },
      ].filter(
        (item) =>
          item.enabled &&
          typeof item.value === "number" &&
          Number.isFinite(item.value) &&
          item.value >= item.threshold
      );
      if (thresholdEvents.length === 0) return null;
      const metricNames = thresholdEvents.map((item) => item.name).join("、");
      eventKey = "threshold";
      status = `资源阈值告警: ${metricNames}`;
      previousStatus = "normal";
      occurredAt = payload.observed_at ?? new Date().toISOString();
      error = `${metricNames}超过阈值`;
      details = thresholdEvents
        .map(
          (item) =>
            `${item.name}: ${item.value!.toFixed(2)}%\n阈值: ${item.threshold}%`
        )
        .join("\n\n");
      details += `\n\n主机名: ${agent.hostname || "未知"}\nIP地址: ${ipAddresses}\n操作系统: ${agent.os || "未知"}`;
    }

    return {
      type: "agent",
      targetId: agentId,
      eventKey,
      variables: {
        name: agent.name,
        status,
        previous_status: previousStatus,
        time: new Date(occurredAt).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
        }),
        hostname: agent.hostname || "未知",
        ip_addresses: ipAddresses,
        ip_address: ipAddresses,
        os: agent.os || "未知",
        error,
        details,
      },
      channelIds,
      cooldownMinutes: Math.max(
        0,
        Math.min(1440, Number(setting.cooldown_minutes ?? 30))
      ),
      template,
    };
  }

  private async project(event: StoredOutboxEvent) {
    const projection =
      event.event_type === "monitor.checked"
        ? await this.buildMonitorProjection(event)
        : await this.buildAgentProjection(event);
    if (!projection) return null;

    const now = new Date().toISOString();
    const notificationEventId = `notification:${event.event_id}`;
    const statements = [
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO notification_events
         (event_id, source_event_id, type, target_id, event_key, variables_json,
          status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).bind(
        notificationEventId,
        event.event_id,
        projection.type,
        projection.targetId,
        projection.eventKey,
        JSON.stringify(projection.variables),
        now,
        now
      ),
    ];
    for (const channelId of projection.channelIds) {
      statements.push(
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO notification_messages
           (message_id, event_id, channel_id, template_id, subject, content,
            cooldown_minutes, status, attempts, max_attempts, available_at,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 5, ?, ?, ?)`
        ).bind(
          `${notificationEventId}:${channelId}`,
          notificationEventId,
          channelId,
          projection.template.id,
          render(projection.template.subject, projection.variables),
          render(projection.template.content, projection.variables),
          projection.cooldownMinutes,
          now,
          now,
          now
        )
      );
    }
    await this.env.DB.batch(statements);
    return {
      notificationEventId,
      variables: projection.variables,
      targetId: projection.targetId,
      targetType: projection.type,
      eventKey: projection.eventKey,
    };
  }

  private async deliver(
    message: NotificationMessageRow,
    variables: Record<string, string>,
    targetId: number,
    targetType: "monitor" | "agent",
    eventKey: string
  ) {
    if (["sent", "skipped", "terminated"].includes(message.status)) return;
    if (message.status === "failed") {
      throw new Error(message.message_id + " exhausted provider retries");
    }
    const now = new Date();
    const nowIso = now.toISOString();
    if (message.available_at > nowIso) throw new Error("Notification retry is not due");
    const cooldownKey = `${targetType}:${targetId}:${message.channel_id}:${eventKey}`;
    const cooldown = await this.env.DB.prepare(
      `SELECT last_sent_at FROM notification_cooldowns WHERE cooldown_key = ? LIMIT 1`
    )
      .bind(cooldownKey)
      .first<{ last_sent_at: string }>();
    const cooldownUntil = cooldown
      ? Date.parse(cooldown.last_sent_at) + message.cooldown_minutes * 60_000
      : 0;
    if (cooldown && Number.isFinite(cooldownUntil) && cooldownUntil > now.getTime()) {
      await this.env.DB.prepare(
        `UPDATE notification_messages SET status = 'skipped', updated_at = ?
         WHERE message_id = ? AND status IN ('pending', 'retry')`
      )
        .bind(nowIso, message.message_id)
        .run();
      return;
    }

    const leaseToken = crypto.randomUUID();
    const claimed = await this.env.DB.prepare(
      `UPDATE notification_messages SET status = 'sending', attempts = attempts + 1,
       lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE message_id = ? AND attempts < max_attempts AND (
         status IN ('pending', 'retry') OR (status = 'sending' AND lease_expires_at <= ?)
       ) RETURNING attempts, max_attempts`
    )
      .bind(
        leaseToken,
        new Date(now.getTime() + 60_000).toISOString(),
        nowIso,
        message.message_id,
        nowIso
      )
      .first<{ attempts: number; max_attempts: number }>();
    if (!claimed) return;

    const started = Date.now();
    let result: { success: boolean; error?: string };
    try {
      result = await this.sender(
        message.channel_id,
        message.subject,
        message.content,
        this.env
      );
    } catch (error) {
      result = { success: false, error: safeError(error) };
    }
    const completedAt = new Date().toISOString();
    const attemptId = `${message.message_id}:${claimed.attempts}`;
    if (result.success) {
      const statements = [
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO notification_attempts
           (attempt_id, message_id, attempt_number, started_at, completed_at,
            duration_ms, success, error_category, error, retryable, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL, 0, ?, ?)`
        ).bind(
          attemptId,
          message.message_id,
          claimed.attempts,
          nowIso,
          completedAt,
          Math.max(0, Date.now() - started),
          completedAt,
          completedAt
        ),
        this.env.DB.prepare(
          `UPDATE notification_messages SET status = 'sent', sent_at = ?,
           lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
           WHERE message_id = ? AND lease_token = ?`
        ).bind(completedAt, completedAt, message.message_id, leaseToken),
        this.env.DB.prepare(
          `INSERT INTO notification_cooldowns
           (cooldown_key, type, target_id, channel_id, event_key, last_sent_at,
            created_at, updated_at)
           SELECT ?, e.type, e.target_id, ?, e.event_key, ?, ?, ?
           FROM notification_events e WHERE e.event_id = ?
           ON CONFLICT(cooldown_key) DO UPDATE SET
             last_sent_at = excluded.last_sent_at, updated_at = excluded.updated_at`
        ).bind(
          cooldownKey,
          message.channel_id,
          completedAt,
          completedAt,
          completedAt,
          message.event_id
        ),
      ];
      await this.env.DB.batch(statements);
      return;
    }

    const exhausted = claimed.attempts >= claimed.max_attempts;
    const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(claimed.attempts - 1, 7));
    const failureStatements = [
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO notification_attempts
         (attempt_id, message_id, attempt_number, started_at, completed_at,
          duration_ms, success, error_category, error, retryable, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'provider', ?, ?, ?, ?)`
      ).bind(
        attemptId,
        message.message_id,
        claimed.attempts,
        nowIso,
        completedAt,
        Math.max(0, Date.now() - started),
        result.error ?? "Provider rejected notification",
        exhausted ? 0 : 1,
        completedAt,
        completedAt
      ),
      this.env.DB.prepare(
        `UPDATE notification_messages SET status = ?, available_at = ?,
         lease_token = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
         WHERE message_id = ? AND lease_token = ?`
      ).bind(
        exhausted ? "failed" : "retry",
        new Date(Date.now() + delaySeconds * 1000).toISOString(),
        result.error ?? "Provider rejected notification",
        completedAt,
        message.message_id,
        leaseToken
      ),
    ];
    await this.env.DB.batch(failureStatements);
    throw new Error(result.error ?? "Notification delivery failed");
  }

  async process(event: StoredOutboxEvent) {
    const projection = await this.project(event);
    if (!projection) return;
    const rows = await this.env.DB.prepare(
      `SELECT message_id, event_id, channel_id, template_id, subject, content,
       cooldown_minutes, status, attempts, max_attempts, available_at
         FROM notification_messages WHERE event_id = ?
         ORDER BY channel_id LIMIT 100`
    )
      .bind(projection.notificationEventId)
      .all<NotificationMessageRow>();
    for (const message of rows.results) {
      await this.deliver(
        message,
        projection.variables,
        projection.targetId,
        projection.targetType,
        projection.eventKey
      );
    }
    const incomplete = await this.env.DB.prepare(
      `SELECT count(*) AS count FROM notification_messages
       WHERE event_id = ? AND status IN ('pending', 'retry', 'sending')`
    )
      .bind(projection.notificationEventId)
      .first<{ count: number }>();
    if (Number(incomplete?.count ?? 0) > 0) {
      throw new Error("Notification event still has pending messages");
    }
    const now = new Date().toISOString();
    await this.env.DB.prepare(
      `UPDATE notification_events SET status = 'completed', completed_at = ?, updated_at = ?
       WHERE event_id = ?`
    )
      .bind(now, now, projection.notificationEventId)
      .run();
  }
}
