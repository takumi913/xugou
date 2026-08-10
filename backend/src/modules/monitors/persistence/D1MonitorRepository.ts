import type { Bindings } from "../../../models/db";
import {
  canonicalMigrationJson,
  migrationSha256Hex,
} from "../../../platform/migrations/MigrationEncoding";
import { legacyMonitorModelCoverage } from "../../../platform/migrations/LegacyMonitorModelBackfill";
import {
  hasTableColumn,
  isContractMode,
} from "../../../platform/compatibility/CompatibilityMode";
import type { MonitorRepositoryPort } from "../application/MonitorUseCases";
import type { MonitorMutation, MonitorView } from "../domain/models";

type LegacyRow = {
  id: number;
  name: string;
  url: string;
  method: string;
  interval: number;
  timeout_ms: number;
  expected_status: number;
  headers: string;
  body: string | null;
  active: number;
  status: string | null;
  response_time: number | null;
  last_checked: string | null;
  next_check_at: string | null;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
};

type TargetRow = {
  id: number;
  name: string;
  url: string;
  method: string;
  headers_json: string;
  body: string | null;
  interval_ms: number;
  timeout_ms: number;
  expected_status: number;
  active: number;
  sort_order: number;
  created_at_ms: number;
  updated_at_ms: number;
  status: string;
  response_time_ms: number;
  last_checked_at_ms: number | null;
  next_due_at_ms: number | null;
};

function parseHeaders(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
  } catch {
    return {};
  }
}

function iso(value: number | null) {
  return value === null ? null : new Date(value).toISOString();
}

function legacyView(row: LegacyRow): MonitorView {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method,
    interval_seconds: row.interval,
    timeout_ms: row.timeout_ms,
    expected_status: row.expected_status,
    headers: parseHeaders(row.headers),
    body: row.body,
    active: row.active === 1,
    status: row.status,
    response_time_ms: row.response_time,
    last_checked_at: row.last_checked,
    next_check_at: row.next_check_at,
    sort_order: row.sort_order ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function targetView(row: TargetRow): MonitorView {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method,
    interval_seconds: Math.max(1, Math.floor(row.interval_ms / 1000)),
    timeout_ms: row.timeout_ms,
    expected_status: row.expected_status,
    headers: parseHeaders(row.headers_json),
    body: row.body,
    active: row.active === 1,
    status: row.status,
    response_time_ms: row.response_time_ms,
    last_checked_at: iso(row.last_checked_at_ms),
    next_check_at: iso(row.next_due_at_ms),
    sort_order: row.sort_order,
    created_at: iso(row.created_at_ms)!,
    updated_at: iso(row.updated_at_ms)!,
  };
}

const legacyColumns = `id, name, url, method, interval, timeout_ms,
  expected_status, headers, body, active, status, response_time, last_checked,
  next_check_at, sort_order, created_at, updated_at`;
const targetColumns = `d.id, d.name, d.url, d.method, d.headers_json, d.body,
  d.interval_ms, d.timeout_ms, d.expected_status, d.active, d.sort_order,
  d.created_at_ms, d.updated_at_ms, r.status, r.response_time_ms,
  r.last_checked_at_ms, r.next_due_at_ms`;

async function checksum(value: MonitorView) {
  return migrationSha256Hex(canonicalMigrationJson(value));
}

export class D1MonitorRepository implements MonitorRepositoryPort {
  constructor(private readonly env: Bindings) {}

  private async targetReady() {
    return (
      isContractMode(this.env) ||
      (await legacyMonitorModelCoverage(this.env)).read_ready
    );
  }

  async listPage(input: Parameters<MonitorRepositoryPort["listPage"]>[0]) {
    const afterSortOrder = input.after?.sortOrder ?? Number.MIN_SAFE_INTEGER;
    const afterId = input.after?.id ?? 0;
    if (await this.targetReady()) {
      const rows = await this.env.DB.prepare(
        `SELECT ${targetColumns}
         FROM monitor_definitions d
         JOIN monitor_runtime r ON r.monitor_id = d.id
         WHERE d.deleted_at_ms IS NULL
           AND (d.sort_order > ? OR (d.sort_order = ? AND d.id > ?))
         ORDER BY d.sort_order ASC, d.id ASC LIMIT ?`
      )
        .bind(afterSortOrder, afterSortOrder, afterId, input.limit)
        .all<TargetRow>();
      return rows.results.map(targetView);
    }
    const rows = await this.env.DB.prepare(
      `SELECT ${legacyColumns} FROM monitors
       WHERE deleted_at IS NULL
         AND (sort_order > ? OR (sort_order = ? AND id > ?))
       ORDER BY sort_order ASC, id ASC LIMIT ?`
    )
      .bind(afterSortOrder, afterSortOrder, afterId, input.limit)
      .all<LegacyRow>();
    return rows.results.map(legacyView);
  }

  async findById(id: number) {
    if (await this.targetReady()) {
      const row = await this.env.DB.prepare(
        `SELECT ${targetColumns}
         FROM monitor_definitions d
         JOIN monitor_runtime r ON r.monitor_id = d.id
         WHERE d.id = ? AND d.deleted_at_ms IS NULL LIMIT 1`
      )
        .bind(id)
        .first<TargetRow>();
      return row ? targetView(row) : null;
    }
    const row = await this.env.DB.prepare(
      `SELECT ${legacyColumns} FROM monitors
       WHERE id = ? AND deleted_at IS NULL LIMIT 1`
    )
      .bind(id)
      .first<LegacyRow>();
    return row ? legacyView(row) : null;
  }

  async create(input: MonitorMutation) {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const active = input.active === false ? 0 : 1;
    const headersJson = canonicalMigrationJson(input.headers);
    const contractMode = isContractMode(this.env);
    const legacyColumnsPresent = await hasTableColumn(this.env, "monitors", "url");
    const identityInsert = contractMode
      ? legacyColumnsPresent
        ? this.env.DB.prepare(
            `INSERT INTO monitors
             (name, url, method, interval, timeout, timeout_ms, expected_status,
              headers, body, active, status, response_time, last_checked,
              next_check_at, deleted_at, created_at, updated_at, sort_order)
             VALUES (?, 'https://contract-anchor.invalid/', 'GET', 1, 1, 1000,
              200, '{}', NULL, 0, 'retired', 0, NULL, NULL, NULL, ?, ?, 0)
             RETURNING id`
          ).bind(`contract-anchor:${crypto.randomUUID()}`, now, now)
        : this.env.DB.prepare(
            `INSERT INTO monitors(created_at, updated_at) VALUES (?, ?) RETURNING id`
          ).bind(now, now)
      : this.env.DB.prepare(
          `INSERT INTO monitors
           (name, url, method, interval, timeout, timeout_ms, expected_status,
            headers, body, active, status, response_time, last_checked, next_check_at,
            deleted_at, created_at, updated_at, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, NULL, ?, ?, 0)
           RETURNING id`
        ).bind(
          input.name,
          input.url,
          input.method,
          input.interval_seconds,
          Math.max(1, Math.ceil(input.timeout_ms / 1000)),
          input.timeout_ms,
          input.expected_status,
          headersJson,
          input.body ?? null,
          active,
          active ? now : null,
          now,
          now
        );
    const row = await identityInsert.first<{ id: number }>();
    if (!row) throw new Error("Monitor insert returned no ID");
    const view: MonitorView = {
      id: row.id,
      name: input.name,
      url: input.url,
      method: input.method,
      interval_seconds: input.interval_seconds,
      timeout_ms: input.timeout_ms,
      expected_status: input.expected_status,
      headers: input.headers,
      body: input.body ?? null,
      active: active === 1,
      status: "pending",
      response_time_ms: 0,
      last_checked_at: null,
      next_check_at: active ? now : null,
      sort_order: 0,
      created_at: now,
      updated_at: now,
    };
    try {
      const statements = [
        this.env.DB.prepare(
          `INSERT INTO monitor_definitions
           (id, name, url, method, headers_json, body, interval_ms, timeout_ms,
            expected_status, active, sort_order, created_at_ms, updated_at_ms,
            deleted_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`
        ).bind(
          row.id,
          input.name,
          input.url,
          input.method,
          headersJson,
          input.body ?? null,
          input.interval_seconds * 1000,
          input.timeout_ms,
          input.expected_status,
          active,
          nowMs,
          nowMs
        ),
        this.env.DB.prepare(
          `INSERT INTO monitor_runtime
           (monitor_id, status, response_time_ms, last_checked_at_ms,
            next_due_at_ms, version, created_at_ms, updated_at_ms)
           VALUES (?, 'pending', 0, NULL, ?, 0, ?, ?)`
        ).bind(row.id, active ? nowMs : null, nowMs, nowMs),
      ];
      if (!contractMode) {
        statements.push(this.env.DB.prepare(
          `INSERT INTO legacy_id_map
           (source_table, source_id, target_table, target_id, payload_checksum,
            created_at, updated_at)
           VALUES ('monitors', ?, 'monitor_definitions', ?, ?, ?, ?)
           ON CONFLICT(source_table, source_id) DO UPDATE SET
             target_table = excluded.target_table, target_id = excluded.target_id,
             payload_checksum = excluded.payload_checksum,
             updated_at = excluded.updated_at`
        ).bind(String(row.id), String(row.id), await checksum(view), now, now));
      }
      await this.env.DB.batch(statements);
    } catch (error) {
      await this.env.DB.prepare(`DELETE FROM monitors WHERE id = ?`).bind(row.id).run();
      throw error;
    }
    return view;
  }

  async update(id: number, input: Partial<MonitorMutation>) {
    const current = await this.findById(id);
    if (!current) return null;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const next: MonitorView = {
      ...current,
      ...input,
      active: input.active ?? current.active,
      body: input.body === undefined ? current.body : input.body,
      interval_seconds: input.interval_seconds ?? current.interval_seconds,
      timeout_ms: input.timeout_ms ?? current.timeout_ms,
      expected_status: input.expected_status ?? current.expected_status,
      headers: input.headers ?? current.headers,
      updated_at: now,
      next_check_at:
        input.active === false
          ? null
          : input.active === true || input.interval_seconds !== undefined
            ? now
            : current.next_check_at,
    };
    const headersJson = canonicalMigrationJson(next.headers);
    const nextDueMs = next.next_check_at ? Date.parse(next.next_check_at) : null;
    const statements = [
      this.env.DB.prepare(
        `INSERT INTO monitor_definitions
         (id, name, url, method, headers_json, body, interval_ms, timeout_ms,
          expected_status, active, sort_order, created_at_ms, updated_at_ms,
          deleted_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url,
          method = excluded.method, headers_json = excluded.headers_json,
          body = excluded.body, interval_ms = excluded.interval_ms,
          timeout_ms = excluded.timeout_ms,
          expected_status = excluded.expected_status, active = excluded.active,
          sort_order = excluded.sort_order, updated_at_ms = excluded.updated_at_ms,
          deleted_at_ms = NULL`
      ).bind(
        id,
        next.name,
        next.url,
        next.method,
        headersJson,
        next.body,
        next.interval_seconds * 1000,
        next.timeout_ms,
        next.expected_status,
        next.active ? 1 : 0,
        next.sort_order,
        Date.parse(current.created_at),
        nowMs
      ),
      this.env.DB.prepare(
        `INSERT INTO monitor_runtime
         (monitor_id, status, response_time_ms, last_checked_at_ms, next_due_at_ms,
          version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(monitor_id) DO UPDATE SET
           next_due_at_ms = excluded.next_due_at_ms,
           version = monitor_runtime.version + 1,
           updated_at_ms = excluded.updated_at_ms`
      ).bind(
        id,
        current.status ?? "pending",
        current.response_time_ms ?? 0,
        current.last_checked_at ? Date.parse(current.last_checked_at) : null,
        nextDueMs,
        Date.parse(current.created_at),
        nowMs
      ),
    ];
    if (!isContractMode(this.env)) {
      statements.unshift(
        this.env.DB.prepare(
          `UPDATE monitors SET name = ?, url = ?, method = ?, interval = ?,
           timeout = ?, timeout_ms = ?, expected_status = ?, headers = ?, body = ?,
           active = ?, next_check_at = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`
        ).bind(
          next.name,
          next.url,
          next.method,
          next.interval_seconds,
          Math.max(1, Math.ceil(next.timeout_ms / 1000)),
          next.timeout_ms,
          next.expected_status,
          headersJson,
          next.body,
          next.active ? 1 : 0,
          next.next_check_at,
          now,
          id
        )
      );
      statements.push(this.env.DB.prepare(
        `INSERT INTO legacy_id_map
         (source_table, source_id, target_table, target_id, payload_checksum,
          created_at, updated_at)
         VALUES ('monitors', ?, 'monitor_definitions', ?, ?, ?, ?)
         ON CONFLICT(source_table, source_id) DO UPDATE SET
           payload_checksum = excluded.payload_checksum,
           target_table = excluded.target_table, target_id = excluded.target_id,
           updated_at = excluded.updated_at`
      ).bind(String(id), String(id), await checksum(next), now, now));
    }
    await this.env.DB.batch(statements);
    return next;
  }

  async delete(id: number) {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const statements = [
      this.env.DB.prepare(
        `DELETE FROM notification_rules
         WHERE target_type = 'monitor' AND target_id = ?`
      ).bind(id),
      this.env.DB.prepare(
        `DELETE FROM status_components
         WHERE component_type = 'monitor' AND component_id = ?`
      ).bind(id),
      this.env.DB.prepare(
        `UPDATE monitor_definitions SET active = 0, deleted_at_ms = ?,
         updated_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL`
      ).bind(nowMs, nowMs, id),
      this.env.DB.prepare(
        `UPDATE monitor_runtime SET next_due_at_ms = NULL, version = version + 1,
         updated_at_ms = ? WHERE monitor_id = ?`
      ).bind(nowMs, id),
    ];
    const definitionIndex = 2;
    if (!isContractMode(this.env)) {
      statements.unshift(
        this.env.DB.prepare(
          `DELETE FROM legacy_id_map
           WHERE (source_table = 'notification_settings' AND source_id IN (
                    SELECT CAST(id AS TEXT) FROM notification_settings
                    WHERE target_type = 'monitor' AND target_id = ?
                  ))
              OR (source_table = 'notification_settings_channels'
                  AND CAST(substr(source_id, 1, instr(source_id, ':') - 1) AS INTEGER) IN (
                    SELECT id FROM notification_settings
                    WHERE target_type = 'monitor' AND target_id = ?
                  ))`
        ).bind(id, id),
        this.env.DB.prepare(
          `DELETE FROM notification_settings
           WHERE target_type = 'monitor' AND target_id = ?`
        ).bind(id),
        this.env.DB.prepare(
          `DELETE FROM status_page_monitors WHERE monitor_id = ?`
        ).bind(id)
      );
      statements.push(
        this.env.DB.prepare(
          `UPDATE monitors SET active = 0, next_check_at = NULL,
           deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
        ).bind(now, now, id)
      );
    }
    const results = await this.env.DB.batch(statements);
    const offset = isContractMode(this.env) ? 0 : 3;
    return results[definitionIndex + offset].meta.changes === 1;
  }
}
