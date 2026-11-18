/**
 * `resolve_link` 工具定义。
 *
 * 负责：参数校验 → 平台识别 → 解析器分发 → 结果/错误归一化 → 模型可读渲染。
 * 平台细节全部留在 `resolvers/`，本文件不出现任何平台协议代码。
 *
 * @module dsh-plugin-link-resolver/adapter/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';

import type { SessionCache } from '../core/cache.js';
import { deliverFiles, downloadMedia, formatSummary } from './pipeline.js';
import { detectPlatform, PLATFORM_BY_ID } from '../core/registry.js';
import type { PlatformId } from '../core/registry.js';
import { toErrorPayload } from '../core/result.js';
import type { ResolvedLink } from '../core/result.js';
import { normalizeUrl } from '../core/url.js';
import { resolveByPlatform } from '../resolvers/index.js';
import type { LinkResolverConfig } from './config.js';

/** 媒体摘要（用于输出 schema 与渲染）。 */
export interface MediaSummary {
  kind: string;
  url: string;
  width?: number;
  height?: number;
  quality?: { label: string; height?: number; codec?: string };
}

/** 工具结果值。 */
export interface ResolveLinkValue {
  ok: boolean;
  platform: string;
  url: string;
  supported: boolean;
  message: string;
  result?: {
    contentId?: string;
    type: string;
    title?: string;
    description?: string;
    author?: string;
    cover?: string;
    durationSec?: number;
    createdAt?: string;
    media: MediaSummary[];
    warnings: string[];
    downloads?: Array<{ path: string; bytes: number; kind: string }>;
  };
  error?: { code: string; message: string; retryable: boolean };
}

/** 工具描述。 */
const DESCRIPTION = [
  '手动解析一条平台链接（B站 / 抖音 / 小红书 / 微博 / X / YouTube），返回标题、作者、简介、时长与媒体直链。',
  '注意：用户消息里的链接通常已由插件自动处理，上下文里会出现 [link-resolver] 结果；此时直接采用，不要调用本工具。',
  '默认会下载媒体文件到本地并返回 result.downloads；如需只取元数据可显式传 download=false。',
  '下载完成后插件会自动交付；若结果提示未交付，再按渠道调用 present 或 dsh_im_return_file。',
].join('');

/** 格式化时长。 */
function formatDuration(seconds: number | undefined): string | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** 渲染工具结果文本。 */
function renderText(value: ResolveLinkValue): string {
  if (!value.ok) {
    const error = value.error;
    return [
      `解析失败：${value.platform === 'unknown' ? '未识别平台' : value.platform} · ${error?.code ?? 'internal'}`,
      error?.message ?? '未知错误',
      `链接：${value.url}`,
    ].join('\n');
  }

  const label = PLATFORM_BY_ID[value.platform as PlatformId]?.label ?? value.platform;
  const result = value.result;
  const lines: string[] = [`【${label}】${result?.title ?? '（无标题）'}`];

  const meta: string[] = [];
  if (result?.author) meta.push(`作者：${result.author}`);
  const duration = formatDuration(result?.durationSec);
  if (duration) meta.push(`时长：${duration}`);
  if (result?.type) meta.push(`类型：${result.type}`);
  if (meta.length > 0) lines.push(meta.join(' ｜ '));

  if (result?.description && result.description !== result.title) {
    const brief = result.description.replace(/\s+/g, ' ').slice(0, 160);
    lines.push(`简介：${brief}${result.description.length > 160 ? '…' : ''}`);
  }

  const media = result?.media ?? [];
  const videos = media.filter((item) => item.kind === 'video' || item.kind === 'livephoto-video');
  const images = media.filter((item) => item.kind === 'image');
  if (media.length > 0) {
    const parts: string[] = [];
    if (videos.length > 0) parts.push(`${videos.length} 个视频`);
    if (images.length > 0) parts.push(`${images.length} 张图片`);
    lines.push(`媒体：${parts.join(' / ')}`);
    const first = media[0];
    if (first) lines.push(`首个直链：${first.url}`);
  } else {
    lines.push('媒体：无（纯文本内容）');
  }

  if (result?.warnings && result.warnings.length > 0) {
    lines.push(`提示：${result.warnings.join('；')}`);
  }
  if (result?.downloads && result.downloads.length > 0) {
    lines.push('已下载：');
    for (const file of result.downloads) {
      lines.push(`- ${file.path}（${Math.round(file.bytes / 1024)} KB）`);
    }
    const delivered = (result.warnings ?? []).some((warning) => warning.startsWith('已自动通过'));
    if (delivered) {
      lines.push('以上文件已由插件自动交付给用户，无需再次调用交付工具；回复时不要使用 Markdown 图片或本地路径链接。');
    } else {
      lines.push('本次未能自动交付：按上面的原因码处理，不要用 Markdown 图片或本地路径链接代替文件交付。');
    }
  }
  lines.push(`链接：${value.url}`);
  if (value.message) lines.push(`状态：${value.message}`);
  return lines.join('\n');
}

/** 把解析结果压缩为工具值中的摘要。 */
function summarize(result: ResolvedLink): NonNullable<ResolveLinkValue['result']> {
  return {
    ...(result.contentId ? { contentId: result.contentId } : {}),
    type: result.type,
    ...(result.title ? { title: result.title } : {}),
    ...(result.description ? { description: result.description } : {}),
    ...(result.author ? { author: result.author } : {}),
    ...(result.cover ? { cover: result.cover } : {}),
    ...(result.durationSec ? { durationSec: result.durationSec } : {}),
    ...(result.createdAt ? { createdAt: result.createdAt } : {}),
    media: result.media.map((item) => ({
      kind: item.kind,
      url: item.url,
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
      ...(item.quality ? { quality: { label: item.quality.label, ...(item.quality.height ? { height: item.quality.height } : {}), ...(item.quality.codec ? { codec: item.quality.codec } : {}) } } : {}),
    })),
    warnings: result.warnings,
    ...(result.downloads && result.downloads.length > 0
      ? { downloads: result.downloads.map((file) => ({ path: file.path, bytes: file.bytes, kind: file.kind })) }
      : {}),
  };
}

/**
 * 构造 `resolve_link` 工具。
 *
 * @param config - 当前配置。
 * @param cache - 会话缓存。
 * @returns 工具定义。
 */
export function createResolveLinkTool(getConfig: () => LinkResolverConfig, cache: SessionCache, ctx: Context): ToolDefinition {
  return defineTool({
    name: 'resolve_link',
    description: DESCRIPTION,
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: '要解析的链接（B站 / 抖音 / 小红书 / 微博 / X / YouTube）',
      },
      download: {
        type: 'boolean',
        description: '是否把媒体下载到本地（默认由插件配置 downloadMedia 决定，默认 true）；下载受大小、时长与并发限制',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: '是否解析成功' },
          platform: { type: 'string', required: true, description: '平台 id' },
          url: { type: 'string', required: true, description: '规范化后的链接' },
          supported: { type: 'boolean', required: true, description: '是否命中受支持平台' },
          message: { type: 'string', required: true, description: '状态说明' },
          result: {
            type: 'object',
            additionalProperties: false,
            description: '解析结果（成功时出现）',
            properties: {
              contentId: { type: 'string' },
              type: { type: 'string', required: true },
              title: { type: 'string' },
              description: { type: 'string' },
              author: { type: 'string' },
              cover: { type: 'string' },
              durationSec: { type: 'number' },
              createdAt: { type: 'string' },
              media: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    quality: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        label: { type: 'string', required: true },
                        height: { type: 'number' },
                        codec: { type: 'string' },
                      },
                    },
                  },
                },
              },
              warnings: { type: 'array', required: true, items: { type: 'string' } },
              downloads: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    bytes: { type: 'number', required: true },
                    kind: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          error: {
            type: 'object',
            additionalProperties: false,
            description: '错误信息（失败时出现）',
            properties: {
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
              retryable: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
    },
    async execute(args, exec): Promise<ResolveLinkValue> {
      const config = getConfig();
      const enabled = new Set(config.enabledPlatforms);
      const url = normalizeUrl(args.url);
      const platformHint = url ? detectPlatform(url) : null;
      const platform = platformHint?.platform ?? 'unknown';

      if (url.length === 0) {
        return {
          ok: false,
          platform: 'unknown',
          url: args.url,
          supported: false,
          message: '链接格式无法解析',
          error: { code: 'unsupported-url', message: '既不是绝对 URL，也无法补齐 scheme', retryable: false },
        };
      }
      if (!platformHint) {
        return {
          ok: false,
          platform: 'unknown',
          url,
          supported: false,
          message: '不是受支持的平台链接',
          error: { code: 'unsupported-url', message: '未命中任何受支持平台', retryable: false },
        };
      }
      if (!enabled.has(platformHint.platform)) {
        return {
          ok: false,
          platform: platformHint.platform,
          url,
          supported: false,
          message: `${PLATFORM_BY_ID[platformHint.platform].label} 解析未启用`,
          error: { code: 'unsupported-url', message: '该平台在配置中未启用', retryable: false },
        };
      }

      const sessionId = exec.agent?.session?.id ?? 'anonymous';
      const cached = cache.get(sessionId, url);
      if (cached) {
        return {
          ok: true,
          platform: cached.platform,
          url,
          supported: true,
          message: '命中会话缓存',
          result: summarize(cached),
        };
      }

      try {
        const result = await resolveByPlatform(platformHint.platform, url, {
          timeoutMs: config.resolveTimeoutMs,
          retries: config.retryCount,
          ...(exec.signal ? { signal: exec.signal } : {}),
          ...(config.weiboCookies ? { weiboCookie: config.weiboCookies } : {}),
          ...(config.xhsCookies ? { xhsCookie: config.xhsCookies } : {}),
          xhsPreferCiPng: config.xhsPreferCiPng,
          ytdlpPath: config.ytdlpPath,
          genericDomains: config.genericAllowedDomains,
        });
        result.originalUrl = args.url;
        const shouldDownload = args.download ?? config.downloadMedia;
        if (shouldDownload) {
          try {
            const files = await downloadMedia(result, config, exec);
            if (files.length > 0) {
              result.downloads = files;
              const delivery = await deliverFiles(
                ctx,
                { agent: exec.agent as never, origin: 'auto', ...(exec.signal ? { signal: exec.signal } : {}) },
                files,
                formatSummary(result, files),
              );
              result.warnings.push(
                delivery.ok
                  ? `已自动通过 ${delivery.channel ?? 'unknown'} 交付 ${delivery.delivered} 个文件`
                  : `自动交付未成功（${delivery.code ?? 'unknown'}）${delivery.message ? `：${delivery.message}` : ''}，请按渠道调用 present 或 dsh_im_return_file`,
              );
            } else result.warnings.push('没有可下载的媒体');
          } catch (downloadError) {
            result.warnings.push(`下载失败：${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
          }
        }
        cache.set(sessionId, url, result);
        return {
          ok: true,
          platform: result.platform,
          url,
          supported: true,
          message: '解析成功',
          result: summarize(result),
        };
      } catch (error) {
        const payload = toErrorPayload(error, platformHint.platform);
        return {
          ok: false,
          platform: platformHint.platform,
          url,
          supported: true,
          message: '解析失败',
          error: { code: payload.code, message: payload.message, retryable: payload.retryable },
        };
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '解析链接',
      kind: 'other',
      rawInput: args.url,
    }),
  });
}