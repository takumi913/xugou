import type { Bindings } from "../../../models/db";

export async function queryLegacyNotificationHistory(
  env: Bindings,
  input: {
    type?: string;
    targetId?: number;
    status?: string;
    limit: number;
    offset: number;
  }
) {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (input.type) {
    conditions.push("type = ?");
    bindings.push(input.type);
  }
  if (input.targetId !== undefined) {
    conditions.push("target_id = ?");
    bindings.push(input.targetId);
  }
  if (input.status) {
    conditions.push("status = ?");
    bindings.push(input.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const [countRow, records] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM notification_history ${where}`)
      .bind(...bindings)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT id, type, target_id, channel_id, template_id, status, content,
              error, sent_at
       FROM notification_history ${where}
       ORDER BY id DESC LIMIT ? OFFSET ?`
    )
      .bind(...bindings, input.limit, input.offset)
      .all<Record<string, unknown>>(),
  ]);
  return { total: Number(countRow?.count ?? 0), records: records.results };
}
