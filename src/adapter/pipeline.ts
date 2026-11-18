/**
 * 链接处理管线：解析 → 下载 → 交付。
 *
 * 工具调用（模型路径）与自动处理（跳过模型）共用这里，保证两条路径行为一致。
 *
 * @module dsh-plugin-link-resolver/adapter/pipeline
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';

import { downloadFile } from '../media/download.js';
import { detectPlatform, PLATFORM_BY_ID } from '../core/registry.js';
import { toErrorPayload } from '../core/result.js';
import type { ResolvedLink } from '../core/result.js';
import { normalizeUrl } from '../core/url.js';
import { downloadBilibili } from '../resolvers/bilibili.js';
import { downloadGeneric } from '../resolvers/generic.js';
import { resolveByPlatform } from '../resolvers/index.js';
import { downloadXiaohongshu } from '../resolvers/xiaohongshu.js';
import { downloadYoutube } from '../resolvers/youtube.js';
import type { LinkResolverConfig } from './config.js';

/** 执行上下文（工具或事件）。 */
export interface ExecLike {
  agent?: { session?: { id?: string; header?: { cwd?: string } } };
  signal?: AbortSignal;
  /**
   * 本轮来源。
   * - `im`：本轮由 IM 发起，只允许 `dsh_im_return_file`；
   * - `local`：本轮由 Web/桌面/CLI 发起，只允许 `present`；
   * - `auto`：无法判定（工具路径），先试 IM，失败再退回 present。
   */
  origin?: 'im' | 'local' | 'auto';
}

/** 交付结果。 */
export interface DeliverOutcome {
  ok: boolean;
  channel?: 'im' | 'present';
  code?: string;
  message?: string;
  delivered: number;
}

/** 安全化路径片段。 */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'unknown';
}

/** 两位序号文件名。 */
function indexedName(index: number, ext: string): string {
  return `${String(index + 1).padStart(2, '0')}${ext}`;
}

/**
 * 下载解析结果中的媒体到当前工作区。
 *
 * 目录：`<workspace>/<downloadDir>/<platform>/<contentId>/`
 *
 * @param result - 解析结果。
 * @param config - 配置。
 * @param exec - 执行上下文。
 * @returns 已下载文件。
 */
export async function downloadMedia(
  result: ResolvedLink,
  config: LinkResolverConfig,
  exec: ExecLike,
): Promise<NonNullable<ResolvedLink['downloads']>> {
  const workspace = exec.agent?.session?.header?.cwd ?? process.cwd();
  const base = isAbsolute(config.downloadDir) ? config.downloadDir : join(workspace, config.downloadDir);
  const dir = join(base, result.platform, safeSegment(result.contentId ?? 'unknown'));
  const signal = exec.signal;
  const maxBytes = config.maxDownloadMb > 0 ? config.maxDownloadMb * 1024 * 1024 : undefined;
  await mkdir(dir, { recursive: true });

  let files: NonNullable<ResolvedLink['downloads']> = [];

  if (result.platform === 'bilibili') {
    files = [
      await downloadBilibili(result.url, {
        ctx: { timeoutMs: config.downloadTimeoutMs, retries: config.retryCount, ...(signal ? { signal } : {}) },
        maxHeight: config.videoMaxHeight,
        ...(maxBytes ? { maxBytes } : {}),
        timeoutMs: config.downloadTimeoutMs,
        ...(signal ? { signal } : {}),
        outputDir: dir,
        ffmpegPath: config.ffmpegPath,
        fileName: 'video.mp4',
      }),
    ];
  } else if (result.platform === 'youtube' || result.platform === 'generic') {
    const downloader = result.platform === 'youtube' ? downloadYoutube : downloadGeneric;
    files = [
      await downloader(result.url, {
        ctx: { timeoutMs: config.downloadTimeoutMs, retries: config.retryCount, ...(signal ? { signal } : {}) },
        executable: config.ytdlpPath,
        maxHeight: config.videoMaxHeight,
        ...(maxBytes ? { maxBytes } : {}),
        outputDir: dir,
        timeoutMs: config.downloadTimeoutMs,
        ...(signal ? { signal } : {}),
      }),
    ];
  } else if (result.platform === 'xiaohongshu') {
    files = await downloadXiaohongshu(result.url, {
      ctx: { timeoutMs: config.downloadTimeoutMs, retries: config.retryCount, ...(signal ? { signal } : {}) },
      ...(config.xhsCookies ? { cookie: config.xhsCookies } : {}),
      preferCiPng: config.xhsPreferCiPng,
      maxMedia: config.maxMedia,
      outputDir: dir,
      timeoutMs: config.downloadTimeoutMs,
      ...(maxBytes ? { maxBytes } : {}),
      ...(signal ? { signal } : {}),
      concurrency: config.maxConcurrent,
      filePrefix: '',
      result,
    });
  } else {
    const items = result.media.slice(0, config.maxMedia);
    const referers: Record<string, string> = {
      weibo: 'https://weibo.com/',
      twitter: 'https://x.com/',
      douyin: 'https://www.douyin.com/',
      xiaohongshu: 'https://www.xiaohongshu.com/',
    };
    const headers = referers[result.platform] ? { Referer: referers[result.platform]! } : undefined;
    const { Semaphore } = await import('../core/http.js');
    const semaphore = new Semaphore(config.maxConcurrent);
    await Promise.all(
      items.map((item, index) =>
        semaphore.run(async () => {
          const isVideo = item.kind === 'video' || item.kind === 'livephoto-video';
          const ext = isVideo ? '.mp4' : /(?:\.png|format\/png)(\?|$)/i.test(item.url) ? '.png' : '.jpg';
          const target = join(dir, indexedName(index, ext));
          try {
            const file = await downloadFile(item.url, target, {
              timeoutMs: config.downloadTimeoutMs,
              ...(maxBytes ? { maxBytes } : {}),
              ...(signal ? { signal } : {}),
              ...(headers ? { headers } : {}),
            });
            files.push({
              path: file.path,
              bytes: file.bytes,
              kind: isVideo ? 'video' : 'image',
              ...(isVideo ? { mimeType: 'video/mp4' } : { mimeType: ext === '.png' ? 'image/png' : 'image/jpeg' }),
            });
          } catch {
            // 单个媒体失败不阻断其余
          }
        }),
      ),
    );
    files.sort((a, b) => a.path.localeCompare(b.path));
  }

  if (result.cover) {
    try {
      await downloadFile(result.cover, join(dir, 'cover.jpg'), {
        timeoutMs: config.downloadTimeoutMs,
        ...(maxBytes ? { maxBytes } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch {
      // 忽略封面失败
    }
  }

  try {
    await writeFile(
      join(dir, 'metadata.json'),
      `${JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          platform: result.platform,
          contentId: result.contentId ?? null,
          url: result.url,
          originalUrl: result.originalUrl,
          title: result.title ?? null,
          author: result.author ?? null,
          description: result.description ?? null,
          durationSec: result.durationSec ?? null,
          media: result.media.map((item) => ({ kind: item.kind, url: item.url, width: item.width ?? null, height: item.height ?? null, quality: item.quality ?? null })),
          downloads: files.map((file) => ({ path: file.path, bytes: file.bytes, kind: file.kind })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch {
    // 元数据写入失败不影响下载结果
  }

  return files;
}

/** IM 文件登记工具名。 */
const IM_TOOL = 'dsh_im_return_file';
/** 对话内文件卡片工具名。 */
const PRESENT_TOOL = 'present';
/** `present` 单次最多文件数（其描述建议 1–2、最多 4；取 4 对任何 profile 配置都安全）。 */
const MAX_PRESENT_FILES = 4;

/** 交付工具调用 id。 */
function deliverCallId(index: number): ToolCallId {
  return `lr-deliver-${Date.now()}-${index}` as ToolCallId;
}

/**
 * 判定 IM 交付失败是否只是「本轮没有 IM consumer」。
 *
 * 只有这种失败才允许在 `auto` 模式下退回 present：其余失败（文件缺失、渠道拒绝等）
 * 必须原样上报，不能被 present 掩盖。
 *
 * @param detail - 失败原因。
 * @returns 是否为 consumer 缺失。
 */
function isConsumerMissing(detail: { code: string; message: string }): boolean {
  return detail.code === 'artifact-consumer-required' || /No active IM delivery consumer/i.test(detail.message);
}

/** 从工具失败结果里取原因码与说明。 */
function failureOf(result: { isError?: boolean; error?: { message?: string; info?: { code?: string } } }): { code: string; message: string } {
  const code = result.error?.info?.code ?? 'tool-error';
  const message = result.error?.message ?? '工具执行失败';
  return { code, message };
}

/**
 * 自动交付：按本轮来源选择**唯一**一个通道。
 *
 * 规则（见 docs/modes-and-channels.md 4.4）：
 * - `im`：只调 `dsh_im_return_file`，失败即「本轮无法投递」，不得改用 present；
 * - `local`：只调 `present`；
 * - `auto`：先试 IM，失败退回 present（仅用于模型手动调用工具的路径）。
 *
 * @param ctx - 宿主上下文。
 * @param exec - 执行上下文（含 agent 与本轮来源）。
 * @param files - 已下载文件。
 * @param summary - 固定格式的元数据摘要（写入 present 描述）。
 * @returns 交付结果（成功通道、原因码、文件数）。
 */
export async function deliverFiles(
  ctx: Context,
  exec: ExecLike,
  files: NonNullable<ResolvedLink['downloads']>,
  summary = '',
): Promise<DeliverOutcome> {
  if (files.length === 0) return { ok: false, code: 'no-files', message: '没有可交付的文件', delivered: 0 };

  const origin = exec.origin ?? 'auto';
  const agent = exec.agent as never;
  const signal = exec.signal ?? new AbortController().signal;

  // 必须按 agent 作用域解析：present 由 agent preset 装配，全局视图看不到它。
  const hasIm = ctx.tools.get(IM_TOOL, agent) !== undefined;
  const hasPresent = ctx.tools.get(PRESENT_TOOL, agent) !== undefined;
  ctx.logger.info(
    `link-resolver: 交付判定 origin=${origin} im=${hasIm ? 'visible' : 'hidden'} present=${hasPresent ? 'visible' : 'hidden'}（全局视图 im=${ctx.tools.get(IM_TOOL) ? 'visible' : 'hidden'} present=${ctx.tools.get(PRESENT_TOOL) ? 'visible' : 'hidden'}）files=${files.length}`,
  );

  let imFailure: { code: string; message: string } | undefined;
  if ((origin === 'im' || origin === 'auto') && hasIm) {
    const calls = files.map((file, index) => ({
      type: 'tool-call' as const,
      id: deliverCallId(index),
      name: IM_TOOL,
      arguments: JSON.stringify({ path: file.path }),
    }));
    try {
      const batch = await ctx.tools.execute({ calls, signal, agent });
      const failures = batch.results.filter((entry) => entry.result.isError === true);
      if (failures.length === 0) return { ok: true, channel: 'im', delivered: files.length };
      const first = failureOf(failures[0]!.result);
      imFailure = first;
      ctx.logger.warn(`link-resolver: IM 交付失败 code=${first.code} message=${first.message}（${failures.length}/${files.length}）`);
      if (failures.length < files.length) {
        return { ok: true, channel: 'im', delivered: files.length - failures.length, code: first.code, message: `${failures.length} 个文件登记失败` };
      }
    } catch (error) {
      imFailure = { code: 'tool-error', message: error instanceof Error ? error.message : String(error) };
      ctx.logger.warn(`link-resolver: IM 交付异常 ${imFailure.message}`);
    }
    if (origin === 'im') {
      return { ok: false, code: imFailure?.code ?? 'im-consumer-inactive', message: imFailure?.message ?? '本轮没有活跃的 IM 投递通道', delivered: 0 };
    }
    if (imFailure && !isConsumerMissing(imFailure)) {
      // auto：非 consumer 问题的真实失败，不要退回 present 掩盖。
      return { ok: false, code: imFailure.code, message: imFailure.message, delivered: 0 };
    }
  } else if (origin === 'im') {
    ctx.logger.warn('link-resolver: IM 轮次里 dsh_im_return_file 不可见，判定无法投递');
    return { ok: false, code: 'tool-unavailable', message: 'dsh_im_return_file 在 agent 作用域内不可见', delivered: 0 };
  }

  if (!hasPresent) {
    ctx.logger.warn('link-resolver: present 在 agent 作用域内不可见');
    return { ok: false, code: 'tool-unavailable', message: 'present 在 agent 作用域内不可见', delivered: 0 };
  }

  const limited = files.slice(0, MAX_PRESENT_FILES);
  try {
    const batch = await ctx.tools.execute({
      calls: [
        {
          type: 'tool-call' as const,
          id: deliverCallId(0),
          name: PRESENT_TOOL,
          arguments: JSON.stringify({
            files: limited.map((file) => ({ path: file.path, ...(summary ? { description: summary } : {}) })),
          }),
        },
      ],
      signal,
      agent,
    });
    const failed = batch.results.find((entry) => entry.result.isError === true);
    if (!failed) return { ok: true, channel: 'present', delivered: limited.length };
    const detail = failureOf(failed.result);
    ctx.logger.warn(`link-resolver: present 交付失败 code=${detail.code} message=${detail.message}`);
    return { ok: false, code: detail.code, message: detail.message, delivered: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn(`link-resolver: present 交付异常 ${message}`);
    return { ok: false, code: 'tool-error', message, delivered: 0 };
  }
}

/** 固定格式摘要（供 present 描述与日志）。 */
export function formatSummary(result: ResolvedLink, files: NonNullable<ResolvedLink['downloads']>): string {
  const label = PLATFORM_BY_ID[result.platform]?.label ?? result.platform;
  const lines = [`${label} · ${result.author ?? '未知作者'}`];
  if (result.title) lines.push(`标题：${result.title}`);
  if (result.durationSec) lines.push(`时长：${result.durationSec}s`);
  for (const file of files) lines.push(`文件：${file.path}（${Math.round(file.bytes / 1024)} KB）`);
  return lines.join('\n');
}

/** 管线结果。 */
export interface ProcessResult {
  result?: ResolvedLink;
  files: NonNullable<ResolvedLink['downloads']>;
  delivery?: DeliverOutcome;
  error?: { code: string; message: string };
}

/**
 * 完整处理一条链接：解析 → 下载（→ 可选交付）。
 *
 * 自动链路由 `chain.ts` 调用，先传入 `{ deliver: false }`，再按本轮来源交付；
 * 模型手动调用工具时传入默认值，交付按 `origin: 'auto'` 处理。
 *
 * @param ctx - 宿主上下文。
 * @param url - 链接。
 * @param config - 配置。
 * @param exec - 执行上下文（含本轮来源）。
 * @param options - 是否在此函数内交付、是否下载媒体。
 * @returns 处理结果。
 */
export async function processLink(
  ctx: Context,
  url: string,
  config: LinkResolverConfig,
  exec: ExecLike,
  options: { deliver?: boolean; download?: boolean } = {},
): Promise<ProcessResult> {
  const normalized = normalizeUrl(url);
  const detection = normalized ? detectPlatform(normalized) : null;
  if (!detection) {
    return { files: [], error: { code: 'unsupported-url', message: '未命中受支持平台' } };
  }
  if (!config.enabledPlatforms.includes(detection.platform)) {
    return { files: [], error: { code: 'unsupported-url', message: `${PLATFORM_BY_ID[detection.platform].label} 未启用` } };
  }

  try {
    const result = await resolveByPlatform(detection.platform, normalized, {
      timeoutMs: config.resolveTimeoutMs,
      retries: config.retryCount,
      ...(exec.signal ? { signal: exec.signal } : {}),
      ...(config.weiboCookies ? { weiboCookie: config.weiboCookies } : {}),
      ...(config.xhsCookies ? { xhsCookie: config.xhsCookies } : {}),
      xhsPreferCiPng: config.xhsPreferCiPng,
      ytdlpPath: config.ytdlpPath,
      genericDomains: config.genericAllowedDomains,
    });
    result.originalUrl = url;

    let files: NonNullable<ResolvedLink['downloads']> = [];
    if (options.download ?? config.downloadMedia) {
      try {
        files = await downloadMedia(result, config, exec);
        if (files.length > 0) result.downloads = files;
        else result.warnings.push('没有可下载的媒体');
      } catch (error) {
        result.warnings.push(`下载失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let delivery: DeliverOutcome | undefined;
    if ((options.deliver ?? true) && files.length > 0) {
      delivery = await deliverFiles(ctx, exec, files, formatSummary(result, files));
      result.warnings.push(
        delivery.ok
          ? `已自动通过 ${delivery.channel ?? 'unknown'} 交付 ${delivery.delivered} 个文件${delivery.message ? `（${delivery.message}）` : ''}`
          : `自动交付未成功（${delivery.code ?? 'unknown'}）${delivery.message ? `：${delivery.message}` : ''}`,
      );
    }

    return { result, files, ...(delivery ? { delivery } : {}) };
  } catch (error) {
    return { files: [], error: toErrorPayload(error, detection.platform) };
  }
}