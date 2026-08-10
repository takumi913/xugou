import type { Bindings } from "../../../models/db";

export class D1MigrationLedgerQuery {
  constructor(private readonly env: Bindings) {}

  async listCheckpoints() {
    return (
      await this.env.DB.prepare(
        `SELECT migration_key, phase, status, last_pk, rows_read, rows_written,
                rows_skipped, anomaly_rows, checksum, last_error, started_at,
                lease_expires_at, completed_at, created_at, updated_at
         FROM migration_checkpoints
         ORDER BY updated_at DESC, migration_key ASC LIMIT 100`
      ).all<Record<string, unknown>>()
    ).results;
  }

  async listAnomalies(input: {
    cursor?: number;
    migrationKey?: string;
    status?: string;
    limit: number;
  }) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("MIGRATION_ANOMALY_LIMIT_INVALID");
    }
    const conditions: string[] = [];
    const bindings: unknown[] = [];
    if (input.cursor !== undefined) {
      conditions.push("id < ?");
      bindings.push(input.cursor);
    }
    if (input.migrationKey) {
      conditions.push("migration_key = ?");
      bindings.push(input.migrationKey);
    }
    if (input.status) {
      conditions.push("status = ?");
      bindings.push(input.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.env.DB.prepare(
      `SELECT id, migration_key, source_table, source_pk, error_code,
              raw_value_json, status, resolution_note, first_seen_at,
              resolved_at, created_at, updated_at
       FROM migration_anomalies ${where}
       ORDER BY id DESC LIMIT ?`
    )
      .bind(...bindings, input.limit + 1)
      .all<Record<string, unknown> & { id: number }>();
    const hasMore = rows.results.length > input.limit;
    const data = hasMore ? rows.results.slice(0, input.limit) : rows.results;
    return {
      data,
      next_cursor: hasMore ? data.at(-1)?.id ?? null : null,
      has_more: hasMore,
    };
  }

  async updateAnomaly(
    id: number,
    action: "retry" | "ignore",
    note: string | null
  ) {
    const now = new Date().toISOString();
    const row = await this.env.DB.prepare(
      `UPDATE migration_anomalies
       SET status = ?, resolution_note = ?, resolved_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('open', 'ignored', 'retry_requested')
       RETURNING id`
    )
      .bind(
        action === "retry" ? "retry_requested" : "ignored",
        note,
        action === "ignore" ? now : null,
        now,
        id
      )
      .first<{ id: number }>();
    return Boolean(row);
  }
}
