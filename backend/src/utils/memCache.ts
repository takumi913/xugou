/**
 * isolate 内存缓存（参照 CF-Server-Monitor utils/cache.js）
 *
 * 泛型 TTL Map 缓存 + 简单容量上限（超限时淘汰最早写入的键）。
 * 仅缓存 D1 查询结果；DO 内存中的实时数据（latest-report 合并）不经过本缓存，
 * 保证 B1 WebSocket 链路的实时性不受影响。
 */

export class MemCache<V = unknown> {
  private store = new Map<string, { value: V; expiresAt: number }>();

  constructor(private maxEntries = 500) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    // 先删再插，保证重复写入的键回到插入序末尾
    this.store.delete(key);
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  deleteByPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// ---- 缓存 TTL 策略 ----

export const AGENTS_LIST_TTL_MS = 60 * 1000; // agents 列表 60s
export const AGENT_LATEST_TTL_MS = 30 * 1000; // 单 agent 最新指标（DB 部分）30s

/**
 * 历史查询缓存 TTL 随时长递增：1h→30s，6h→60s，12h→2min，24h→5min，168h→30min
 */
export function getHistoryCacheTtlMs(hours: number): number {
  if (hours <= 1) return 30 * 1000;
  if (hours <= 6) return 60 * 1000;
  if (hours <= 12) return 2 * 60 * 1000;
  if (hours <= 24) return 5 * 60 * 1000;
  return 30 * 60 * 1000;
}

// ---- 单例缓存实例（isolate 级别） ----

// agents 列表：key = `list:${userId}`
export const agentsListCache = new MemCache<unknown[]>(100);
// 最新指标（DB 部分）：key = `latest:${agentId}`（单查与批量查询共用的按 agent 键控缓存）
export const agentLatestCache = new MemCache<unknown>(500);
// 历史指标：key = `${agentId}:${hours}`
export const agentHistoryCache = new MemCache<unknown[]>(500);

// 轮换旧表 agent_metrics_history_old 存在性探测结果（isolate 级布尔缓存）
let historyOldTableExistsFlag: boolean | null = null;

export function getCachedHistoryOldTableExists(): boolean | null {
  return historyOldTableExistsFlag;
}

export function setCachedHistoryOldTableExists(exists: boolean): void {
  historyOldTableExistsFlag = exists;
}

export function invalidateAgentsListCache(): void {
  agentsListCache.clear();
}

export function invalidateAgentLatestCache(agentId?: number): void {
  if (typeof agentId === "number") {
    agentLatestCache.delete(`latest:${agentId}`);
    return;
  }
  agentLatestCache.clear();
}

export function invalidateAgentHistoryCache(agentId?: number): void {
  if (typeof agentId === "number") {
    agentHistoryCache.deleteByPrefix(`${agentId}:`);
    return;
  }
  agentHistoryCache.clear();
}

export function clearAgentCaches(): void {
  agentsListCache.clear();
  agentLatestCache.clear();
  agentHistoryCache.clear();
  // 轮换会创建/删除 _old 表，存在性缓存一并重置
  historyOldTableExistsFlag = null;
}
