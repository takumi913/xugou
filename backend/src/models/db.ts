// 通用数据库类型定义
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec<T = unknown>(query: string): Promise<D1Result<T>>;
}

export interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

// Cloudflare Workers Fetcher 类型定义
export interface Fetcher {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

// 扩展D1Result meta属性的类型
export interface D1Meta {
  last_row_id?: number;
  changes?: number;
}

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  error?: string;
  meta?: object;
}

// 版本元数据类型定义
export interface VersionMetadata {
  id?: string;
  tag?: string;
  timestamp?: string;
  [key: string]: any;
}

// 通用绑定类型
export type Bindings = {
  DB: D1Database;
  CF_VERSION_METADATA?: VersionMetadata;
  ASSETS: Fetcher;
  ALLOWED_ORIGINS?: string;
  LOG_REQUESTS?: string;
  NODE_ENV?: string;
  MIN_AGENT_REPORT_INTERVAL_SECONDS?: string;
  MIN_MONITOR_INTERVAL_SECONDS?: string;
  MONITOR_CHECK_BATCH_SIZE?: string;
  MONITOR_CHECK_CONCURRENCY?: string;
  AGENT_OFFLINE_BATCH_SIZE?: string;
  STATUS_PAGE_CACHE_TTL_SECONDS?: string;
  STATUS_SNAPSHOT_DIRTY_COALESCE_SECONDS?: string;
  PUBLIC_METRICS_CACHE_TTL_SECONDS?: string;
  AGENT_ROLLUP_RETENTION_DAYS?: string;
  MONITOR_ROLLUP_RETENTION_DAYS?: string;
  MONITOR_INCIDENT_RETENTION_DAYS?: string;
  FREE_MODE?: string;
};
