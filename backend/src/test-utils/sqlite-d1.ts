import { DatabaseSync } from "node:sqlite";

/**
 * 用 node:sqlite 实现的最小 D1 适配层，供 jobs / persistence 层的单元测试使用。
 *
 * 只覆盖生产代码实际用到的 D1 API（prepare/bind/run/first/all/batch）。
 * 相比手写的假对象，它跑的是真 SQL：rowid、ON CONFLICT ... WHERE、
 * meta.changes 这些正是保留策略与幂等守卫依赖的语义。
 */
export interface SqliteD1 {
  DB: D1Database;
  raw: DatabaseSync;
  close(): void;
}

type Value = string | number | null | Uint8Array;

function normalizeParam(value: unknown): Value {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return value;
  if (typeof value === "number" || typeof value === "string") return value;
  return String(value);
}

function meta(changes: unknown) {
  return {
    changes: Number(changes ?? 0),
    duration: 0,
    last_row_id: 0,
    rows_read: 0,
    rows_written: 0,
    size_after: 0,
    changed_db: true,
  };
}

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: Value[] = []
  ) {}

  bind(...args: unknown[]) {
    return new SqliteStatement(this.db, this.sql, args.map(normalizeParam));
  }

  private stmt() {
    return this.db.prepare(this.sql);
  }

  async run() {
    const result = this.stmt().run(...this.params);
    return { success: true, results: [], meta: meta(result.changes) };
  }

  async first<T = unknown>(column?: string) {
    const row = this.stmt().get(...this.params) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return (column ? (row[column] as T) : (row as T)) ?? null;
  }

  async all<T = unknown>() {
    const results = this.stmt().all(...this.params) as T[];
    return { success: true, results, meta: meta(0) };
  }

  async raw<T = unknown[]>() {
    const results = this.stmt().all(...this.params) as Record<string, unknown>[];
    return results.map((row) => Object.values(row)) as T[];
  }
}

export function createSqliteD1(schema?: string): SqliteD1 {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  if (schema) db.exec(schema);

  const DB = {
    prepare: (sql: string) => new SqliteStatement(db, sql),
    async batch(statements: SqliteStatement[]) {
      // D1 的 batch 是一个隐式事务，失败整体回滚。
      db.exec("BEGIN");
      try {
        const out = [];
        for (const statement of statements) out.push(await statement.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    withSession: () => {
      throw new Error("withSession 未在测试适配层实现");
    },
  } as unknown as D1Database;

  return { DB, raw: db, close: () => db.close() };
}

/** 保留策略测试需要的最小 schema。 */
export const METRIC_BLOCK_SCHEMA = `
CREATE TABLE agent_metric_blocks (
  id           INTEGER PRIMARY KEY,
  agent_id     INTEGER NOT NULL,
  resolution   INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,
  point_count  INTEGER NOT NULL,
  codec        INTEGER NOT NULL,
  byte_size    INTEGER NOT NULL,
  data         BLOB NOT NULL
);
CREATE UNIQUE INDEX agent_metric_blocks_key_idx
  ON agent_metric_blocks (agent_id, resolution, bucket_start);
CREATE INDEX agent_metric_blocks_gc_idx
  ON agent_metric_blocks (resolution, bucket_start);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
`;
