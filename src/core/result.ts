/**
 * 统一结果模型与错误模型。
 *
 * 所有平台解析器只产出 {@link ResolvedLink}；任何失败都以 {@link ResolveError}
 * 表达，由工具层转换为结构化错误，不向模型抛原始异常。
 *
 * @module dsh-plugin-link-resolver/core/result
 */

import type { PlatformId } from './registry.js';

/** 媒体类型。`livephoto-video` 表示与静态图配对的动态片段。 */
export type MediaKind = 'video' | 'image' | 'livephoto-video';

/** 单条媒体。字段可缺失——不同平台能提供的信息不同。 */
export interface MediaItem {
  kind: MediaKind;
  /** 原始直链（可能带时效签名，不应视为永久地址）。 */
  url: string;
  /** 备用地址，按优先级排列。 */
  candidates?: string[];
  width?: number;
  height?: number;
  filesize?: number;
  mimeType?: string;
  quality?: {
    label: string;
    height?: number;
    codec?: 'avc' | 'hevc' | 'av1';
  };
  /** Live Photo：该动态片段对应的静态图在 `media` 中的索引。 */
  pairedWith?: number;
}

/** 已落盘的本地文件。 */
export interface LocalFile {
  path: string;
  bytes: number;
  mimeType?: string;
  kind: 'video' | 'image' | 'audio';
}

/** 内容形态。 */
export type ContentType = 'video' | 'images' | 'image' | 'text' | 'mixed';

/** 统一解析结果。 */
export interface ResolvedLink {
  platform: PlatformId;
  /** 规范化后的链接。 */
  url: string;
  /** 用户输入的原始链接。 */
  originalUrl: string;
  contentId?: string;
  type: ContentType;
  title?: string;
  description?: string;
  author?: string;
  authorAvatar?: string;
  cover?: string;
  /** 发布时间（平台原始格式或 ISO 字符串）。 */
  createdAt?: string;
  durationSec?: number;
  media: MediaItem[];
  stats?: {
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    coins?: number;
  };
  /** 仅当显式请求下载时出现。 */
  downloads?: LocalFile[];
  /** 降级、跳过、截断等非致命信息。 */
  warnings: string[];
  /** 命中会话缓存时为 true。 */
  cached?: boolean;
}

/** 结构化错误码。 */
export type ErrorCode =
  | 'unsupported-url'
  | 'not-found'
  | 'auth-required'
  | 'rate-limited'
  | 'network'
  | 'timeout'
  | 'size-exceeded'
  | 'duration-exceeded'
  | 'tool-missing'
  | 'parse-failed'
  | 'download-failed'
  | 'blocked-domain'
  | 'internal';

/** 解析错误：携带错误码、平台与是否可重试。 */
export class ResolveError extends Error {
  readonly code: ErrorCode;
  readonly platform?: PlatformId;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { platform?: PlatformId; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ResolveError';
    this.code = code;
    this.platform = options.platform;
    this.retryable = options.retryable ?? false;
  }
}

/** 工具层返回的错误载荷。 */
export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  platform?: PlatformId;
  retryable: boolean;
}

/**
 * 把任意异常收敛为错误载荷。
 *
 * @param error - 捕获到的异常。
 * @param platform - 当前解析平台（可覆盖异常自带值）。
 * @returns 可安全返回给模型的错误载荷。
 */
export function toErrorPayload(error: unknown, platform?: PlatformId): ErrorPayload {
  if (error instanceof ResolveError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.platform ?? platform ? { platform: error.platform ?? platform } : {}),
      retryable: error.retryable,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'internal',
    message: message.slice(0, 300),
    ...(platform ? { platform } : {}),
    retryable: false,
  };
}

/**
 * 构造解析结果，补齐可选字段的默认值。
 *
 * @param base - 平台解析器给出的核心字段。
 * @returns 完整结果。
 */
export function buildResult(base: Omit<ResolvedLink, 'warnings'> & { warnings?: string[] }): ResolvedLink {
  return { ...base, warnings: base.warnings ?? [] };
}