/**
 * 链接识别与规范化。
 *
 * 与平台注册表配合：本模块只做「文本 → 候选链接」与「补齐 scheme / 去尾标点」，
 * 具体平台判定交给 {@link detectPlatform}。
 *
 * @module dsh-plugin-link-resolver/core/url
 */

/** 从任意文本中抽取 http(s) 链接（按出现顺序，保序去重）。 */
const URL_IN_TEXT = /https?:\/\/[^\s'"<>]+/giu;

/** 链接末尾常见的包裹标点，应从候选中剔除。 */
const TRAILING_PUNCTUATION = /[)\]}>，。！？；：、"''）】]+$/u;

/**
 * 规范化单条链接：去空白、去尾标点、补齐 scheme。
 *
 * @param raw - 原始链接或用户输入。
 * @returns 规范化后的绝对 URL；无法规范化时返回空字符串。
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(TRAILING_PUNCTUATION, '');
  if (trimmed.length === 0) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * 从文本中抽取候选链接（保序去重）。
 *
 * @param text - 用户消息或任意文本。
 * @returns 规范化后的链接列表。
 */
export function extractLinks(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const normalized = normalizeUrl(match[0]);
    if (normalized.length > 0 && !found.includes(normalized)) found.push(normalized);
  }
  return found;
}

/**
 * 取链接主机名（小写）。
 *
 * @param url - 绝对 URL。
 * @returns 主机名；解析失败返回空字符串。
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}