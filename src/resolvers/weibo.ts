/**
 * 微博解析器：访客 Cookie + `ajax/statuses/show`。
 *
 * 与参考实现一致：优先访客态，失败后重试一次（重新申请访客身份）；
 * 配置了用户 Cookie 时直接使用。媒体只取原图与最高码率视频。
 *
 * @module dsh-plugin-link-resolver/resolvers/weibo
 */

import { requestJson, requestText, DEFAULT_UA } from '../core/http.js';
import { buildResult, ResolveError } from '../core/result.js';
import type { MediaItem, ResolvedLink } from '../core/result.js';
import { pickNumber, pickString, pickUrlList } from './common.js';
import type { ResolverContext } from './common.js';

/** 访客身份接口。 */
const VISITOR_URL = 'https://passport.weibo.com/visitor/genvisitor2';
/** 单条微博详情接口。 */
const STATUS_URL = 'https://weibo.com/ajax/statuses/show';

/** 微博 API 请求头。 */
const API_HEADERS: Record<string, string> = {
  'User-Agent': DEFAULT_UA,
  Referer: 'https://weibo.com/',
  Accept: 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest',
};

/**
 * 提取微博 id。
 *
 * @param url - 规范化链接。
 * @returns 微博 id。
 */
export function extractWeiboId(url: string): string | undefined {
  const patterns = [
    /weibo\.com\/\d{10}\/(?<id>[A-Za-z0-9]{9,16})/i,
    /m\.weibo\.cn\/(?:detail|status|\d+)\/(?<id>[A-Za-z0-9]{9,16})/i,
    /weibo\.cn\/(?:detail\/)?(?<id>[A-Za-z0-9]{9,16})/i,
  ];
  for (const pattern of patterns) {
    const id = pattern.exec(url)?.groups?.['id'];
    if (id) return id;
  }
  return undefined;
}

/** 解析 Set-Cookie 头为字典。 */
function parseSetCookies(headers: Headers): Record<string, string> {
  const cookies: Record<string, string> = {};
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const item of list) {
    const segment = item.split(';', 1)[0]?.trim() ?? '';
    const index = segment.indexOf('=');
    if (index <= 0) continue;
    const name = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (name && value) cookies[name] = value;
  }
  return cookies;
}

/**
 * 申请访客 Cookie（至少含 SUB）。
 *
 * @param ctx - 运行参数。
 * @returns Cookie 字典。
 */
export async function fetchVisitorCookies(ctx: ResolverContext): Promise<Record<string, string>> {
  const response = await requestText(VISITOR_URL, {
    method: 'POST',
    body: 'cb=visitor_gray_callback&tid=&from=weibo',
    timeoutMs: ctx.timeoutMs,
    retries: ctx.retries,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    headers: {
      'User-Agent': DEFAULT_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  const cookies = parseSetCookies(response.headers);
  if (!cookies['SUB']) {
    throw new ResolveError('auth-required', '微博访客 Cookie 申请失败（未返回 SUB）', {
      platform: 'weibo',
      retryable: true,
    });
  }
  return cookies;
}

/** 清洗微博正文：换行标签、去标签、反转义。 */
export function cleanWeiboText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const text = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u200b/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return text.length > 0 ? text : undefined;
}

/** 从 pic_infos / pics 提取图片。 */
function extractImages(status: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const infos = status['pic_infos'];
  if (infos !== null && typeof infos === 'object') {
    for (const info of Object.values(infos as Record<string, unknown>)) {
      if (info === null || typeof info !== 'object') continue;
      const record = info as Record<string, unknown>;
      for (const key of ['largest', 'original', 'mw2000', 'large', 'orj1080', 'orj960', 'bmiddle', 'thumbnail', 'url']) {
        const value = record[key];
        const url =
          typeof value === 'string' ? pickString(value) : value !== null && typeof value === 'object' ? pickString((value as Record<string, unknown>)['url']) : undefined;
        if (url && !urls.includes(url)) {
          urls.push(url);
          break;
        }
      }
    }
  }
  if (urls.length === 0 && Array.isArray(status['pics'])) {
    for (const item of status['pics']) {
      if (item === null || typeof item !== 'object') continue;
      const url = pickString((item as Record<string, unknown>)['url'], (item as Record<string, unknown>)['large']);
      if (url && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

/** 提取最高码率视频与封面。 */
function extractVideo(status: Record<string, unknown>): { url?: string; cover?: string } {
  const pageInfo = (status['page_info'] ?? {}) as Record<string, unknown>;
  const mediaInfo = (pageInfo['media_info'] ?? {}) as Record<string, unknown>;
  const playback = Array.isArray(mediaInfo['playback_list']) ? mediaInfo['playback_list'] : [];

  let bestUrl: string | undefined;
  let bestBitrate = -1;
  for (const item of playback) {
    if (item === null || typeof item !== 'object') continue;
    const playInfo = ((item as Record<string, unknown>)['play_info'] ?? {}) as Record<string, unknown>;
    const url = pickString(playInfo['url']);
    const bitrate = pickNumber(playInfo['bitrate']) ?? 0;
    if (url && bitrate >= bestBitrate) {
      bestUrl = url;
      bestBitrate = bitrate;
    }
  }
  if (!bestUrl) {
    for (const key of ['stream_url_hd', 'stream_url', 'url', 'mp4_720p_mp4', 'mp4_hd_url', 'mp4_sd_url']) {
      const value = mediaInfo[key] ?? pageInfo[key];
      const url = typeof value === 'string' ? pickString(value) : value !== null && typeof value === 'object' ? pickString((value as Record<string, unknown>)['url']) : undefined;
      if (url) {
        bestUrl = url;
        break;
      }
    }
  }
  let cover: string | undefined;
  for (const candidate of [pageInfo['page_pic'], mediaInfo['poster'], mediaInfo['pic_info'], mediaInfo['cover_img']]) {
    const url =
      typeof candidate === 'string'
        ? pickString(candidate)
        : candidate !== null && typeof candidate === 'object'
          ? pickString((candidate as Record<string, unknown>)['url'], (candidate as Record<string, unknown>)['pic_url'])
          : undefined;
    if (url) {
      cover = url;
      break;
    }
  }
  return { ...(bestUrl ? { url: bestUrl } : {}), ...(cover ? { cover } : {}) };
}

/** 是否有媒体。 */
function hasMedia(status: Record<string, unknown>): boolean {
  if (status['pic_infos'] || status['pics']) return true;
  const pageInfo = (status['page_info'] ?? {}) as Record<string, unknown>;
  const mediaInfo = (pageInfo['media_info'] ?? {}) as Record<string, unknown>;
  return pageInfo['type'] === 'video' || Object.keys(mediaInfo).length > 0;
}

/**
 * 解析一条微博链接。
 *
 * @param url - 已规范化链接。
 * @param ctx - 运行参数。
 * @param userCookie - 可选用户 Cookie。
 * @returns 统一结果。
 */
export async function resolveWeibo(url: string, ctx: ResolverContext, userCookie = ''): Promise<ResolvedLink> {
  const weiboId = extractWeiboId(url);
  if (!weiboId) throw new ResolveError('unsupported-url', `无法从微博链接提取微博 id：${url}`, { platform: 'weibo' });

  const userCookies = parseCookieHeader(userCookie);
  let cookies = Object.keys(userCookies).length > 0 ? userCookies : await fetchVisitorCookies(ctx);

  let payload: unknown;
  try {
    payload = await requestStatus(weiboId, cookies, ctx);
  } catch (error) {
    if (Object.keys(userCookies).length > 0) throw error;
    cookies = await fetchVisitorCookies(ctx);
    payload = await requestStatus(weiboId, cookies, ctx);
  }

  const status = payload as Record<string, unknown>;
  const display = !hasMedia(status) && status['retweeted_status'] !== null && typeof status['retweeted_status'] === 'object'
    ? (status['retweeted_status'] as Record<string, unknown>)
    : status;

  const text = cleanWeiboText(display['longTextContent_raw'] ?? display['longTextContent'] ?? (display['longText'] as Record<string, unknown> | undefined)?.['longTextContent_raw'] ?? display['text_raw'] ?? display['text']);
  const images = extractImages(display);
  const video = extractVideo(display);
  const media: MediaItem[] = images.map((imageUrl) => ({ kind: 'image', url: imageUrl }));
  if (video.url) media.unshift({ kind: 'video', url: video.url });

  if (media.length === 0 && !text) throw new ResolveError('parse-failed', '该微博没有可解析的正文或媒体', { platform: 'weibo' });

  const user = (status['user'] ?? display['user'] ?? {}) as Record<string, unknown>;
  const title = text?.split('\n')[0]?.slice(0, 120);

  return buildResult({
    platform: 'weibo',
    url: `https://weibo.com/${pickString(user['id']) ?? ''}/${pickString(status['mblogid'], status['id']) ?? weiboId}`,
    originalUrl: url,
    contentId: pickString(status['mblogid'], status['id']) ?? weiboId,
    type: video.url ? (images.length > 0 ? 'mixed' : 'video') : images.length > 0 ? 'images' : 'text',
    ...(title ? { title } : {}),
    ...(text ? { description: text } : {}),
    ...(pickString(user['screen_name'], user['name']) ? { author: pickString(user['screen_name'], user['name'])! } : {}),
    ...(pickString(user['avatar_hd'], user['profile_image_url']) ? { authorAvatar: pickString(user['avatar_hd'], user['profile_image_url'])! } : {}),
    ...(video.cover ?? images[0] ? { cover: video.cover ?? images[0] } : {}),
    ...(pickString(status['created_at']) ? { createdAt: pickString(status['created_at'])! } : {}),
    media,
    warnings: [],
  });

  /** 请求单条微博详情。 */
  async function requestStatus(id: string, cookieMap: Record<string, string>, context: ResolverContext): Promise<unknown> {
    const cookieHeader = Object.entries(cookieMap)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    const data = (await requestJson(`${STATUS_URL}?id=${encodeURIComponent(id)}`, {
      timeoutMs: context.timeoutMs,
      retries: context.retries,
      ...(context.signal ? { signal: context.signal } : {}),
      headers: { ...API_HEADERS, Cookie: cookieHeader },
    })) as Record<string, unknown>;
    if (data === null || typeof data !== 'object') throw new ResolveError('parse-failed', '微博详情返回格式异常', { platform: 'weibo' });
    if (data['ok'] === 0) throw new ResolveError('not-found', pickString(data['msg']) ?? '微博不存在或已删除', { platform: 'weibo' });
    if (!data['id'] && !data['mblogid']) throw new ResolveError('not-found', '微博详情缺少关键字段', { platform: 'weibo' });
    return data;
  }
}

/** 解析 Cookie 请求头。 */
export function parseCookieHeader(raw: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && value) cookies[name] = value;
  }
  return cookies;
}

/** 仅测试使用。 */
export const __test__ = { extractImages, extractVideo, cleanWeiboText, parseSetCookies, pickUrlList };