/**
 * B站解析器：view 元数据 + playurl 流清单（WBI 签名优先，失败回退免签）。
 *
 * @module dsh-plugin-link-resolver/resolvers/bilibili
 */

import { requestJson, requestText, DEFAULT_UA } from '../core/http.js';
import { buildResult, ResolveError } from '../core/result.js';
import type { MediaItem, ResolvedLink } from '../core/result.js';
import { signWbi } from '../sign/wbi.js';
import { pickNumber, pickString } from './common.js';
import type { ResolverContext } from './common.js';

/** B站请求头。 */
const BILI_HEADERS: Record<string, string> = {
  'User-Agent': DEFAULT_UA,
  Referer: 'https://www.bilibili.com/',
};

/** 组合请求头：默认头 + 可选登录 Cookie。 */
function biliHeaders(cookie?: string): Record<string, string> {
  return cookie ? { ...BILI_HEADERS, Cookie: cookie } : BILI_HEADERS;
}

/** qn → 画质标签。 */
const QUALITY_LABELS: Record<number, string> = {
  127: '8K',
  126: 'Dolby',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
};

/** 视频引用。 */
export interface BiliRef {
  bvid?: string;
  avid?: number;
  page: number;
}

/**
 * 从链接提取视频引用。
 *
 * @param url - 规范化链接。
 * @returns 引用信息。
 */
export function extractBiliRef(url: string): BiliRef | undefined {
  const bvid = /(BV[0-9A-Za-z]{10})/.exec(url)?.[1];
  const avidText = /\/video\/av(\d+)/i.exec(url)?.[1] ?? /(?:^|[^\w])av(\d+)(?![\w])/i.exec(url)?.[1];
  if (!bvid && !avidText) return undefined;
  let page = 1;
  try {
    page = Math.max(1, Number.parseInt(new URL(url).searchParams.get('p') ?? '1', 10) || 1);
  } catch {
    page = 1;
  }
  return { ...(bvid ? { bvid } : {}), ...(avidText ? { avid: Number.parseInt(avidText, 10) } : {}), page };
}

/** 缓存 WBI keys。 */
let wbiKeys: { imgKey: string; subKey: string; expiresAt: number } | undefined;

/** 获取 WBI keys（未登录也能拿到）。 */
async function getWbiKeys(ctx: ResolverContext, cookie?: string): Promise<{ imgKey: string; subKey: string } | undefined> {
  if (wbiKeys && wbiKeys.expiresAt > Date.now()) return wbiKeys;
  try {
    const payload = (await requestJson('https://api.bilibili.com/x/web-interface/nav', {
      timeoutMs: ctx.timeoutMs,
      retries: ctx.retries,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      headers: biliHeaders(cookie),
    })) as Record<string, unknown>;
    const data = (payload['data'] ?? {}) as Record<string, unknown>;
    const wbi = (data['wbi_img'] ?? {}) as Record<string, unknown>;
    const img = pickString(wbi['img_url'])?.split('/').pop()?.split('.')[0];
    const sub = pickString(wbi['sub_url'])?.split('/').pop()?.split('.')[0];
    if (!img || !sub) return undefined;
    wbiKeys = { imgKey: img, subKey: sub, expiresAt: Date.now() + 10 * 60 * 1000 };
    return wbiKeys;
  } catch {
    return undefined;
  }
}

/**
 * 解析视频引用，支持 b23.tv / bili2233.cn 短链（跟随一次跳转后再取 BV/av）。
 *
 * @param url - 原始链接。
 * @param ctx - 运行参数。
 * @param cookie - 可选 Cookie。
 * @returns 视频引用。
 */
export async function resolveBiliRef(
  url: string,
  ctx: ResolverContext,
  cookie?: string,
): Promise<BiliRef> {
  const direct = extractBiliRef(url);
  if (direct) return direct;

  let finalUrl: string;
  try {
    const response = await requestText(url, {
      timeoutMs: ctx.timeoutMs,
      retries: ctx.retries,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      headers: biliHeaders(cookie),
    });
    finalUrl = response.url;
  } catch (error) {
    throw new ResolveError('network', `B站短链跳转失败：${error instanceof Error ? error.message : String(error)}`, {
      platform: 'bilibili',
      retryable: true,
      cause: error,
    });
  }

  const followed = extractBiliRef(finalUrl);
  if (!followed) {
    throw new ResolveError('unsupported-url', `B站短链未跳转到视频页：${finalUrl}`, { platform: 'bilibili' });
  }
  return followed;
}

/**
 * 获取视频信息。
 *
 * @param ref - 视频引用。
 * @param ctx - 运行参数。
 * @returns `data` 对象。
 */
export async function fetchVideoInfo(ref: BiliRef, ctx: ResolverContext, cookie?: string): Promise<Record<string, unknown>> {
  const base: Record<string, string> = {};
  if (ref.bvid) base['bvid'] = ref.bvid;
  else if (ref.avid !== undefined) base['aid'] = String(ref.avid);
  const keys = await getWbiKeys(ctx, cookie);

  const tryRequest = async (url: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const payload = (await requestJson(url, {
        timeoutMs: ctx.timeoutMs,
        retries: ctx.retries,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        headers: biliHeaders(cookie),
      })) as Record<string, unknown>;
      if (payload['code'] !== 0) return undefined;
      const data = payload['data'];
      return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };

  if (keys) {
    const query = signWbi(base, keys.imgKey, keys.subKey);
    const signed = await tryRequest(`https://api.bilibili.com/x/web-interface/wbi/view?${query}`);
    if (signed) return signed;
  }
  const fallbackQuery = new URLSearchParams(base).toString();
  const plain = await tryRequest(`https://api.bilibili.com/x/web-interface/view?${fallbackQuery}`);
  if (plain) return plain;
  throw new ResolveError('not-found', 'B站视频不存在、已删除或不可访问', { platform: 'bilibili' });
}

/** 取分 P 的 cid。 */
function pickCid(info: Record<string, unknown>, page: number): number | undefined {
  const pages = Array.isArray(info['pages']) ? info['pages'] : [];
  const target = pages[page - 1];
  if (target !== null && typeof target === 'object') return pickNumber((target as Record<string, unknown>)['cid']);
  return pickNumber(info['cid']);
}

/**
 * 获取播放流。
 *
 * @param ref - 视频引用。
 * @param cid - 分 P cid。
 * @param ctx - 运行参数。
 * @param fnval - 流格式（4048 = DASH，1 = durl）。
 * @returns `data` 对象。
 */
export async function fetchPlayInfo(ref: BiliRef, cid: number, ctx: ResolverContext, fnval = 4048, cookie?: string): Promise<Record<string, unknown>> {
  const base: Record<string, string> = {
    cid: String(cid),
    qn: '120',
    fnval: String(fnval),
    fnver: '0',
    fourk: '1',
  };
  if (ref.bvid) base['bvid'] = ref.bvid;
  else if (ref.avid !== undefined) base['aid'] = String(ref.avid);
  const keys = await getWbiKeys(ctx, cookie);
  const tryRequest = async (url: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const payload = (await requestJson(url, {
        timeoutMs: ctx.timeoutMs,
        retries: ctx.retries,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        headers: biliHeaders(cookie),
      })) as Record<string, unknown>;
      if (payload['code'] !== 0) return undefined;
      const data = payload['data'];
      return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };

  if (keys) {
    const query = signWbi(base, keys.imgKey, keys.subKey);
    const signed = await tryRequest(`https://api.bilibili.com/x/player/wbi/playurl?${query}`);
    if (signed) return signed;
  }
  const plain = await tryRequest(`https://api.bilibili.com/x/player/playurl?${new URLSearchParams(base).toString()}`);
  if (plain) return plain;
  throw new ResolveError('parse-failed', 'B站播放地址获取失败（可能需要登录 Cookie）', { platform: 'bilibili' });
}

/** 从 DASH 数据构建媒体清单。 */
export function buildDashMedia(play: Record<string, unknown>): MediaItem[] {
  const dash = (play['dash'] ?? {}) as Record<string, unknown>;
  const videos = Array.isArray(dash['video']) ? dash['video'] : [];
  const best = new Map<number, { item: MediaItem; bandwidth: number }>();

  for (const raw of videos) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const id = pickNumber(entry['id']) ?? 0;
    const url = pickString(entry['baseUrl'], entry['base_url']);
    if (!url) continue;
    const bandwidth = pickNumber(entry['bandwidth']) ?? 0;
    const existing = best.get(id);
    if (existing && existing.bandwidth >= bandwidth) continue;
    const codecText = pickString(entry['codecs']) ?? '';
    const codec = codecText.startsWith('av01') ? 'av1' : /hev1|hvc1/i.test(codecText) ? 'hevc' : 'avc';
    best.set(id, {
      bandwidth,
      item: {
        kind: 'video',
        url,
        candidates: [url, ...(Array.isArray(entry['backupUrl']) ? (entry['backupUrl'] as string[]) : [])].filter((value, index, all) => typeof value === 'string' && all.indexOf(value) === index),
        ...(pickNumber(entry['width']) ? { width: pickNumber(entry['width']) } : {}),
        ...(pickNumber(entry['height']) ? { height: pickNumber(entry['height']) } : {}),
        quality: { label: QUALITY_LABELS[id] ?? `qn${id}`, ...(pickNumber(entry['height']) ? { height: pickNumber(entry['height']) } : {}), codec },
      },
    });
  }
  return [...best.values()].map((entry) => entry.item).sort((a, b) => (b.quality?.height ?? 0) - (a.quality?.height ?? 0));
}

/**
 * 解析 B站链接。
 *
 * @param url - 规范化链接。
 * @param ctx - 运行参数。
 * @returns 统一结果。
 */
export async function resolveBilibili(url: string, ctx: ResolverContext & { biliCookie?: string }): Promise<ResolvedLink> {
  const cookie = ctx.biliCookie;
  const ref = await resolveBiliRef(url, ctx, cookie);
  const info = await fetchVideoInfo(ref, ctx, cookie);
  const bvid = pickString(info['bvid']) ?? ref.bvid ?? '';
  const pages = Array.isArray(info['pages']) ? info['pages'] : [];
  const pageIndex = Math.min(ref.page, Math.max(pages.length, 1));
  const pageInfo = (pages[pageIndex - 1] ?? {}) as Record<string, unknown>;
  const cid = pickCid(info, pageIndex);
  if (!cid) throw new ResolveError('parse-failed', 'B站视频缺少 cid', { platform: 'bilibili' });

  const play = await fetchPlayInfo(ref, cid, ctx, 4048, cookie);
  const media = buildDashMedia(play);
  const owner = (info['owner'] ?? {}) as Record<string, unknown>;
  const stat = (info['stat'] ?? {}) as Record<string, unknown>;
  const accept = Array.isArray(play['accept_quality']) ? (play['accept_quality'] as number[]) : [];
  const maxQn = accept.length > 0 ? Math.max(...accept) : undefined;
  const warnings: string[] = [];
  if (maxQn !== undefined && maxQn <= 32) warnings.push('未登录仅返回 480P 及以下画质');

  const title = pickString(pageInfo['part'], info['title']) ?? '（无标题）';
  return buildResult({
    platform: 'bilibili',
    url: `https://www.bilibili.com/video/${bvid}${pageIndex > 1 ? `?p=${pageIndex}` : ''}`,
    originalUrl: url,
    contentId: bvid,
    type: 'video',
    title: pageIndex > 1 ? `${pickString(info['title']) ?? ''} · ${title}` : title,
    ...(pickString(info['desc']) ? { description: pickString(info['desc'])! } : {}),
    ...(pickString(owner['name']) ? { author: pickString(owner['name'])! } : {}),
    ...(pickString(owner['face']) ? { authorAvatar: pickString(owner['face'])! } : {}),
    ...(pickString(info['pic']) ? { cover: pickString(info['pic'])! } : {}),
    durationSec: pickNumber(pageInfo['duration'], info['duration']),
    media,
    stats: {
      ...(pickNumber(stat['view']) ? { views: pickNumber(stat['view']) } : {}),
      ...(pickNumber(stat['like']) ? { likes: pickNumber(stat['like']) } : {}),
      ...(pickNumber(stat['coin']) ? { coins: pickNumber(stat['coin']) } : {}),
      ...(pickNumber(stat['share']) ? { shares: pickNumber(stat['share']) } : {}),
      ...(pickNumber(stat['reply']) ? { comments: pickNumber(stat['reply']) } : {}),
    },
    warnings,
  });
}

/** 仅测试使用。 */
export const __test__ = { buildDashMedia, extractBiliRef, resolveBiliRef, QUALITY_LABELS, requestText };
/**
 * 下载 B站视频（DASH 音视频分离 → ffmpeg 合并；无 ffmpeg 时回退 durl 单文件）。
 *
 * @param url - 规范化链接。
 * @param options - 下载参数。
 * @returns 本地文件信息。
 */
export async function downloadBilibili(
  url: string,
  options: { ctx: ResolverContext; maxHeight?: number; maxBytes?: number; timeoutMs: number; signal?: AbortSignal; outputDir: string; ffmpegPath?: string; fileName?: string; cookie?: string },
): Promise<import('../core/result.js').LocalFile> {
  const { ctx, maxHeight = 1080, maxBytes, timeoutMs, signal, outputDir, ffmpegPath = 'ffmpeg', cookie } = options;
  const ref = await resolveBiliRef(url, ctx, cookie);

  const info = await fetchVideoInfo(ref, ctx, cookie);
  const cid = pickCid(info, ref.page);
  if (!cid) throw new ResolveError('parse-failed', 'B站视频缺少 cid', { platform: 'bilibili' });
  const bvid = pickString(info['bvid']) ?? ref.bvid ?? 'video';

  const { ffmpegAvailable, mergeAv } = await import('../media/ffmpeg.js');
  const { downloadFile } = await import('../media/download.js');
  const { mkdir, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');

  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, options.fileName ?? `${bvid}_${cid}_${Date.now()}.mp4`);

  if (await ffmpegAvailable(ffmpegPath)) {
    const play = await fetchPlayInfo(ref, cid, ctx, 4048, cookie);
    const media = buildDashMedia(play);
    const candidate = media.find((item) => (item.quality?.height ?? 0) <= maxHeight) ?? media[media.length - 1];
    if (!candidate) throw new ResolveError('parse-failed', 'B站未返回可用视频流', { platform: 'bilibili' });

    const dash = (play['dash'] ?? {}) as Record<string, unknown>;
    const audios = Array.isArray(dash['audio']) ? dash['audio'] : [];
    let audioUrl: string | undefined;
    let bestBandwidth = -1;
    for (const raw of audios) {
      if (raw === null || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const bandwidth = pickNumber(entry['bandwidth']) ?? 0;
      const urlValue = pickString(entry['baseUrl'], entry['base_url']);
      if (urlValue && bandwidth > bestBandwidth) {
        audioUrl = urlValue;
        bestBandwidth = bandwidth;
      }
    }

    const videoPath = `${outputPath}.video.m4s`;
    const audioPath = `${outputPath}.audio.m4s`;
    try {
      await downloadFile(candidate.url, videoPath, { timeoutMs, ...(maxBytes ? { maxBytes } : {}), ...(signal ? { signal } : {}), headers: biliHeaders(cookie) });
      if (audioUrl) {
        await downloadFile(audioUrl, audioPath, { timeoutMs, ...(maxBytes ? { maxBytes } : {}), ...(signal ? { signal } : {}), headers: biliHeaders(cookie) });
        await mergeAv(videoPath, audioPath, outputPath, { executable: ffmpegPath, ...(signal ? { signal } : {}), timeoutMs });
      } else {
        const { rename } = await import('node:fs/promises');
        await rename(videoPath, outputPath);
      }
    } finally {
      await rm(videoPath, { force: true }).catch(() => {});
      await rm(audioPath, { force: true }).catch(() => {});
    }
  } else {
    const play = await fetchPlayInfo(ref, cid, ctx, 1, cookie);
    const list = Array.isArray(play['durl']) ? play['durl'] : [];
    const first = list[0];
    const directUrl = first !== null && typeof first === 'object' ? pickString((first as Record<string, unknown>)['url']) : undefined;
    if (!directUrl) throw new ResolveError('parse-failed', 'B站未返回可下载地址（缺少 ffmpeg 且无 durl 回退）', { platform: 'bilibili' });
    await downloadFile(directUrl, outputPath, { timeoutMs, ...(maxBytes ? { maxBytes } : {}), ...(signal ? { signal } : {}), headers: biliHeaders(cookie) });
  }

  const { stat } = await import('node:fs/promises');
  const infoStat = await stat(outputPath);
  return { path: outputPath, bytes: infoStat.size, kind: 'video', mimeType: 'video/mp4' };
}
