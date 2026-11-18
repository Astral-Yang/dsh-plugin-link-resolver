/**
 * 通用站点解析器（yt-dlp + 域名白名单）。
 *
 * 安全边界：只接受配置白名单内的域名，绝不把任意 URL 交给 yt-dlp。
 *
 * @module dsh-plugin-link-resolver/resolvers/generic
 */

import { buildResult, ResolveError } from '../core/result.js';
import type { ResolvedLink } from '../core/result.js';
import { download, inspect } from '../media/ytdlp.js';
import { pickNumber, pickString } from './common.js';
import type { ResolverContext } from './common.js';

/** 默认白名单（可在配置中覆盖）。 */
export const DEFAULT_GENERIC_DOMAINS: readonly string[] = [
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'fb.watch',
  'acfun.cn',
  'reddit.com',
  'vimeo.com',
  'dailymotion.com',
  'twitch.tv',
  'bilibili.tv',
];

/** 主机是否命中白名单（含子域）。 */
export function hostAllowed(url: string, domains: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/**
 * 解析通用站点链接。
 *
 * @param url - 链接。
 * @param ctx - 运行参数。
 * @param options - 白名单与 yt-dlp 路径。
 * @returns 统一结果。
 */
export async function resolveGeneric(
  url: string,
  ctx: ResolverContext,
  options: { domains?: readonly string[]; executable?: string } = {},
): Promise<ResolvedLink> {
  const domains = options.domains ?? DEFAULT_GENERIC_DOMAINS;
  if (!hostAllowed(url, domains)) {
    throw new ResolveError('blocked-domain', `域名不在通用解析白名单内：${new URL(url).hostname}`, { platform: 'generic' });
  }

  const info = await inspect(url, {
    executable: options.executable ?? 'yt-dlp',
    timeoutMs: ctx.timeoutMs,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  const id = pickString(info['id']);
  const title = pickString(info['title']);
  const uploader = pickString(info['uploader'], info['channel']);
  const duration = pickNumber(info['duration']);
  const thumbnail = pickString(info['thumbnail']);
  const webpage = pickString(info['webpage_url']) ?? url;

  return buildResult({
    platform: 'generic',
    url: webpage,
    originalUrl: url,
    ...(id ? { contentId: id } : {}),
    type: 'video',
    ...(title ? { title } : {}),
    ...(pickString(info['description']) ? { description: pickString(info['description'])! } : {}),
    ...(uploader ? { author: uploader } : {}),
    ...(thumbnail ? { cover: thumbnail } : {}),
    ...(duration ? { durationSec: duration } : {}),
    media: [],
    warnings: [],
  });
}

/**
 * 下载通用站点视频。
 *
 * @param url - 链接。
 * @param options - 下载参数。
 * @returns 本地文件。
 */
export async function downloadGeneric(
  url: string,
  options: { ctx: ResolverContext; domains?: readonly string[]; executable?: string; maxHeight?: number; maxBytes?: number; outputDir: string; timeoutMs: number; signal?: AbortSignal },
): Promise<import('../core/result.js').LocalFile> {
  const domains = options.domains ?? DEFAULT_GENERIC_DOMAINS;
  if (!hostAllowed(url, domains)) {
    throw new ResolveError('blocked-domain', `域名不在通用解析白名单内：${new URL(url).hostname}`, { platform: 'generic' });
  }
  const maxHeight = options.maxHeight ?? 720;
  const result = await download(url, options.outputDir, {
    executable: options.executable ?? 'yt-dlp',
    timeoutMs: options.timeoutMs,
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    format: `bv*[height<=?${maxHeight}]+ba/b[height<=?${maxHeight}]/wv*+ba/wv*`,
  });
  return { path: result.path, bytes: result.bytes, kind: 'video', mimeType: 'video/mp4' };
}