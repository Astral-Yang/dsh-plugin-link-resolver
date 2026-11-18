/**
 * YouTube 解析器（yt-dlp 后端）。
 *
 * @module dsh-plugin-link-resolver/resolvers/youtube
 */

import { buildResult, ResolveError } from '../core/result.js';
import type { MediaItem, ResolvedLink } from '../core/result.js';
import { download, inspect } from '../media/ytdlp.js';
import { pickNumber, pickString } from './common.js';
import type { ResolverContext } from './common.js';

/** YouTube 链接判断。 */
export function isYoutubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
  } catch {
    return false;
  }
}

/** 从 info 中挑选可用视频流（按高度去重）。 */
export function buildYoutubeMedia(info: Record<string, unknown>, maxHeight = 1080): MediaItem[] {
  const formats = Array.isArray(info['formats']) ? info['formats'] : [];
  const selected = new Map<number, { item: MediaItem; tbr: number }>();
  for (const raw of formats) {
    if (raw === null || typeof raw !== 'object') continue;
    const format = raw as Record<string, unknown>;
    if (format['vcodec'] === 'none' || !pickString(format['url'])) continue;
    const height = pickNumber(format['height']);
    if (!height || height > maxHeight) continue;
    const tbr = pickNumber(format['tbr']) ?? 0;
    const existing = selected.get(height);
    if (existing && existing.tbr >= tbr) continue;
    selected.set(height, {
      tbr,
      item: {
        kind: 'video',
        url: pickString(format['url'])!,
        ...(pickNumber(format['width']) ? { width: pickNumber(format['width']) } : {}),
        height,
        quality: { label: `${height}P`, height },
      },
    });
  }
  return [...selected.values()].map((entry) => entry.item).sort((a, b) => (b.quality?.height ?? 0) - (a.quality?.height ?? 0));
}

/**
 * 解析 YouTube 链接。
 *
 * @param url - 规范化链接。
 * @param ctx - 运行参数。
 * @param executable - yt-dlp 路径。
 * @returns 统一结果。
 */
export async function resolveYoutube(url: string, ctx: ResolverContext, executable = 'yt-dlp'): Promise<ResolvedLink> {
  if (!isYoutubeUrl(url)) throw new ResolveError('unsupported-url', `不是 YouTube 链接：${url}`, { platform: 'youtube' });
  const info = await inspect(url, {
    executable,
    timeoutMs: ctx.timeoutMs,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  const videoId = pickString(info['id']);
  if (!videoId) throw new ResolveError('parse-failed', 'yt-dlp 未返回视频 id', { platform: 'youtube' });
  const title = pickString(info['title']);
  const uploader = pickString(info['uploader'], info['channel']);
  const duration = pickNumber(info['duration']);
  const thumbnail = pickString(info['thumbnail']);
  const live = info['is_live'] === true || info['live_status'] === 'is_live';

  return buildResult({
    platform: 'youtube',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    originalUrl: url,
    contentId: videoId,
    type: 'video',
    ...(title ? { title } : {}),
    ...(pickString(info['description']) ? { description: pickString(info['description'])! } : {}),
    ...(uploader ? { author: uploader } : {}),
    ...(thumbnail ? { cover: thumbnail } : {}),
    ...(duration ? { durationSec: duration } : {}),
    media: live ? [] : buildYoutubeMedia(info).slice(0, 5),
    warnings: live ? ['直播内容不支持下载'] : [],
  });
}

/**
 * 下载 YouTube 视频。
 *
 * @param url - 链接。
 * @param options - 下载参数。
 * @returns 本地文件。
 */
export async function downloadYoutube(
  url: string,
  options: { ctx: ResolverContext; executable?: string; maxHeight?: number; maxBytes?: number; outputDir: string; timeoutMs: number; signal?: AbortSignal },
): Promise<import('../core/result.js').LocalFile> {
  const maxHeight = options.maxHeight ?? 1080;
  const format = `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/best[height<=${maxHeight}]/best`;
  const result = await download(url, options.outputDir, {
    executable: options.executable ?? 'yt-dlp',
    timeoutMs: options.timeoutMs,
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    format,
  });
  return { path: result.path, bytes: result.bytes, kind: 'video', mimeType: 'video/mp4' };
}

/** 仅测试使用。 */
export const __test__ = { buildYoutubeMedia, isYoutubeUrl };