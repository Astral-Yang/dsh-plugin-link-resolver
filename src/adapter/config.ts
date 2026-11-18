/**
 * 配置 Schema（schemastery）。
 *
 * 所有字段声明为 `.volatile()`：DSH 设置页只会为 volatile 字段自动生成表单，
 * 且 volatile 字段原地生效、无需重载插件（读取方式为 `config.<field>.get()`）。
 *
 * 单链路设计：不再有 `mode`。插件始终执行「解析 → 下载 → 交付 → 注入结果」，
 * 两个开关分别控制工具注册与媒体下载。
 *
 * @module dsh-plugin-link-resolver/adapter/config
 */

import z from '@deepseek-ai/schemastery';

/** 插件配置（读取后的普通值）。 */
export interface LinkResolverConfig {
  enabled: boolean;
  /** 向模型注册 `resolve_link` 工具；默认关闭（自动链路不需要模型调用工具）。 */
  toolEnabled: boolean;
  /** 自动链路是否下载媒体；关闭时只注入元数据。 */
  downloadMedia: boolean;
  autoGuidance: boolean;
  enabledPlatforms: string[];
  resolveTimeoutMs: number;
  downloadTimeoutMs: number;
  retryCount: number;
  maxConcurrent: number;
  maxMedia: number;
  downloadDir: string;
  maxDownloadMb: number;
  maxDurationSec: number;
  cacheTtlHours: number;
  weiboCookies: string;
  xhsCookies: string;
  videoMaxHeight: number;
  ffmpegPath: string;
  ytdlpPath: string;
  xhsPreferCiPng: boolean;
  genericAllowedDomains: string[];
}

/** 默认值（与 Schema 保持一致，供读取兜底）。 */
export const DEFAULTS: LinkResolverConfig = {
  enabled: true,
  toolEnabled: false,
  downloadMedia: true,
  autoGuidance: true,
  enabledPlatforms: ['bilibili', 'douyin', 'xiaohongshu', 'weibo', 'twitter', 'youtube'],
  resolveTimeoutMs: 20000,
  downloadTimeoutMs: 300000,
  retryCount: 2,
  maxConcurrent: 2,
  maxMedia: 30,
  downloadDir: 'downloads',
  maxDownloadMb: 200,
  maxDurationSec: 300,
  cacheTtlHours: 24,
  weiboCookies: '',
  xhsCookies: '',
  videoMaxHeight: 1080,
  ffmpegPath: 'ffmpeg',
  ytdlpPath: 'yt-dlp',
  xhsPreferCiPng: true,
  genericAllowedDomains: ['tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch', 'acfun.cn', 'reddit.com', 'vimeo.com', 'dailymotion.com', 'twitch.tv', 'bilibili.tv'],
};

/** 平台 id 的合法取值。 */
const PLATFORM_IDS = ['bilibili', 'douyin', 'xiaohongshu', 'weibo', 'twitter', 'youtube', 'generic'] as const;

/** 配置 Schema（全部 volatile，便于设置页编辑与热更新）。 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('插件总开关').volatile(),
  toolEnabled: z
    .boolean()
    .default(false)
    .description('向模型注册 resolve_link 工具（默认关闭：链接由插件自动处理，模型无需也不会重复解析）')
    .volatile(),
  downloadMedia: z
    .boolean()
    .default(true)
    .description('自动链路是否下载媒体；关闭时只解析元数据并注入结果，不下载、不交付')
    .volatile(),
  autoGuidance: z.boolean().default(true).description('向系统提示注入「上下文已有结果时直接采用」的引导').volatile(),
  enabledPlatforms: z
    .array(z.union(PLATFORM_IDS.map((id) => z.const(id))))
    .default(['bilibili', 'douyin', 'xiaohongshu', 'weibo', 'twitter', 'youtube'])
    .description('启用的平台')
    .volatile(),
  resolveTimeoutMs: z.number().min(1000).max(120000).default(20000).description('单次解析超时（毫秒）').volatile(),
  downloadTimeoutMs: z.number().min(1000).max(1800000).default(300000).description('单次下载总超时（毫秒）').volatile(),
  retryCount: z.number().min(0).max(10).default(2).description('解析失败重试次数（不含模型侧重试）').volatile(),
  maxConcurrent: z.number().min(1).max(8).default(2).description('全局最大并发下载数').volatile(),
  maxMedia: z.number().min(1).max(200).default(30).description('单次结果的最大媒体数量').volatile(),
  downloadDir: z.string().default('downloads').description('下载根目录（相对会话工作区）').volatile(),
  maxDownloadMb: z.number().min(0).max(2000).default(200).description('下载文件大小上限（MB，0 为不限）').volatile(),
  maxDurationSec: z.number().min(0).max(86400).default(300).description('最大媒体时长（秒，0 为不限）').volatile(),
  cacheTtlHours: z.number().min(1).max(720).default(24).description('会话缓存有效期（小时）').volatile(),
  weiboCookies: z.string().default('').description('微博 Cookie（可选，形如 SUB=...；留空使用访客态）').volatile(),
  xhsCookies: z.string().default('').description('小红书 Cookie（可选；页面要求登录时必需）').volatile(),
  videoMaxHeight: z.number().min(144).max(4320).default(1080).description('视频下载的最大高度（px）').volatile(),
  ffmpegPath: z.string().default('ffmpeg').description('ffmpeg 可执行文件（名称或绝对路径）').volatile(),
  ytdlpPath: z.string().default('yt-dlp').description('yt-dlp 可执行文件（名称或绝对路径）').volatile(),
  xhsPreferCiPng: z.boolean().default(true).description('小红书优先使用 ci.xiaohongshu.com 原图').volatile(),
  genericAllowedDomains: z
    .array(z.string())
    .default(['tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch', 'acfun.cn', 'reddit.com', 'vimeo.com', 'dailymotion.com', 'twitch.tv', 'bilibili.tv'])
    .description('通用站点白名单（仅这些域名会交给 yt-dlp）')
    .volatile(),
});

/** 可能是 volatile 访问器，也可能是普通值。 */
type MaybeVolatile<T> = T | { get: () => T };

/**
 * 读取一个字段的当前值（兼容 volatile 访问器与普通值）。
 *
 * @param field - 原始字段。
 * @param fallback - 缺失时的兜底值。
 * @returns 当前值。
 */
function valueOf<T>(field: MaybeVolatile<T> | undefined, fallback: T): T {
  if (field === undefined) return fallback;
  const accessor = field as { get?: () => T };
  if (typeof accessor.get === 'function') {
    const value = accessor.get();
    return value === undefined ? fallback : value;
  }
  return field as T;
}

/**
 * 把原始配置（可能含 volatile 访问器）读成普通值对象。
 *
 * @param input - loader 传入的配置。
 * @returns 完整配置值。
 */
export function readConfig(input: unknown): LinkResolverConfig {
  const raw = (input ?? {}) as Record<string, MaybeVolatile<unknown>>;
  const pick = <T>(key: keyof LinkResolverConfig, fallback: T): T => valueOf(raw[key] as MaybeVolatile<T>, fallback);
  return {
    enabled: pick('enabled', DEFAULTS.enabled),
    toolEnabled: pick('toolEnabled', DEFAULTS.toolEnabled),
    downloadMedia: pick('downloadMedia', DEFAULTS.downloadMedia),
    autoGuidance: pick('autoGuidance', DEFAULTS.autoGuidance),
    enabledPlatforms: pick('enabledPlatforms', DEFAULTS.enabledPlatforms),
    resolveTimeoutMs: pick('resolveTimeoutMs', DEFAULTS.resolveTimeoutMs),
    downloadTimeoutMs: pick('downloadTimeoutMs', DEFAULTS.downloadTimeoutMs),
    retryCount: pick('retryCount', DEFAULTS.retryCount),
    maxConcurrent: pick('maxConcurrent', DEFAULTS.maxConcurrent),
    maxMedia: pick('maxMedia', DEFAULTS.maxMedia),
    downloadDir: pick('downloadDir', DEFAULTS.downloadDir),
    maxDownloadMb: pick('maxDownloadMb', DEFAULTS.maxDownloadMb),
    maxDurationSec: pick('maxDurationSec', DEFAULTS.maxDurationSec),
    cacheTtlHours: pick('cacheTtlHours', DEFAULTS.cacheTtlHours),
    weiboCookies: pick('weiboCookies', DEFAULTS.weiboCookies),
    xhsCookies: pick('xhsCookies', DEFAULTS.xhsCookies),
    videoMaxHeight: pick('videoMaxHeight', DEFAULTS.videoMaxHeight),
    ffmpegPath: pick('ffmpegPath', DEFAULTS.ffmpegPath),
    ytdlpPath: pick('ytdlpPath', DEFAULTS.ytdlpPath),
    xhsPreferCiPng: pick('xhsPreferCiPng', DEFAULTS.xhsPreferCiPng),
    genericAllowedDomains: pick('genericAllowedDomains', DEFAULTS.genericAllowedDomains),
  };
}