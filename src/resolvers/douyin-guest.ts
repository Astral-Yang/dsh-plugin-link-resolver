/**
 * 抖音游客接口客户端：ttwid/UIFID 游客身份 + a_bogus + WebSign。
 *
 * 移植自参考实现 `core/douyin/guest_api.py`，用于免登录读取公开作品详情。
 *
 * @module dsh-plugin-link-resolver/resolvers/douyin-guest
 */

import { requestText } from '../core/http.js';
import { ResolveError } from '../core/result.js';
import { ABogus, DEFAULT_DOUYIN_UA, generateFingerprint } from '../sign/abogus.js';
import { encodePairs, sign } from '../sign/websign.js';
import type { ResolverContext } from './common.js';

/** 作品详情接口。 */
const DETAIL_URL = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';

/** 游客身份。 */
interface GuestSession {
  ttwid: string;
  uifid: string;
}

/** 会话缓存时间（毫秒）。 */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** msToken 可用字符。 */
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * 生成随机 msToken。
 *
 * @param length - 长度。
 * @returns 随机串。
 */
function randomToken(length = 184): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
  return out;
}

/** 解析 Set-Cookie 为字典。 */
function parseCookies(headers: Headers): Record<string, string> {
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

/** 抖音游客客户端（按插件实例复用会话）。 */
export class DouyinGuestClient {
  private cached: { session: GuestSession; expiresAt: number } | undefined;

  /**
   * 获取游客身份（ttwid + UIFID_TEMP）。
   *
   * @param ctx - 运行参数。
   * @param refresh - 是否强制刷新。
   * @returns 游客身份。
   */
  async getSession(ctx: ResolverContext, refresh = false): Promise<GuestSession> {
    if (!refresh && this.cached && this.cached.expiresAt > Date.now()) return this.cached.session;

    const response = await requestText('https://live.douyin.com/', {
      timeoutMs: ctx.timeoutMs,
      retries: ctx.retries,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      headers: {
        'User-Agent': DEFAULT_DOUYIN_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    const cookies = parseCookies(response.headers);
    const ttwid = cookies['ttwid'];
    const uifid = cookies['UIFID_TEMP'];
    if (!ttwid || !uifid) {
      throw new ResolveError('auth-required', '抖音游客身份获取失败（缺少 ttwid 或 UIFID_TEMP）', {
        platform: 'douyin',
        retryable: true,
      });
    }
    const session = { ttwid, uifid };
    this.cached = { session, expiresAt: Date.now() + SESSION_TTL_MS };
    return session;
  }

  /**
   * 请求作品详情。
   *
   * @param awemeId - 作品 id。
   * @param ctx - 运行参数。
   * @param sourceUrl - 原始分享链接（用于 Referer）。
   * @returns `aweme_detail` 对象。
   */
  async fetchDetail(awemeId: string, ctx: ResolverContext, sourceUrl?: string): Promise<Record<string, unknown>> {
    let lastError = 'empty response';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await this.getSession(ctx, attempt > 0);
      const request = this.buildRequest(awemeId, session, sourceUrl);
      try {
        const payload = (await requestResponse(request.url, request.headers, ctx)) as Record<string, unknown>;
        const detail = payload['aweme_detail'];
        if (detail !== null && typeof detail === 'object' && Object.keys(detail as object).length > 0) {
          return detail as Record<string, unknown>;
        }
        lastError = `missing aweme_detail (status_code=${String(payload['status_code'])})`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new ResolveError('parse-failed', `抖音签名接口失败：${lastError}`, { platform: 'douyin' });
  }

  /** 构造带签名的请求。 */
  private buildRequest(awemeId: string, session: GuestSession, sourceUrl?: string): { url: string; headers: Record<string, string> } {
    const params: Array<[string, string]> = [
      ['device_platform', 'webapp'],
      ['aid', '6383'],
      ['channel', 'channel_pc_web'],
      ['pc_client_type', '1'],
      ['publish_video_strategy_type', '2'],
      ['pc_libra_divert', 'Windows'],
      ['version_code', '290100'],
      ['version_name', '29.1.0'],
      ['cookie_enabled', 'true'],
      ['screen_width', '1920'],
      ['screen_height', '1080'],
      ['browser_language', 'zh-CN'],
      ['browser_platform', 'Win32'],
      ['browser_name', 'Edge'],
      ['browser_version', '130.0.0.0'],
      ['browser_online', 'true'],
      ['engine_name', 'Blink'],
      ['engine_version', '130.0.0.0'],
      ['os_name', 'Windows'],
      ['os_version', '10'],
      ['cpu_core_num', '12'],
      ['device_memory', '8'],
      ['platform', 'PC'],
      ['downlink', '10'],
      ['effective_type', '4g'],
      ['round_trip_time', '100'],
      ['msToken', randomToken()],
      ['aweme_id', awemeId],
      ['uifid', session.uifid],
    ];

    const unsignedQuery = encodePairs(params);
    const abogus = new ABogus({ userAgent: DEFAULT_DOUYIN_UA, fingerprint: generateFingerprint() });
    const signature = abogus.generate(unsignedQuery, '').signature;
    const queryWithAbogus = encodePairs([...params, ['a_bogus', signature]]);
    const signed = sign(queryWithAbogus, session.uifid);

    const referer = sourceUrl && /(^|\.)douyin\.com$/i.test(new URL(sourceUrl).hostname)
      ? sourceUrl
      : `https://www.douyin.com/video/${awemeId}`;

    return {
      url: `${DETAIL_URL}?${signed.query}`,
      headers: {
        'User-Agent': DEFAULT_DOUYIN_UA,
        Cookie: `ttwid=${session.ttwid}; UIFID_TEMP=${session.uifid};`,
        Referer: referer,
        uifid: session.uifid,
        'x-secsdk-web-signature': signed.signature,
        'x-secsdk-web-expire': signed.timestamp,
        Accept: 'application/json, text/plain, */*',
      },
    };
  }
}

/** 发起请求并解析 JSON。 */
async function requestResponse(url: string, headers: Record<string, string>, ctx: ResolverContext): Promise<unknown> {
  const response = await requestText(url, {
    timeoutMs: ctx.timeoutMs,
    retries: ctx.retries,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    headers,
  });
  if (response.text.trim().length === 0) throw new ResolveError('parse-failed', '抖音详情接口返回空响应', { platform: 'douyin' });
  try {
    return JSON.parse(response.text) as unknown;
  } catch (error) {
    throw new ResolveError('parse-failed', '抖音详情接口返回非 JSON', { platform: 'douyin', cause: error });
  }
}