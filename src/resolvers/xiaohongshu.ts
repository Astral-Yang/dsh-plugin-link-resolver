/**
 * 小红书解析器：抓取 explore 页面的 `window.__INITIAL_STATE__`。
 *
 * 与参考实现一致：优先 explore（比 discovery 稳定），失败后回退 discovery/item。
 *
 * @module dsh-plugin-link-resolver/resolvers/xiaohongshu
 */

import { requestText, DEFAULT_UA } from '../core/http.js';
import { buildResult, ResolveError } from '../core/result.js';
import type { MediaItem, ResolvedLink } from '../core/result.js';
import { pickNumber, pickString, pickUrlList } from './common.js';
import type { ResolverContext } from './common.js';

/** 桌面 UA（与参考实现一致）。 */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/55.0.2883.87 UBrowser/6.2.4098.3 Safari/537.36';

/** 移动端 UA：discovery 页用这套 UA 才会吐出 noteData。 */
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

/** 小红书链接引用：笔记 id + 可选的 xsec_token。 */
export interface XhsRef {
  id: string;
  xsecToken?: string;
}

/**
 * 从链接中提取笔记 id 与 xsec_token。
 *
 * 兼容三种形态：explore / discovery/item 直链、`login?redirectPath=...` 跳转、
 * 以及 redirectPath 中嵌套的分享参数。
 *
 * @param url - 任意小红书链接。
 * @returns 引用信息；无法提取时返回 undefined。
 */
export function extractXhsRef(url: string): XhsRef | undefined {
  const direct = /(?:explore|discovery\/item|user\/profile\/[0-9a-zA-Z]+)\/(?<id>[0-9a-zA-Z]+)/i.exec(url);
  if (direct?.groups?.['id']) {
    let token: string | undefined;
    try {
      token = new URL(url).searchParams.get('xsec_token') ?? undefined;
    } catch {
      token = undefined;
    }
    return { id: direct.groups['id'], ...(token ? { xsecToken: token } : {}) };
  }
  try {
    const redirect = new URL(url).searchParams.get('redirectPath');
    if (redirect) return extractXhsRef(redirect);
  } catch {
    // 落到 undefined
  }
  return undefined;
}

/**
 * 提取笔记 id（兼容旧调用）。
 *
 * @param url - 任意小红书链接。
 * @returns note id。
 */
export function extractXhsNoteId(url: string): string | undefined {
  return extractXhsRef(url)?.id;
}

/**
 * 从 HTML 中提取并解析 `window.__INITIAL_STATE__`。
 *
 * @param html - 页面 HTML。
 * @returns 解析后的对象。
 */
export function parseInitialState(html: string): Record<string, unknown> {
  const match = /window\.__INITIAL_STATE__\s*=\s*(.*?)<\/script>/s.exec(html);
  if (!match?.[1]) throw new ResolveError('parse-failed', '页面中未找到 __INITIAL_STATE__（可能已失效或需要登录）', { platform: 'xiaohongshu' });
  const text = match[1].replace(/\bundefined\b/g, 'null');
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new ResolveError('parse-failed', '小红书页面数据解析失败', { platform: 'xiaohongshu', cause: error });
  }
}

/**
 * 提取图片 fileId（优先字段，其次从 URL 推断）。
 *
 * @param image - 图片对象。
 * @returns fileId 或 undefined。
 */
export function extractFileId(image: Record<string, unknown>): string | undefined {
  const direct = pickString(image['fileId'], image['file_id'], image['traceId']);
  if (direct) return direct.split('!', 1)[0];
  for (const key of ['urlDefault', 'url', 'urlPre']) {
    const url = pickString(image[key]);
    if (!url) continue;
    const spectrum = /spectrum\/([a-zA-Z0-9]+)/.exec(url)?.[1];
    if (spectrum) return spectrum;
    const base = url.split('?')[0]!.split('!')[0]!.split('/').pop() ?? '';
    if (base.length > 20 && /^[a-zA-Z0-9]+$/.test(base)) return base;
  }
  return undefined;
}

/**
 * 构造 ci.xiaohongshu.com 原图地址。
 *
 * @param fileId - 图片 fileId。
 * @param png - 是否要求 PNG。
 * @returns 原图地址。
 */
export function ciImageUrl(fileId: string, png = true): string {
  return `https://ci.xiaohongshu.com/${fileId}?imageView2/2/w/format/${png ? 'png' : 'jpg'}`;
}

/** 从流对象中按编码优先级取地址。 */
function streamUrls(stream: unknown, preferH265 = false): string[] {
  if (stream === null || typeof stream !== 'object') return [];
  const record = stream as Record<string, unknown>;
  const codecs = preferH265 ? ['h265', 'h264', 'av1', 'h266'] : ['h264', 'h265', 'av1', 'h266'];
  const urls: string[] = [];
  for (const codec of codecs) {
    const list = record[codec];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const master = pickString(entry['masterUrl']);
      if (master && !urls.includes(master)) urls.push(master);
      for (const backup of pickUrlList(entry['backupUrls'] ?? entry['backupUrl'])) {
        if (!urls.includes(backup)) urls.push(backup);
      }
    }
  }
  return urls;
}

/** 把笔记对象映射为统一结果。 */
function mapNote(note: Record<string, unknown>, url: string, noteId: string, sourceUrl: string, preferCiPng = true): ResolvedLink {
  const imageList = Array.isArray(note['imageList']) ? note['imageList'] : [];
  const media: MediaItem[] = [];
  for (const raw of imageList) {
    if (raw === null || typeof raw !== 'object') continue;
    const image = raw as Record<string, unknown>;
    const fileId = extractFileId(image);
    const candidates = [
      ...(fileId ? [ciImageUrl(fileId, preferCiPng)] : []),
      ...pickUrlList(image['urlDefault']),
      ...pickUrlList(image['url']),
      ...pickUrlList(image['urlPre']),
    ].filter((value, index, all) => all.indexOf(value) === index);
    if (candidates.length === 0) continue;
    const imageIndex = media.length;
    media.push({ kind: 'image', url: candidates[0]!, candidates });
    const live = streamUrls(image['stream']);
    if (live.length > 0) {
      media.push({ kind: 'livephoto-video', url: live[0]!, candidates: live, pairedWith: imageIndex });
    }
  }

  const video = note['video'] as Record<string, unknown> | undefined;
  if (note['type'] === 'video' && video) {
    const stream = (video['media'] as Record<string, unknown> | undefined)?.['stream'];
    const urls = streamUrls(stream, true);
    if (urls.length > 0) media.push({ kind: 'video', url: urls[0]!, candidates: urls });
  }

  const videoCount = media.filter((item) => item.kind === 'video').length;
  const imageCount = media.filter((item) => item.kind === 'image').length;
  const type = videoCount > 0 && imageCount > 0 ? 'mixed' : videoCount > 0 ? 'video' : 'images';

  const author = (note['user'] ?? note['author']) as Record<string, unknown> | undefined;
  const title = pickString(note['title'], note['shareTitle']);
  const description = pickString(note['desc'], note['shareDesc']);

  return buildResult({
    platform: 'xiaohongshu',
    url: `https://www.xiaohongshu.com/explore/${noteId}`,
    originalUrl: sourceUrl,
    contentId: noteId,
    type,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(author ? { author: pickString(author['nickname'], author['nickName'], author['name']) ?? undefined } : {}),
    ...(author ? { authorAvatar: pickString(author['avatar']) ?? undefined } : {}),
    ...(media.find((item) => item.kind === 'image') ? { cover: media.find((item) => item.kind === 'image')!.url } : {}),
    ...(pickNumber(video?.['duration']) ? { durationSec: pickNumber(video?.['duration']) } : {}),
    media,
    warnings: [],
  });
}

/**
 * 解析一条小红书链接。
 *
 * @param url - 已规范化链接。
 * @param ctx - 运行参数。
 * @returns 统一结果。
 */
/** 从最终 URL 中取 `redirectPath`（登录墙跳转的真实目标）。 */
export function redirectTargetOf(finalUrl: string): string | undefined {
  try {
    const redirect = new URL(finalUrl).searchParams.get('redirectPath');
    if (!redirect) return undefined;
    const target = new URL(redirect);
    const host = target.hostname.toLowerCase();
    if (host !== 'www.xiaohongshu.com' && host !== 'xiaohongshu.com') return undefined;
    return target.toString();
  } catch {
    return undefined;
  }
}

/** HTML 兜底解析结果。 */
export interface XhsHtmlMedia {
  title?: string;
  description?: string;
  durationSec?: number;
  videoUrls: string[];
  imageUrls: string[];
}

/**
 * 从原始 HTML 中提取媒体直链（不依赖 __INITIAL_STATE__ 结构）。
 *
 * 适用于页面结构变化、`noteData` 缺失或被风控裁剪的情况。
 *
 * @param html - 笔记页 HTML。
 * @returns 提取到的标题、正文、时长与媒体直链。
 */
export function parseHtmlMedia(html: string): XhsHtmlMedia {
  const unescape = (value: string): string => value.replace(/\\\//g, '/').replace(/\\u002F/gi, '/');

  const videoUrls: string[] = [];
  for (const match of html.matchAll(/"masterUrl"\s*:\s*"([^"]+)"/g)) {
    const url = unescape(match[1] ?? '');
    if (url.startsWith('http') && !videoUrls.includes(url)) videoUrls.push(url);
  }

  const imageUrls: string[] = [];
  for (const match of html.matchAll(/https?:\/\/[^"'\\\s]*sns-(?:webpic-qc|na-i6)\.xhscdn\.com\/[^"'\\\s]+/g)) {
    const url = unescape(match[0]).replace(/[!].*$/, '');
    if (url.startsWith('http') && !imageUrls.includes(url)) imageUrls.push(url);
  }

  const title = /"title"\s*:\s*"([^"]{1,200})"/.exec(html)?.[1];
  const description = /"desc"\s*:\s*"([^"]{1,2000})"/.exec(html)?.[1];
  const duration = /"duration"\s*:\s*(\d+)/.exec(html)?.[1];

  return {
    ...(title ? { title: unescape(title) } : {}),
    ...(description ? { description: unescape(description) } : {}),
    ...(duration ? { durationSec: Number.parseInt(duration, 10) } : {}),
    videoUrls,
    imageUrls,
  };
}

/** 用 HTML 兜底结果构建统一结果。 */
function buildFromHtml(html: XhsHtmlMedia, url: string, noteId: string, sourceUrl: string): ResolvedLink | undefined {
  if (html.videoUrls.length === 0 && html.imageUrls.length === 0) return undefined;
  const media: MediaItem[] = [
    ...html.videoUrls.map((videoUrl, index) => ({ kind: 'video' as const, url: videoUrl, ...(index === 0 ? {} : {}) })),
    ...html.imageUrls.map((imageUrl) => ({ kind: 'image' as const, url: imageUrl })),
  ];
  const videoCount = html.videoUrls.length;
  const imageCount = html.imageUrls.length;
  return buildResult({
    platform: 'xiaohongshu',
    url: `https://www.xiaohongshu.com/explore/${noteId}`,
    originalUrl: sourceUrl,
    contentId: noteId,
    type: videoCount > 0 && imageCount > 0 ? 'mixed' : videoCount > 0 ? 'video' : 'images',
    ...(html.title ? { title: html.title } : {}),
    ...(html.description ? { description: html.description } : {}),
    ...(html.durationSec ? { durationSec: html.durationSec } : {}),
    ...(html.imageUrls[0] ? { cover: html.imageUrls[0] } : {}),
    media,
    warnings: ['通过 HTML 兜底解析（页面状态结构不可用）'],
  });
}

export async function resolveXiaohongshu(url: string, ctx: ResolverContext, cookie = '', preferCiPng = true): Promise<ResolvedLink> {
  let target = url;
  let redirectTarget: string | undefined;

  // 短链先展开：xhslink 常跳到 login?redirectPath=<真实地址>
  if (/xhslink\.(?:com|cn)/i.test(url)) {
    const resolved = await requestText(url, {
      timeoutMs: ctx.timeoutMs,
      retries: ctx.retries,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      headers: { 'User-Agent': DESKTOP_UA },
    }).catch(() => undefined);
    if (resolved?.url) {
      target = resolved.url;
      redirectTarget = redirectTargetOf(resolved.url);
    }
  }

  const ref = extractXhsRef(target) ?? extractXhsRef(redirectTarget ?? '') ?? extractXhsRef(url);
  if (!ref) throw new ResolveError('unsupported-url', `无法从小红书链接提取笔记 id：${url}`, { platform: 'xiaohongshu' });

  const noteId = ref.id;
  const query = new URLSearchParams();
  if (ref.xsecToken) {
    query.set('xsec_token', ref.xsecToken);
    query.set('xsec_source', 'app_share');
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  const candidates: Array<{ url: string; ua: string; referer?: string }> = [];
  // 0) 原始跳转地址（保留完整查询串，优先）
  if (redirectTarget) candidates.push({ url: redirectTarget, ua: MOBILE_UA });
  // 1) explore（桌面 UA）
  candidates.push({ url: `https://www.xiaohongshu.com/explore/${noteId}${suffix}`, ua: DESKTOP_UA });
  // 2) discovery（移动 UA）
  candidates.push({ url: `https://www.xiaohongshu.com/discovery/item/${noteId}${suffix}`, ua: MOBILE_UA });

  let lastHtml = '';
  let lastLoginWall = false;

  for (const candidate of candidates) {
    try {
      const response = await requestText(candidate.url, {
        timeoutMs: ctx.timeoutMs,
        retries: ctx.retries,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        headers: {
          'User-Agent': candidate.ua,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      lastHtml = response.text;
      lastLoginWall = /登录|login/i.test(response.text);

      // 2a) 结构化状态
      try {
        const state = parseInitialState(response.text);
        const detailMap = (state['note'] as Record<string, unknown> | undefined)?.['noteDetailMap'] as Record<string, Record<string, unknown>> | undefined;
        const note = detailMap?.[noteId]?.['note'] as Record<string, unknown> | undefined;
        if (note) return mapNote(note, candidate.url, noteId, url, preferCiPng);
        const noteData = (state['noteData'] as Record<string, unknown> | undefined)?.['data'] as Record<string, unknown> | undefined;
        const fallbackNote = noteData?.['noteData'] as Record<string, unknown> | undefined;
        if (fallbackNote) return mapNote(fallbackNote, candidate.url, noteId, url, preferCiPng);
      } catch {
        // 状态解析失败 → HTML 兜底
      }

      // 2b) HTML 兜底（页面结构变化时仍可拿到直链）
      const htmlMedia = parseHtmlMedia(response.text);
      const built = buildFromHtml(htmlMedia, candidate.url, noteId, url);
      if (built) return built;
    } catch {
      // 尝试下一个候选
    }
  }

  throw new ResolveError(
    lastLoginWall ? 'auth-required' : 'parse-failed',
    lastLoginWall
      ? '小红书返回登录墙：需配置 xhsCookies（浏览器登录态）后才能解析'
      : '未找到笔记详情（短链可能过期，或页面结构已变化）',
    { platform: 'xiaohongshu' },
  );
}

/** 供测试使用的内部映射入口。 */
export const __test__ = { mapNote, parseInitialState, DESKTOP_UA, DEFAULT_UA };

/**
 * 下载小红书笔记媒体（图片优先原图链路 + 视频）。
 *
 * @param url - 笔记链接。
 * @param options - 下载参数。
 * @returns 本地文件列表。
 */
export async function downloadXiaohongshu(
  url: string,
  options: {
    ctx: ResolverContext;
    cookie?: string;
    preferCiPng?: boolean;
    maxMedia: number;
    outputDir: string;
    timeoutMs: number;
    maxBytes?: number;
    signal?: AbortSignal;
    concurrency?: number;
    filePrefix?: string;
    /** 已解析结果（传入时跳过二次解析，避免短链 token 过期）。 */
    result?: ResolvedLink;
  },
): Promise<import('../core/result.js').LocalFile[]> {
  const { Semaphore } = await import('../core/http.js');
  const { downloadFile } = await import('../media/download.js');
  const { stat } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const result = options.result ?? (await resolveXiaohongshu(url, options.ctx, options.cookie ?? '', options.preferCiPng ?? true));
  const items = result.media.filter((item) => item.kind === 'image' || item.kind === 'video').slice(0, options.maxMedia);
  const semaphore = new Semaphore(options.concurrency ?? 4);
  const files: import('../core/result.js').LocalFile[] = [];

  await Promise.all(
    items.map((item, index) =>
      semaphore.run(async () => {
        const candidates = [item.url, ...(item.candidates ?? [])].filter((value, i, all) => all.indexOf(value) === i);
        for (const candidate of candidates) {
          const ext = item.kind === 'video' ? '.mp4' : /(?:\.png|format\/png)(\?|$)/i.test(candidate) ? '.png' : '.jpg';
          const prefix = options.filePrefix ?? `xhs_${result.contentId ?? 'note'}_`;
          const target = join(options.outputDir, `${prefix}${String(index + 1).padStart(2, '0')}${ext}`);
          try {
            const file = await downloadFile(candidate, target, {
              timeoutMs: options.timeoutMs,
              ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
              headers: { Referer: 'https://www.xiaohongshu.com/' },
            });
            files.push({ path: file.path, bytes: file.bytes, kind: item.kind === 'video' ? 'video' : 'image', mimeType: item.kind === 'video' ? 'video/mp4' : ext === '.png' ? 'image/png' : 'image/jpeg' });
            return;
          } catch {
            // 尝试下一候选
          }
        }
      }),
    ),
  );
  await stat(options.outputDir).catch(() => {});
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
