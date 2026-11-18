/**
 * 解析器共享工具：字段提取、URL 规范化与数值转换。
 *
 * @module dsh-plugin-link-resolver/resolvers/common
 */

/** 解析器运行参数。 */
export interface ResolverContext {
  timeoutMs: number;
  retries: number;
  signal?: AbortSignal;
}

/**
 * 取第一个非空字符串。
 *
 * @param values - 候选值。
 * @returns 首个非空字符串，或 undefined。
 */
export function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * 取第一个有效数字。
 *
 * @param values - 候选值。
 * @returns 首个有限数字，或 undefined。
 */
export function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

/**
 * 从 URL 列表形态中提取链接：支持字符串、字符串数组、`{ url_list: [...] }`。
 *
 * @param value - 原始值。
 * @returns 去重后的链接列表。
 */
export function pickUrlList(value: unknown): string[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object' && Array.isArray((value as { url_list?: unknown }).url_list)
      ? ((value as { url_list: unknown[] }).url_list)
      : [value];
  const urls: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim().length > 0) {
      const url = item.trim();
      if (!urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

/**
 * 抖音播放地址的 `playwm`→`play` 替换，并保序去重。
 *
 * @param urls - 原始地址。
 * @returns 处理后的地址。
 */
export function normalizeDouyinUrls(urls: readonly string[]): string[] {
  const result: string[] = [];
  for (const url of urls) {
    const normalized = url.replace('playwm', 'play');
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

/**
 * 去掉 URL 的查询串（用于展示链接）。
 *
 * @param url - 原始 URL。
 * @returns 无查询串的 URL。
 */
export function stripQuery(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}
