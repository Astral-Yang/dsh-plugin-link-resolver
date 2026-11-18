/**
 * 抖音解析器（免签名路径）：iteminfo / slidesinfo / 分享页 `_ROUTER_DATA`。
 *
 * 需要 a_bogus 签名的 `aweme/detail` 接口不在本阶段范围内（P3 再补），
 * 因此该解析器只依赖公开分享页与 iesdouyin 的免签接口。
 *
 * @module dsh-plugin-link-resolver/resolvers/douyin
 */

import { requestJson, requestText, DEFAULT_UA } from '../core/http.js';
import { buildResult, ResolveError } from '../core/result.js';
import type { MediaItem, ResolvedLink } from '../core/result.js';
import { normalizeDouyinUrls, pickNumber, pickString, pickUrlList } from './common.js';
import type { ResolverContext } from './common.js';
import { DouyinGuestClient } from './douyin-guest.js';

/** 进程内复用的游客客户端（会话 TTL 由内部管理）。 */
const guestClient = new DouyinGuestClient();

/** iOS UA（分享页通常返回移动版结构）。 */
const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1 Edg/132.0.0.0';

/**
 * 从链接提取作品 id 与类型。
 *
 * @param url - 规范化链接。
 * @returns 作品 id 与类型（video/note/slides）。
 */
export function extractDouyinRef(url: string): { id: string; type?: string } | undefined {
  const patterns: Array<{ re: RegExp; type?: string }> = [
    { re: /douyin\.com\/(?:video|note)\/(?<id>\d+)/i },
    { re: /iesdouyin\.com\/share\/(?<type>slides|video|note)\/(?<id>\d+)/i },
    { re: /m\.douyin\.com\/share\/(?<type>slides|video|note)\/(?<id>\d+)/i },
    { re: /jingxuan\.douyin\.com\/m\/(?<type>slides|video|note)\/(?<id>\d+)/i },
  ];
  for (const { re } of patterns) {
    const match = re.exec(url);
    if (match?.groups?.['id']) {
      return { id: match.groups['id'], ...(match.groups['type'] ? { type: match.groups['type'] } : {}) };
    }
  }
  const queryId = /[?&](?:modal_id|aweme_id|item_id|video_id|note_id)=(\d+)/i.exec(url)?.[1];
  return queryId ? { id: queryId } : undefined;
}

/** 从 item 结构映射结果。 */
export function mapDouyinItem(item: Record<string, unknown>, url: string, id: string): ResolvedLink {
  const author = (item['author'] ?? {}) as Record<string, unknown>;
  const video = (item['video'] ?? {}) as Record<string, unknown>;
  const media: MediaItem[] = [];

  // 图集：images[]，每项可能带动态视频
  const images = Array.isArray(item['images']) ? item['images'] : [];
  for (const raw of images) {
    if (raw === null || typeof raw !== 'object') continue;
    const image = raw as Record<string, unknown>;
    const imageUrls = pickUrlList(image['url_list']);
    if (imageUrls.length === 0) continue;
    const index = media.length;
    media.push({ kind: 'image', url: imageUrls[0]!, candidates: imageUrls });
    const imageVideo = (image['video'] ?? {}) as Record<string, unknown>;
    const dynamic = normalizeDouyinUrls([
      ...pickUrlList((imageVideo['play_addr'] as Record<string, unknown> | undefined)?.['url_list']),
      ...pickUrlList((imageVideo['play_addr_h264'] as Record<string, unknown> | undefined)?.['url_list']),
    ]);
    if (dynamic.length > 0) media.push({ kind: 'livephoto-video', url: dynamic[0]!, candidates: dynamic, pairedWith: index });
  }

  if (media.length === 0) {
    const playAddr = (video['play_addr'] ?? {}) as Record<string, unknown>;
    const videoUrls = normalizeDouyinUrls([
      ...pickUrlList(playAddr['url_list']),
      ...pickUrlList((video['play_addr_h264'] as Record<string, unknown> | undefined)?.['url_list']),
      ...pickUrlList((video['play_addr_h265'] as Record<string, unknown> | undefined)?.['url_list']),
    ]);
    if (videoUrls.length > 0) media.push({ kind: 'video', url: videoUrls[0]!, candidates: videoUrls });
  }

  const cover = pickUrlList((video['cover'] as Record<string, unknown> | undefined)?.['url_list'])[0] ??
    pickUrlList((video['origin_cover'] as Record<string, unknown> | undefined)?.['url_list'])[0];

  const videoCount = media.filter((m) => m.kind === 'video').length;
  const imageCount = media.filter((m) => m.kind === 'image').length;
  const type = videoCount > 0 && imageCount > 0 ? 'mixed' : videoCount > 0 ? 'video' : 'images';
  const desc = pickString(item['desc']);
  const stats = (item['statistics'] ?? {}) as Record<string, unknown>;

  return buildResult({
    platform: 'douyin',
    url: `https://www.douyin.com/video/${id}`,
    originalUrl: url,
    contentId: pickString(item['aweme_id']) ?? id,
    type,
    ...(desc ? { title: desc.split('\n')[0]!.slice(0, 120) } : {}),
    ...(desc ? { description: desc } : {}),
    ...(pickString(author['nickname']) ? { author: pickString(author['nickname'])! } : {}),
    ...(pickString((author['avatar_thumb'] as Record<string, unknown> | undefined)?.['url_list'] ? pickUrlList((author['avatar_thumb'] as Record<string, unknown>)['url_list'])[0] : undefined)
      ? { authorAvatar: pickUrlList((author['avatar_thumb'] as Record<string, unknown>)['url_list'])[0]! }
      : {}),
    ...(cover ? { cover } : {}),
    ...(pickNumber(item['duration'], video['duration']) ? { durationSec: Math.round((pickNumber(item['duration'], video['duration']) ?? 0) / 1000) } : {}),
    media,
    stats: {
      ...(pickNumber(stats['digg_count']) ? { likes: pickNumber(stats['digg_count']) } : {}),
      ...(pickNumber(stats['comment_count']) ? { comments: pickNumber(stats['comment_count']) } : {}),
      ...(pickNumber(stats['share_count']) ? { shares: pickNumber(stats['share_count']) } : {}),
      ...(pickNumber(stats['play_count']) ? { views: pickNumber(stats['play_count']) } : {}),
    },
    warnings: [],
  });
}

/** 从分享页 HTML 中提取 item。 */
export function parseRouterData(html: string, id: string): Record<string, unknown> | undefined {
  const match = /window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s.exec(html);
  if (!match?.[1]) return undefined;
  try {
    const data = JSON.parse(match[1]) as Record<string, unknown>;
    const loader = (data['loaderData'] ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(loader)) {
      const page = (loader[key] ?? {}) as Record<string, unknown>;
      const info = (page['videoInfoRes'] ?? {}) as Record<string, unknown>;
      const list = Array.isArray(info['item_list']) ? info['item_list'] : [];
      const first = list[0];
      if (first !== null && typeof first === 'object') return first as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * 解析一条抖音链接。
 *
 * @param url - 已规范化链接。
 * @param ctx - 运行参数。
 * @returns 统一结果。
 */
export async function resolveDouyin(url: string, ctx: ResolverContext): Promise<ResolvedLink> {
  // 短链先展开（requestText 会自动跟随跳转并返回最终 URL）
  let target = url;
  if (/[?&]?v\.douyin\.com|jx\.douyin\.com/i.test(url)) {
    const resolved = await requestText(url, {
      timeoutMs: ctx.timeoutMs,
      retries: ctx.retries,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      headers: { 'User-Agent': IOS_UA },
    }).catch(() => undefined);
    if (resolved && resolved.url) target = resolved.url;
  }

  const ref = extractDouyinRef(target) ?? extractDouyinRef(url);
  if (!ref) throw new ResolveError('unsupported-url', `无法从抖音链接提取作品 id：${url}`, { platform: 'douyin' });

  // 1) 免签 iteminfo
  try {
    const data = (await requestJson(
      `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${encodeURIComponent(ref.id)}`,
      {
        timeoutMs: ctx.timeoutMs,
        retries: ctx.retries,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        headers: { 'User-Agent': IOS_UA, Referer: 'https://www.douyin.com/' },
      },
    )) as Record<string, unknown>;
    const list = (data['item_list'] ?? data['aweme_details'] ?? []) as unknown[];
    const first = list[0];
    if (first !== null && typeof first === 'object') return mapDouyinItem(first as Record<string, unknown>, url, ref.id);
  } catch {
    // 落到分享页
  }

  // 2) 分享页 `_ROUTER_DATA`
  const shareUrl = `https://www.iesdouyin.com/share/${ref.type ?? 'video'}/${ref.id}`;
  const page = await requestText(shareUrl, {
    timeoutMs: ctx.timeoutMs,
    retries: ctx.retries,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    headers: { 'User-Agent': IOS_UA, Referer: 'https://www.douyin.com/' },
  });
  const item = parseRouterData(page.text, ref.id);

  // 3) 签名游客接口（a_bogus + WebSign）
  try {
    const detail = await guestClient.fetchDetail(ref.id, ctx, url);
    return mapDouyinItem(detail, url, ref.id);
  } catch (error) {
    if (item) return mapDouyinItem(item, url, ref.id);
    const reason = error instanceof Error ? error.message : '签名接口失败';
    throw new ResolveError('parse-failed', `抖音解析失败：分享页无数据且签名接口不可用（${reason}）`, { platform: 'douyin' });
  }
}

/** 仅测试使用。 */
export const __test__ = { mapDouyinItem, parseRouterData, DEFAULT_UA };