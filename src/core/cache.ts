/**
 * 会话级解析缓存（内存实现）。
 *
 * P1 先用进程内 LRU + TTL，避免同一链接在同一会话里重复请求；
 * 后续可替换为 `ctx.sessionProjections` 单元以获得持久化与回放能力。
 *
 * @module dsh-plugin-link-resolver/core/cache
 */

import type { ResolvedLink } from './result.js';

/** 单条缓存记录。 */
interface Entry {
  value: ResolvedLink;
  expiresAt: number;
}

/** 带 TTL 与容量上限的会话缓存。 */
export class SessionCache {
  private readonly sessions = new Map<string, Map<string, Entry>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntriesPerSession = 50,
  ) {}

  /**
   * 读取缓存。
   *
   * @param sessionId - 会话 id。
   * @param key - 缓存键（通常为规范化 URL）。
   * @returns 命中时返回副本并标记 `cached`。
   */
  get(sessionId: string, key: string): ResolvedLink | undefined {
    const bucket = this.sessions.get(sessionId);
    const entry = bucket?.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      bucket?.delete(key);
      return undefined;
    }
    return { ...entry.value, cached: true };
  }

  /**
   * 写入缓存。
   *
   * @param sessionId - 会话 id。
   * @param key - 缓存键。
   * @param value - 解析结果。
   */
  set(sessionId: string, key: string, value: ResolvedLink): void {
    let bucket = this.sessions.get(sessionId);
    if (!bucket) {
      bucket = new Map();
      this.sessions.set(sessionId, bucket);
    }
    if (bucket.size >= this.maxEntriesPerSession) {
      const oldest = bucket.keys().next().value;
      if (oldest !== undefined) bucket.delete(oldest);
    }
    bucket.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * 删除所有引用了指定路径之下文件的缓存条目。
   *
   * 保留策略清理目录后调用：避免缓存把已被删除的目录当成"仍可复用"。
   *
   * @param prefix - 目录前缀（绝对路径）。
   * @returns 失效的条目数。
   */
  dropUnder(prefix: string): number {
    let dropped = 0;
    const normalized = prefix.replace(/\/+$/, '');
    for (const [sessionId, bucket] of this.sessions) {
      for (const [key, entry] of bucket) {
        const files = entry.value.downloads ?? [];
        if (files.some((file) => file.path === normalized || file.path.startsWith(`${normalized}/`))) {
          bucket.delete(key);
          dropped += 1;
        }
      }
      if (bucket.size === 0) this.sessions.delete(sessionId);
    }
    return dropped;
  }

  /** 清空全部缓存（插件卸载时调用）。 */
  clear(): void {
    this.sessions.clear();
  }
}