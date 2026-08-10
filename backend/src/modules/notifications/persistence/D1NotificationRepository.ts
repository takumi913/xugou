const isContractMode = (env: any) => true;
const hasTableColumn = (env: any, table: string, column: string) => true;
import type { Bindings } from "../../../models/db";
import { sendNotificationByChannel } from "../providers/NotificationProviders";
import type { NotificationRepositoryPort } from "../application/NotificationUseCases";
import type {
  NotificationChannelCommand,
  NotificationChannelMutation,
  NotificationSettingCommand,
  NotificationTemplateCommand,
  NotificationResourceSettingView,
  NotificationResourceTarget,
} from "../domain/models";
import type { OrderedCursor } from "../../../shared/pagination/OrderedCursor";
import {
  D1NotificationChannelStore,
  type ChannelRow,
} from "./D1NotificationChannelStore";


type SettingRow = {
  id: number;
  target_type: string;
  target_id: number | null;
  enabled: number;
  on_down: number;
  on_recovery: number;
  on_offline: number;
  on_cpu_threshold: number;
  cpu_threshold: number;
  on_memory_threshold: number;
  memory_threshold: number;
  on_disk_threshold: number;
  disk_threshold: number;
  cooldown_minutes: number;
  channels: string | null;
};

type ResourceSettingRow = SettingRow & {
  resource_id: number;
  resource_name: string;
  resource_description: string | null;
  resource_sort_order: number;
  rule_id: number | null;
};

type TemplateRow = {
  id: number;
  name: string;
  type: string;
  subject: string;
  content: string;
  is_default: number;
  created_at: string;
  updated_at: string;
};

const MAX_NOTIFICATION_DICTIONARY_ITEMS = 100;

function channelIds(value: string | null) {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0)
      : [];
  } catch {
    return [];
  }
}

function channelView(channel: Awaited<ReturnType<D1NotificationChannelStore["maskedChannel"]>>) {
  return { ...channel, enabled: Boolean(channel.enabled) };
}

function templateView(row: TemplateRow) {
  return { ...row, is_default: Number(row?.is_default) === 1 };
}

function monitorSetting(row?: SettingRow) {
  return {
    enabled: row?.enabled === 1,
    onDown: row?.on_down === 1,
    onRecovery: row?.on_recovery === 1,
    cooldownMinutes: row?.cooldown_minutes ?? 30,
    channels: channelIds(row?.channels ?? null),
  };
}

function agentSetting(row?: SettingRow) {
  return {
    enabled: row?.enabled === 1,
    onOffline: row?.on_offline === 1,
    onRecovery: row?.on_recovery === 1,
    onCpuThreshold: row?.on_cpu_threshold === 1,
    cpuThreshold: row?.cpu_threshold ?? 90,
    onMemoryThreshold: row?.on_memory_threshold === 1,
    memoryThreshold: row?.memory_threshold ?? 85,
    onDiskThreshold: row?.on_disk_threshold === 1,
    diskThreshold: row?.disk_threshold ?? 90,
    cooldownMinutes: row?.cooldown_minutes ?? 30,
    channels: channelIds(row?.channels ?? null),
  };
}

export class D1NotificationRepository implements NotificationRepositoryPort {
  private readonly channelStore: D1NotificationChannelStore;

  constructor(private readonly env: Bindings) {
    this.channelStore = new D1NotificationChannelStore(env);
  }

  async getConfig() {
    const [channels, templates, settingsResult, channelCount, templateCount] = await Promise.all([
      this.listChannels(),
      this.listTemplates(),
      this.env.DB.prepare(
        `SELECT rule.id, rule.target_type, rule.target_id, rule.enabled,
                rule.on_down, rule.on_recovery, rule.on_offline,
                rule.on_cpu_threshold, rule.cpu_threshold,
                rule.on_memory_threshold, rule.memory_threshold,
                rule.on_disk_threshold, rule.disk_threshold,
                rule.cooldown_minutes,
                COALESCE((
                  SELECT json_group_array(channel_id) FROM (
                    SELECT endpoint.channel_id
                    FROM notification_rule_endpoints endpoint
                    WHERE endpoint.rule_id = rule.id
                    ORDER BY endpoint.sort_order, endpoint.channel_id
                  )
                ), '[]') AS channels
         FROM notification_rules rule
         WHERE rule.target_type IN ('global-monitor', 'global-agent')
         ORDER BY rule.id ASC LIMIT 4`
      ).all<SettingRow>(),
      this.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM notification_channels
         WHERE deleted_at IS NULL`
      ).first<{ count: number }>(),
      this.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM notification_templates
         WHERE deleted_at IS NULL`
      ).first<{ count: number }>(),
    ]);
    const settings = settingsResult.results;
    const globalMonitor = settings.find((row) => row?.target_type === "global-monitor");
    const globalAgent = settings.find((row) => row?.target_type === "global-agent");
    const specificMonitors: Record<string, ReturnType<typeof monitorSetting>> = {};
    const specificAgents: Record<string, ReturnType<typeof agentSetting>> = {};
    for (const setting of settings) {
      if (setting.target_id === null) continue;
      if (setting.target_type === "monitor") {
        specificMonitors[String(setting.target_id)] = monitorSetting(setting);
      }
      if (setting.target_type === "agent") {
        specificAgents[String(setting.target_id)] = agentSetting(setting);
      }
    }
    return {
      channels,
      templates,
      channels_has_more:
        Number(channelCount?.count ?? 0) > MAX_NOTIFICATION_DICTIONARY_ITEMS,
      templates_has_more:
        Number(templateCount?.count ?? 0) > MAX_NOTIFICATION_DICTIONARY_ITEMS,
      settings: {
        monitors: monitorSetting(globalMonitor),
        agents: agentSetting(globalAgent),
        specificMonitors,
        specificAgents,
      },
    };
  }

  async listChannels() {
    const rows = await this.channelStore.listMasked(
      MAX_NOTIFICATION_DICTIONARY_ITEMS
    );
    return rows.map(channelView);
  }

  async listResourceSettings(input: {
    targetType: NotificationResourceTarget;
    after?: OrderedCursor;
    limit: number;
  }): Promise<NotificationResourceSettingView[]> {
    const resourceSource =
      input.targetType === "monitor"
        ? `SELECT id, name, url AS description, sort_order
           FROM monitor_definitions
           WHERE deleted_at_ms IS NULL
             AND (sort_order > ? OR (sort_order = ? AND id > ?))
           ORDER BY sort_order ASC, id ASC LIMIT ?`
        : `SELECT node.id, node.name, runtime.hostname AS description,
                  node.sort_order
           FROM agent_nodes node
           JOIN agent_runtime runtime ON runtime.agent_id = node.id
           WHERE node.deleted_at_ms IS NULL
             AND (node.sort_order > ? OR
                  (node.sort_order = ? AND node.id > ?))
           ORDER BY node.sort_order ASC, node.id ASC LIMIT ?`;
    const channelsProjection = `COALESCE((
           SELECT json_group_array(channel_id) FROM (
             SELECT endpoint.channel_id
             FROM notification_rule_endpoints endpoint
             WHERE endpoint.rule_id = rule.id
             ORDER BY endpoint.sort_order, endpoint.channel_id
           )
         ), '[]')`;
    const ruleTable = "notification_rules";
    const afterSortOrder = input.after?.sortOrder ?? Number.MIN_SAFE_INTEGER;
    const afterId = input.after?.id ?? 0;
    const rows = await this.env.DB.prepare(
      `WITH resource AS (${resourceSource})
       SELECT resource.id AS resource_id, resource.name AS resource_name,
              resource.description AS resource_description,
              resource.sort_order AS resource_sort_order,
              rule.id AS rule_id, rule.id, rule.target_type, rule.target_id,
              rule.enabled, rule.on_down, rule.on_recovery, rule.on_offline,
              rule.on_cpu_threshold, rule.cpu_threshold,
              rule.on_memory_threshold, rule.memory_threshold,
              rule.on_disk_threshold, rule.disk_threshold,
              rule.cooldown_minutes, ${channelsProjection} AS channels
       FROM resource
       LEFT JOIN ${ruleTable} rule ON rule.id = (
         SELECT candidate.id FROM ${ruleTable} candidate
         WHERE candidate.target_type = ? AND candidate.target_id = resource.id
         ORDER BY candidate.id ASC LIMIT 1
       )
       ORDER BY resource.sort_order ASC, resource.id ASC`
    )
      .bind(
        afterSortOrder,
        afterSortOrder,
        afterId,
        input.limit,
        input.targetType
      )
      .all<ResourceSettingRow>();
    return rows.results.map((row) => ({
      target_type: input.targetType,
      id: row?.resource_id,
      name: row?.resource_name,
      description: row?.resource_description,
      sort_order: row?.resource_sort_order,
      setting:
        row?.rule_id === null
          ? null
          : input.targetType === "monitor"
            ? monitorSetting(row)
            : agentSetting(row),
    }));
  }

  async getChannel(id: number) {
    const row = await this.channelStore.findRow(id);
    return row ? channelView(await this.channelStore.maskedChannel(row)) : null;
  }

  async prepareChannelConfig(id: number, type: string, config: unknown) {
    const row = await this.channelStore.findRow(id);
    return row ? this.channelStore.mergeConfigUpdate(row, type, config) : null;
  }

  async createChannel(input: NotificationChannelCommand) {
    let id: number | undefined;
    try {
      const publicConfig = JSON.stringify({});
      const now = new Date().toISOString();
      const row = await this.env.DB.prepare(
        `INSERT INTO notification_channels
         (name, type, config, enabled, created_at, updated_at)
         SELECT ?, ?, '{}', ?, ?, ?
         WHERE (SELECT COUNT(*) FROM notification_channels
                WHERE deleted_at IS NULL) < ${MAX_NOTIFICATION_DICTIONARY_ITEMS}
         RETURNING id`
      )
        .bind(
          input.name,
          input.type,
          input.enabled ? 1 : 0,
          now,
          now
        )
        .first<{ id: number }>();
      id = row?.id;
      if (id === undefined) {
        throw new Error(`通知渠道已达到 ${MAX_NOTIFICATION_DICTIONARY_ITEMS} 条上限`);
      }
      await this.channelStore.persistSecureConfig(id, input.type, input.config);
      return { success: true, id };
    } catch (error) {
      if (id !== undefined) {
        await this.env.DB.prepare(`DELETE FROM notification_channels WHERE id = ?`)
          .bind(id)
          .run();
      }
      return {
        success: false,
        message: error instanceof Error ? error.message : "创建通知渠道失败",
      };
    }
  }

  async updateChannel(id: number, input: NotificationChannelMutation) {
    try {
      const existing = await this.channelStore.findRow(id);
      if (!existing) return { success: false, message: "通知渠道不存在" };
      const nextType = input.type ?? existing?.type;
      if (input.config !== undefined) {
        await this.channelStore.persistSecureConfig(id, nextType, input.config);
      }
      const now = new Date().toISOString();
      await this.env.DB.prepare(
        `UPDATE notification_channels SET name = ?, type = ?, enabled = ?, updated_at = ?
         WHERE id = ?`
      )
        .bind(
          input.name ?? existing?.name,
          nextType,
          input.enabled === undefined ? existing?.enabled : input.enabled ? 1 : 0,
          now,
          id
        )
        .run();
      return { success: true, id, message: "通知渠道更新成功" };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "更新通知渠道失败",
      };
    }
  }

  async deleteChannel(id: number) {
    const existing = await this.channelStore.findRow(id);
    if (!existing) return { success: false, message: "通知渠道不存在" };
    try {
      const now = new Date().toISOString();
      await this.env.DB.batch([
        this.env.DB.prepare(
          `DELETE FROM notification_rule_endpoints WHERE channel_id = ?`
        ).bind(id),
        this.env.DB.prepare(
          `DELETE FROM notification_secrets WHERE channel_id = ?`
        ).bind(id),
        this.env.DB.prepare(
          `DELETE FROM notification_endpoints WHERE channel_id = ?`
        ).bind(id),
        this.env.DB.prepare(
          `UPDATE notification_channels
           SET enabled = 0, deleted_at = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`
        ).bind(now, now, id),
      ]);
      return { success: true, message: "通知渠道删除成功" };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "删除通知渠道失败",
      };
    }
  }

  async testChannel(id: number) {
    const channel = await this.channelStore.deliveryChannel(id);
    if (!channel) return { success: false, error: "通知渠道不存在" };
    const subject = "【测试】XUGOU 通知测试";
    const content = `这是一条测试通知，用于验证渠道 ${channel.name} (${channel.type}) 的配置。\n\n发送时间: ${new Date().toISOString()}`;
    return sendNotificationByChannel(channel, subject, content);
  }

  async listTemplates() {
    const rows = await this.env.DB.prepare(
      `SELECT definition.id, definition.name, definition.type,
              version.subject, version.content, definition.is_default,
              strftime('%Y-%m-%dT%H:%M:%fZ',
                       definition.created_at_ms / 1000.0, 'unixepoch') AS created_at,
              strftime('%Y-%m-%dT%H:%M:%fZ',
                       definition.updated_at_ms / 1000.0, 'unixepoch') AS updated_at
       FROM notification_template_definitions definition
       JOIN notification_template_versions version
         ON version.template_id = definition.id
        AND version.version = definition.current_version
       WHERE definition.deleted_at_ms IS NULL
       ORDER BY definition.is_default DESC, definition.id ASC LIMIT ?`
    )
      .bind(MAX_NOTIFICATION_DICTIONARY_ITEMS)
      .all<TemplateRow>();
    return rows.results.map(templateView);
  }

  async getTemplate(id: number) {
    const row = await this.env.DB.prepare(
      `SELECT definition.id, definition.name, definition.type,
              version.subject, version.content, definition.is_default,
              strftime('%Y-%m-%dT%H:%M:%fZ',
                       definition.created_at_ms / 1000.0, 'unixepoch') AS created_at,
              strftime('%Y-%m-%dT%H:%M:%fZ',
                       definition.updated_at_ms / 1000.0, 'unixepoch') AS updated_at
       FROM notification_template_definitions definition
       JOIN notification_template_versions version
         ON version.template_id = definition.id
        AND version.version = definition.current_version
       WHERE definition.id = ? AND definition.deleted_at_ms IS NULL LIMIT 1`
    )
      .bind(id)
      .first<TemplateRow>();
    return row ? templateView(row) : null;
  }

  async createTemplate(input: NotificationTemplateCommand) {
    let createdId: number | undefined;
    try {
      const nowMs = Date.now();
      const row = await this.env.DB.prepare(
        `INSERT INTO notification_template_definitions
         (name, type, current_version, is_default, deleted_at_ms,
          created_at_ms, updated_at_ms)
         SELECT ?, ?, 1, ?, NULL, ?, ?
         WHERE (SELECT COUNT(*) FROM notification_template_definitions
                WHERE deleted_at_ms IS NULL) < ${MAX_NOTIFICATION_DICTIONARY_ITEMS}
         RETURNING id`
      ).bind(
        input.name,
        input.type,
        input.is_default ? 1 : 0,
        nowMs,
        nowMs
      ).first<{ id: number }>();
      createdId = row?.id;
      if (row) {
        await this.env.DB.prepare(
          `INSERT INTO notification_template_versions
           (template_id, version, subject, content, created_at_ms)
           VALUES (?, 1, ?, ?, ?)`
        ).bind(row?.id, input.subject, input.content, nowMs).run();
      }
      return row
        ? { success: true, id: row?.id }
        : {
            success: false,
            message: `通知模板已达到 ${MAX_NOTIFICATION_DICTIONARY_ITEMS} 条上限`,
          };
    } catch (error) {
      if (createdId !== undefined) {
        await this.env.DB.prepare(
          `DELETE FROM notification_template_definitions WHERE id = ?`
        )
          .bind(createdId)
          .run();
      }
      return { success: false, message: error instanceof Error ? error.message : "创建通知模板失败" };
    }
  }

  async updateTemplate(id: number, input: Partial<NotificationTemplateCommand>) {
    const current = await this.getTemplate(id);
    if (!current) return { success: false, message: "通知模板不存在" };
    try {
      const nowMs = Date.now();
      const nextSubject = input.subject ?? current.subject;
      const nextContent = input.content ?? current.content;
      const contentChanged =
        nextSubject !== current.subject || nextContent !== current.content;
      const definition = await this.env.DB.prepare(
        `SELECT current_version FROM notification_template_definitions
         WHERE id = ? AND deleted_at_ms IS NULL LIMIT 1`
      )
        .bind(id)
        .first<{ current_version: number }>();
      if (!definition) {
        return { success: false, message: "通知模板不存在" };
      }
      const nextVersion = definition.current_version + (contentChanged ? 1 : 0);
      const statements = [
        this.env.DB.prepare(
          `UPDATE notification_template_definitions
           SET name = ?, type = ?, current_version = ?, is_default = ?,
               updated_at_ms = ?
           WHERE id = ? AND deleted_at_ms IS NULL`
        ).bind(
          input.name ?? current.name,
          input.type ?? current.type,
          nextVersion,
          input.is_default === undefined
            ? current.is_default
              ? 1
              : 0
            : input.is_default
              ? 1
              : 0,
          nowMs,
          id
        ),
      ];
      if (contentChanged) {
        statements.unshift(
          this.env.DB.prepare(
            `INSERT INTO notification_template_versions
             (template_id, version, subject, content, created_at_ms)
             VALUES (?, ?, ?, ?, ?)`
          ).bind(id, nextVersion, nextSubject, nextContent, nowMs)
        );
      }
      await this.env.DB.batch(statements);
      return { success: true, id };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "更新通知模板失败" };
    }
  }

  async deleteTemplate(id: number) {
    const current = await this.getTemplate(id);
    if (!current) return { success: false, message: "通知模板不存在" };
    try {
      const now = new Date().toISOString();
      await this.env.DB.prepare(
        `UPDATE notification_template_definitions
         SET is_default = 0, deleted_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND deleted_at_ms IS NULL`
      )
        .bind(Date.parse(now), Date.parse(now), id)
        .run();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "删除通知模板失败",
      };
    }
  }

  async saveSetting(input: NotificationSettingCommand) {
    const ids = channelIds(input.channels);
    const channelCount = ids.length
      ? await this.env.DB.prepare(
          `SELECT COUNT(*) AS count FROM notification_channels
           WHERE deleted_at IS NULL
             AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`
        )
          .bind(JSON.stringify(ids))
          .first<{ count: number }>()
      : { count: 0 };
    if (Number(channelCount?.count ?? 0) !== ids.length) {
      return { success: false, message: "通知设置包含不存在的渠道" };
    }
    const global = input.target_type.startsWith("global-");
    if (!global) {
      const table = input.target_type === "monitor"
        ? "monitor_definitions"
        : "agent_nodes";
      const extra = "AND deleted_at_ms IS NULL";
      const target = await this.env.DB.prepare(
        `SELECT id FROM ${table} WHERE id = ? ${extra} LIMIT 1`
      )
        .bind(input.target_id)
        .first<{ id: number }>();
      if (!target) return { success: false, message: "通知目标不存在" };
    }
    const targetId = global ? null : input.target_id;
    if (true) {
      const nowMs = Date.now();
      const existingRule = await this.env.DB.prepare(
        `SELECT id FROM notification_rules
         WHERE target_type = ?
           AND ((target_id IS NULL AND ? IS NULL) OR target_id = ?)
         ORDER BY id ASC LIMIT 1`
      )
        .bind(input.target_type, targetId, targetId)
        .first<{ id: number }>();
      let ruleId = existingRule?.id;
      if (ruleId === undefined) {
        const inserted = await this.env.DB.prepare(
          `INSERT INTO notification_rules
           (target_type, target_id, enabled, on_down, on_recovery, on_offline,
            on_cpu_threshold, cpu_threshold, on_memory_threshold,
            memory_threshold, on_disk_threshold, disk_threshold,
            cooldown_minutes, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
        )
          .bind(
            input.target_type,
            targetId,
            input.enabled ? 1 : 0,
            input.on_down ? 1 : 0,
            input.on_recovery ? 1 : 0,
            input.on_offline ? 1 : 0,
            input.on_cpu_threshold ? 1 : 0,
            input.cpu_threshold,
            input.on_memory_threshold ? 1 : 0,
            input.memory_threshold,
            input.on_disk_threshold ? 1 : 0,
            input.disk_threshold,
            input.cooldown_minutes,
            nowMs,
            nowMs
          )
          .first<{ id: number }>();
        ruleId = inserted?.id;
      } else {
        await this.env.DB.prepare(
          `UPDATE notification_rules
           SET enabled = ?, on_down = ?, on_recovery = ?, on_offline = ?,
               on_cpu_threshold = ?, cpu_threshold = ?,
               on_memory_threshold = ?, memory_threshold = ?,
               on_disk_threshold = ?, disk_threshold = ?,
               cooldown_minutes = ?, updated_at_ms = ?
           WHERE id = ?`
        )
          .bind(
            input.enabled ? 1 : 0,
            input.on_down ? 1 : 0,
            input.on_recovery ? 1 : 0,
            input.on_offline ? 1 : 0,
            input.on_cpu_threshold ? 1 : 0,
            input.cpu_threshold,
            input.on_memory_threshold ? 1 : 0,
            input.memory_threshold,
            input.on_disk_threshold ? 1 : 0,
            input.disk_threshold,
            input.cooldown_minutes,
            nowMs,
            ruleId
          )
          .run();
      }
      if (ruleId === undefined) {
        return { success: false, message: "通知设置写入后未返回 ID" };
      }
      await this.env.DB.batch([
        this.env.DB.prepare(
          `DELETE FROM notification_rule_endpoints WHERE rule_id = ?`
        ).bind(ruleId),
        ...ids.map((channelId, sortOrder) =>
          this.env.DB.prepare(
            `INSERT INTO notification_rule_endpoints
             (rule_id, channel_id, sort_order, created_at_ms)
             VALUES (?, ?, ?, ?)`
          ).bind(ruleId, channelId, sortOrder, nowMs)
        ),
      ]);
      return { success: true, id: ruleId };
    }
    const existing = await this.env.DB.prepare(
      `SELECT id FROM notification_settings
       WHERE target_type = ? AND ((target_id IS NULL AND ? IS NULL) OR target_id = ?)
       ORDER BY id ASC LIMIT 1`
    )
      .bind(input.target_type, targetId, targetId)
      .first<{ id: number }>();
    const now = new Date().toISOString();
    const values = [
      input.enabled ? 1 : 0,
      input.on_down ? 1 : 0,
      input.on_recovery ? 1 : 0,
      input.on_offline ? 1 : 0,
      input.on_cpu_threshold ? 1 : 0,
      input.cpu_threshold,
      input.on_memory_threshold ? 1 : 0,
      input.memory_threshold,
      input.on_disk_threshold ? 1 : 0,
      input.disk_threshold,
      input.cooldown_minutes,
      JSON.stringify(ids),
    ] as const;
    if (existing) {
      await this.env.DB.prepare(
        `UPDATE notification_settings SET enabled = ?, on_down = ?, on_recovery = ?,
         on_offline = ?, on_cpu_threshold = ?, cpu_threshold = ?,
         on_memory_threshold = ?, memory_threshold = ?, on_disk_threshold = ?,
         disk_threshold = ?, cooldown_minutes = ?, channels = ?, updated_at = ?
         WHERE id = ?`
      )
        .bind(...values, now, existing?.id)
        .run();
      null;
      return { success: true, id: existing?.id };
    }
    const row = await this.env.DB.prepare(
      `INSERT INTO notification_settings
       (target_type, target_id, enabled, on_down, on_recovery, on_offline,
        on_cpu_threshold, cpu_threshold, on_memory_threshold, memory_threshold,
        on_disk_threshold, disk_threshold, cooldown_minutes, channels, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
      .bind(input.target_type, targetId, ...values, now, now)
      .first<{ id: number }>();
    if (row) null;
    return row
      ? { success: true, id: row?.id }
      : { success: false, message: "通知设置写入后未返回 ID" };
  }

  async saveSettingsBulk(
    inputs: NotificationSettingCommand[],
    idempotencyKey: string,
    requestHash: string
  ) {
    const existingCommand = await this.env.DB.prepare(
      `SELECT request_hash, status, response_json
       FROM notification_setting_commands WHERE idempotency_key = ? LIMIT 1`
    )
      .bind(idempotencyKey)
      .first<{ request_hash: string; status: string; response_json: string | null }>();
    if (existingCommand && existingCommand.request_hash !== requestHash) {
      return { success: false, message: "幂等键已绑定到其他通知设置请求" };
    }
    if (existingCommand?.status === "completed" && existingCommand.response_json) {
      const replay = JSON.parse(existingCommand.response_json) as { ids: number[] };
      return { success: true, ids: replay.ids, replayed: true };
    }

    const requestedChannelIds = [
      ...new Set(inputs.flatMap((input) => channelIds(input.channels))),
    ];
    const foundChannels = requestedChannelIds.length
      ? await this.env.DB.prepare(
          `SELECT id FROM notification_channels
           WHERE deleted_at IS NULL
             AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`
        )
          .bind(JSON.stringify(requestedChannelIds))
          .all<{ id: number }>()
      : { results: [] };
    const foundChannelIds = new Set(foundChannels.results.map((row) => row?.id));
    const errors: Record<string, string[]> = {};
    inputs.forEach((input, index) => {
      const missingIds = channelIds(input.channels).filter(
        (channelId) => !foundChannelIds.has(channelId)
      );
      if (missingIds.length > 0) {
        errors[`settings.${index}.channels`] = missingIds.map(
          (channelId) => `notification channel ${channelId} does not exist`
        );
      }
    });

    for (const targetType of ["monitor", "agent"] as const) {
      const ids = [
        ...new Set(
          inputs
            .filter((input) => input.target_type === targetType)
            .map((input) => input.target_id)
        ),
      ];
      if (ids.length === 0) continue;
      const table = targetType === "monitor"
        ? "monitor_definitions"
        : "agent_nodes";
      const deletionFilter = "AND deleted_at_ms IS NULL";
      const found = await this.env.DB.prepare(
        `SELECT id FROM ${table}
         WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
         ${deletionFilter}`
      )
        .bind(JSON.stringify(ids))
        .all<{ id: number }>();
      const foundIds = new Set(found.results.map((row) => row?.id));
      inputs.forEach((input, index) => {
        if (input.target_type !== targetType || foundIds.has(input.target_id)) {
          return;
        }
        errors[`settings.${index}.target_id`] = [
          `${targetType} target ${input.target_id} does not exist`,
        ];
      });
    }
    if (Object.keys(errors).length > 0) {
      return {
        success: false,
        message: "Notification settings contain invalid items",
        errors,
      };
    }

    const targetKeys = inputs.map((input) => ({
      target_type: input.target_type,
      target_id: input.target_type.startsWith("global-") ? null : input.target_id,
    }));
    const ruleTable = "notification_rules";
    const existingRules = await this.env.DB.prepare(
      `WITH requested AS (SELECT value FROM json_each(?))
       SELECT rule.id, rule.target_type, rule.target_id
       FROM ${ruleTable} rule
       WHERE EXISTS (
         SELECT 1 FROM requested
         WHERE json_extract(value, '$.target_type') = rule.target_type
           AND ((json_extract(value, '$.target_id') IS NULL AND rule.target_id IS NULL)
                OR CAST(json_extract(value, '$.target_id') AS INTEGER) = rule.target_id)
       )`
    )
      .bind(JSON.stringify(targetKeys))
      .all<{ id: number; target_type: string; target_id: number | null }>();
    const existingByTarget = new Map(
      existingRules.results.map((row) => [
        `${row?.target_type}:${row?.target_id ?? 0}`,
        row?.id,
      ])
    );
    const maximum = await this.env.DB.prepare(
      `SELECT MAX(id) AS id FROM (
         SELECT id FROM notification_rules
         UNION ALL SELECT id FROM notification_settings
       )`
    ).first<{ id: number | null }>();
    let nextId = Number(maximum?.id ?? 0) + 1;
    const payload = inputs.map((input) => {
      const targetId = input.target_type.startsWith("global-")
        ? null
        : input.target_id;
      const key = `${input.target_type}:${targetId ?? 0}`;
      return {
        id: existingByTarget.get(key) ?? nextId++,
        target_type: input.target_type,
        target_id: targetId,
        enabled: input.enabled ? 1 : 0,
        on_down: input.on_down ? 1 : 0,
        on_recovery: input.on_recovery ? 1 : 0,
        on_offline: input.on_offline ? 1 : 0,
        on_cpu_threshold: input.on_cpu_threshold ? 1 : 0,
        cpu_threshold: input.cpu_threshold,
        on_memory_threshold: input.on_memory_threshold ? 1 : 0,
        memory_threshold: input.memory_threshold,
        on_disk_threshold: input.on_disk_threshold ? 1 : 0,
        disk_threshold: input.disk_threshold,
        cooldown_minutes: input.cooldown_minutes,
        channels: channelIds(input.channels),
      };
    });
    const payloadJson = JSON.stringify(payload);
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const ids = payload.map((item) => item.id);
    const responseJson = JSON.stringify({ ids });

    await this.env.DB.prepare(
      `INSERT INTO notification_setting_commands
       (idempotency_key, request_hash, status, response_json, last_error, created_at, updated_at)
       VALUES (?, ?, 'processing', NULL, NULL, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         status = 'processing', last_error = NULL, updated_at = excluded.updated_at
       WHERE notification_setting_commands.request_hash = excluded.request_hash`
    )
      .bind(idempotencyKey, requestHash, now, now)
      .run();

    // D1 的 ON CONFLICT 条件更新在“同键、不同摘要”的并发请求下会静默跳过。
    // 重新读取所有权，确保只有真正绑定该摘要的命令进入业务写批次。
    const reservedCommand = await this.env.DB.prepare(
      `SELECT request_hash, status, response_json
       FROM notification_setting_commands WHERE idempotency_key = ? LIMIT 1`
    )
      .bind(idempotencyKey)
      .first<{ request_hash: string; status: string; response_json: string | null }>();
    if (!reservedCommand || reservedCommand.request_hash !== requestHash) {
      return { success: false, message: "幂等键已绑定到其他通知设置请求" };
    }
    if (reservedCommand.status === "completed" && reservedCommand.response_json) {
      const replay = JSON.parse(reservedCommand.response_json) as { ids: number[] };
      return { success: true, ids: replay.ids, replayed: true };
    }

    const canonicalUpsert = this.env.DB.prepare(
      `INSERT INTO notification_rules
       (id, target_type, target_id, enabled, on_down, on_recovery, on_offline,
        on_cpu_threshold, cpu_threshold, on_memory_threshold, memory_threshold,
        on_disk_threshold, disk_threshold, cooldown_minutes, created_at_ms, updated_at_ms)
       SELECT CAST(json_extract(value, '$.id') AS INTEGER),
              json_extract(value, '$.target_type'), json_extract(value, '$.target_id'),
              json_extract(value, '$.enabled'), json_extract(value, '$.on_down'),
              json_extract(value, '$.on_recovery'), json_extract(value, '$.on_offline'),
              json_extract(value, '$.on_cpu_threshold'), json_extract(value, '$.cpu_threshold'),
              json_extract(value, '$.on_memory_threshold'), json_extract(value, '$.memory_threshold'),
              json_extract(value, '$.on_disk_threshold'), json_extract(value, '$.disk_threshold'),
              json_extract(value, '$.cooldown_minutes'), ?, ?
       FROM json_each(?) WHERE true
       ON CONFLICT(id) DO UPDATE SET
         target_type=excluded.target_type, target_id=excluded.target_id,
         enabled=excluded.enabled, on_down=excluded.on_down,
         on_recovery=excluded.on_recovery, on_offline=excluded.on_offline,
         on_cpu_threshold=excluded.on_cpu_threshold, cpu_threshold=excluded.cpu_threshold,
         on_memory_threshold=excluded.on_memory_threshold, memory_threshold=excluded.memory_threshold,
         on_disk_threshold=excluded.on_disk_threshold, disk_threshold=excluded.disk_threshold,
         cooldown_minutes=excluded.cooldown_minutes, updated_at_ms=excluded.updated_at_ms`
    ).bind(nowMs, nowMs, payloadJson);
    const statements = [
      canonicalUpsert,
      this.env.DB.prepare(
        `DELETE FROM notification_rule_endpoints
         WHERE rule_id IN (SELECT CAST(json_extract(value, '$.id') AS INTEGER) FROM json_each(?))`
      ).bind(payloadJson),
      this.env.DB.prepare(
        `INSERT INTO notification_rule_endpoints
         (rule_id, channel_id, sort_order, created_at_ms, updated_at_ms)
         SELECT CAST(json_extract(rule.value, '$.id') AS INTEGER),
                CAST(channel.value AS INTEGER), CAST(channel.key AS INTEGER), ?, ?
         FROM json_each(?) rule
         JOIN json_each(json_extract(rule.value, '$.channels')) channel`
      ).bind(nowMs, nowMs, payloadJson),
      this.env.DB.prepare(
        `UPDATE notification_setting_commands
         SET status = 'completed', response_json = ?, last_error = NULL, updated_at = ?
         WHERE idempotency_key = ? AND request_hash = ?`
      ).bind(responseJson, now, idempotencyKey, requestHash)
    ];
    try {
      await this.env.DB.batch(statements);
      return { success: true, ids, replayed: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "批量通知设置写入失败";
      await this.env.DB.prepare(
        `UPDATE notification_setting_commands
         SET status = 'failed', last_error = ?, updated_at = ?
         WHERE idempotency_key = ? AND request_hash = ?`
      )
        .bind(message.slice(0, 500), new Date().toISOString(), idempotencyKey, requestHash)
        .run();
      return { success: false, message };
    }
  }

  async listHistory(input: {
    beforeId?: number;
    type?: string;
    targetId?: number;
    status?: string;
    limit: number;
  }) {
    const conditions: string[] = [];
    const bindings: unknown[] = [];
    if (input.beforeId !== undefined) {
      conditions.push("a.rowid < ?");
      bindings.push(input.beforeId);
    }
    if (input.type) {
      conditions.push("e.type = ?");
      bindings.push(input.type);
    }
    if (input.targetId !== undefined) {
      conditions.push("e.target_id = ?");
      bindings.push(input.targetId);
    }
    if (input.status) {
      conditions.push("CASE WHEN a.success = 1 THEN 'success' ELSE 'failed' END = ?");
      bindings.push(input.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.env.DB.prepare(
      `SELECT a.rowid AS id, e.type, e.target_id, m.channel_id, m.template_id,
              CASE WHEN a.success = 1 THEN 'success' ELSE 'failed' END AS status,
              json_object(
                'subject', m.subject,
                'content', m.content,
                'variables', CASE WHEN json_valid(e.variables_json)
                                  THEN json(e.variables_json) ELSE json('{}') END
              ) AS content,
              a.error, a.completed_at AS sent_at
       FROM notification_attempts a
       JOIN notification_messages m ON m.message_id = a.message_id
       JOIN notification_events e ON e.event_id = m.event_id
       ${where}
       ORDER BY a.rowid DESC LIMIT ?`
    )
      .bind(...bindings, input.limit)
      .all();
    return rows.results.map((row: any) => ({
      ...row,
      content: typeof row?.content === "string" ? JSON.parse(row?.content) : row?.content,
    }));
  }
}

