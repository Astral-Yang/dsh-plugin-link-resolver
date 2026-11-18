/**
 * 平台解析器分发。
 *
 * @module dsh-plugin-link-resolver/resolvers
 */

import type { PlatformId } from '../core/registry.js';
import { ResolveError } from '../core/result.js';
import type { ResolvedLink } from '../core/result.js';
import type { ResolverContext } from './common.js';
import { resolveBilibili } from './bilibili.js';
import { resolveDouyin } from './douyin.js';
import { resolveGeneric } from './generic.js';
import { resolveTwitter } from './twitter.js';
import { resolveWeibo } from './weibo.js';
import { resolveXiaohongshu } from './xiaohongshu.js';
import { resolveYoutube } from './youtube.js';

/** 分发参数。 */
export interface ResolveOptions extends ResolverContext {
  /** 微博用户 Cookie（可选）。 */
  weiboCookie?: string;
  /** B站 Cookie（可选，提升画质上限）。 */
  biliCookie?: string;
  /** 小红书用户 Cookie（可选）。 */
  xhsCookie?: string;
  /** 小红书是否优先原图。 */
  xhsPreferCiPng?: boolean;
  /** yt-dlp 路径。 */
  ytdlpPath?: string;
  /** 通用站点白名单。 */
  genericDomains?: readonly string[];
}

/** 已接入解析器的平台。 */
export const IMPLEMENTED: ReadonlySet<PlatformId> = new Set<PlatformId>(['bilibili', 'twitter', 'xiaohongshu', 'weibo', 'douyin', 'youtube', 'generic']);

/**
 * 按平台分发解析。
 *
 * @param platform - 平台 id。
 * @param url - 规范化链接。
 * @param options - 运行参数。
 * @returns 统一结果。
 */
export async function resolveByPlatform(platform: PlatformId, url: string, options: ResolveOptions): Promise<ResolvedLink> {
  switch (platform) {
    case 'bilibili':
      return resolveBilibili(url, options);
    case 'twitter':
      return resolveTwitter(url, options);
    case 'xiaohongshu':
      return resolveXiaohongshu(url, options, options.xhsCookie ?? '', options.xhsPreferCiPng ?? true);
    case 'weibo':
      return resolveWeibo(url, options, options.weiboCookie ?? '');
    case 'douyin':
      return resolveDouyin(url, options);
    case 'youtube':
      return resolveYoutube(url, options, options.ytdlpPath ?? 'yt-dlp');
    case 'generic':
      return resolveGeneric(url, options, {
        executable: options.ytdlpPath ?? 'yt-dlp',
        ...(options.genericDomains ? { domains: options.genericDomains } : {}),
      });
    default:
      throw new ResolveError('unsupported-url', `${platform} 解析器尚未接入（P1 范围外）`, { platform });
  }
}