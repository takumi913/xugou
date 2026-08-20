import type { Bindings } from "../../../models/db";

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
  return "";
}

export class D1MonitorRepository implements MonitorRepositoryPort {
  constructor(private readonly env: Bindings) {}

  async listPage(input: Parameters<MonitorRepositoryPort["listPage"]>[0]) {
    const afterSortOrder = input.after?.sortOrder ?? Number.MIN_SAFE_INTEGER;
    const afterId = input.after?.id ?? 0;
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

  async findById(id: number) {
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

  async create(input: MonitorMutation) {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const active = input.active === false ? 0 : 1;
    const headersJson = "";
    // monitors 表如今只当 id 锚点：monitor_check_samples / monitor_check_rollups /
    // monitor_incidents 的外键都指向 monitors(id)，而 D1 的 foreign_keys 是开着的。
    // 少了这行锚点，新建的监控第一次写检查样本就会 FOREIGN KEY constraint failed。
    // 与 agents / agent_nodes 的做法一致：业务字段只落 monitor_definitions。
    const anchor = await this.env.DB.prepare(
      `INSERT INTO monitors
       (name, url, method, interval, timeout, expected_status, headers, active,
        status, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', 0, 'retired', ?, ?, ?)
       RETURNING id`
    )
      .bind(
        `contract-anchor:${crypto.randomUUID()}`,
        input.url,
        input.method,
        input.interval_seconds,
        Math.max(1, Math.ceil(input.timeout_ms / 1000)),
        input.expected_status,
        now,
        now,
        now
      )
      .first<{ id: number }>();
    if (!anchor) throw new Error("Monitor identity insert returned no ID");
    const identityInsert = this.env.DB.prepare(
      `INSERT INTO monitor_definitions
       (id, name, url, method, headers_json, body, interval_ms, timeout_ms,
        expected_status, active, sort_order, created_at_ms, updated_at_ms,
        deleted_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)
       RETURNING id`
    ).bind(
      anchor.id,
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
    );
    let row: { id: number } | null = null;
    try {
      row = await identityInsert.first<{ id: number }>();
    } catch (error) {
      await this.env.DB.prepare(`DELETE FROM monitors WHERE id = ?`)
        .bind(anchor.id)
        .run();
      throw error;
    }
    if (!row) {
      await this.env.DB.prepare(`DELETE FROM monitors WHERE id = ?`)
        .bind(anchor.id)
        .run();
      throw new Error("Monitor insert returned no ID");
    }
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
          `INSERT INTO monitor_runtime
           (monitor_id, status, response_time_ms, last_checked_at_ms,
            next_due_at_ms, version, created_at_ms, updated_at_ms)
           VALUES (?, 'pending', 0, NULL, ?, 0, ?, ?)`
        ).bind(row.id, active ? nowMs : null, nowMs, nowMs),
      ];
      await this.env.DB.batch(statements);
    } catch (error) {
      await this.env.DB.batch([
        this.env.DB.prepare(`DELETE FROM monitor_definitions WHERE id = ?`).bind(row.id),
        this.env.DB.prepare(`DELETE FROM monitors WHERE id = ?`).bind(anchor.id),
      ]);
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
    const headersJson = "";
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
    const results = await this.env.DB.batch(statements);
    return results[definitionIndex].meta.changes === 1;
  }
}
