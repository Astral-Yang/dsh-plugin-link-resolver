/**
 * X / Twitter 解析器（基于 fxtwitter 公共接口）。
 *
 * @module dsh-plugin-link-resolver/resolvers/twitter
 */

import { requestJson } from '../core/http.js';
import { buildResult, ResolveError } from '../core/result.js';
import type { MediaItem, ResolvedLink } from '../core/result.js';
import { pickString } from './common.js';
import type { ResolverContext } from './common.js';

/** fxtwitter 接口响应中与解析相关的字段。 */
interface FxTweetPayload {
  tweet?: {
    text?: string;
    created_at?: string;
    author?: { name?: string; screen_name?: string; avatar_url?: string };
    media?: {
      photos?: Array<{ url?: string }>;
      videos?: Array<{ url?: string }>;
      all?: Array<{ type?: string; url?: string }>;
      external?: { type?: string; url?: string };
    };
    article?: {
      cover_media?: { media_info?: { original_img_url?: string } };
      media_entities?: Array<{ media_info?: { original_img_url?: string } }>;
    };
  };
  status?: {
    text?: string;
    author?: { name?: string; screen_name?: string };
    media?: Record<string, unknown>;
  };
}

/**
 * 提取推文 id。
 *
 * @param url - 规范化链接。
 * @returns tweet id。
 */
export function extractTweetId(url: string): string | undefined {
  return /\/status(?:es)?\/(?<id>\d+)/i.exec(url)?.groups?.['id'];
}

/**
 * 解析一条 X 链接。
 *
 * @param url - 已规范化的链接。
 * @param ctx - 运行参数。
 * @returns 统一结果。
 */
export async function resolveTwitter(url: string, ctx: ResolverContext): Promise<ResolvedLink> {
  const tweetId = extractTweetId(url);
  if (!tweetId) throw new ResolveError('unsupported-url', `无法从链接提取推文 id：${url}`, { platform: 'twitter' });

  const payload = (await requestJson(`https://api.fxtwitter.com/status/${tweetId}`, {
    timeoutMs: ctx.timeoutMs,
    retries: ctx.retries,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    headers: { Referer: 'https://x.com/' },
  })) as FxTweetPayload;

  return mapTweet(payload, url, tweetId);
}

/**
 * 把 fxtwitter 响应映射为统一结果（纯函数，便于离线测试）。
 *
 * @param payload - 接口响应。
 * @param url - 规范化链接。
 * @param tweetId - 推文 id。
 * @returns 统一结果。
 */
export function mapTweet(payload: FxTweetPayload, url: string, tweetId: string): ResolvedLink {
  const tweet = payload.tweet ?? payload.status;
  if (!tweet || typeof tweet !== 'object') {
    throw new ResolveError('not-found', '该推文不存在、已被删除或不可访问', { platform: 'twitter' });
  }

  const media: MediaItem[] = [];
  const mediaBlock = (payload.tweet?.media ?? {}) as NonNullable<FxTweetPayload['tweet']>['media'];

  const pushUnique = (url: string | undefined, kind: 'image' | 'video'): void => {
    if (!url) return;
    if (media.some((item) => item.url === url)) return;
    media.push({ kind, url });
  };

  for (const photo of mediaBlock?.photos ?? []) pushUnique(pickString(photo?.url), 'image');
  for (const video of mediaBlock?.videos ?? []) pushUnique(pickString(video?.url), 'video');
  for (const item of mediaBlock?.all ?? []) {
    const type = (item?.type ?? '').toLowerCase();
    pushUnique(pickString(item?.url), type === 'photo' ? 'image' : 'video');
  }
  const external = mediaBlock?.external;
  if (external && ['video', 'gif'].includes((external.type ?? '').toLowerCase())) {
    pushUnique(pickString(external.url), 'video');
  }
  const article = payload.tweet?.article;
  if (article) {
    for (const entity of [article.cover_media, ...(article.media_entities ?? [])]) {
      pushUnique(pickString(entity?.media_info?.original_img_url), 'image');
    }
  }

  const authorName = pickString(payload.tweet?.author?.name);
  const screenName = pickString(payload.tweet?.author?.screen_name);
  const author = authorName && screenName ? `${authorName}(@${screenName})` : (authorName ?? screenName);

  const videoCount = media.filter((item) => item.kind === 'video').length;
  const imageCount = media.length - videoCount;
  const type = media.length === 0 ? 'text' : videoCount > 0 && imageCount > 0 ? 'mixed' : videoCount > 0 ? 'video' : 'images';

  return buildResult({
    platform: 'twitter',
    url,
    originalUrl: url,
    contentId: tweetId,
    type,
    ...(pickString(tweet.text) ? { title: pickString(tweet.text)!.split('\n')[0]!.slice(0, 120) } : {}),
    ...(pickString(tweet.text) ? { description: pickString(tweet.text) } : {}),
    ...(author ? { author } : {}),
    ...(pickString(payload.tweet?.author?.avatar_url) ? { authorAvatar: pickString(payload.tweet?.author?.avatar_url)! } : {}),
    media,
    ...(pickString(payload.tweet?.created_at) ? { createdAt: pickString(payload.tweet?.created_at)! } : {}),
    warnings: [],
  });
}