/**
 * 注入给模型的结果上下文（notice）。
 *
 * 单链路里，模型唯一的职责是「播报结果」。因此注入必须是**可播报的真实结果**，
 * 而不是一句「已交付」——否则模型只能自己去翻下载目录。
 *
 * 三种状态：成功 / 处理失败 / 已下载但交付失败。
 *
 * @module dsh-plugin-link-resolver/adapter/notice
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm';

import { PLATFORM_BY_ID } from '../core/registry.js';
import type { ResolvedLink } from '../core/result.js';
import type { DeliverOutcome } from './pipeline.js';

/** 自身注入消息的 source kind。 */
export const SOURCE_KIND = 'link-resolver';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'link-resolver': { kind: 'link-resolver' } & ContextFormed;
  }
}

/** 注入消息的摘要（显示在上下文卡片上）。 */
export type NoticeSummary = '链接已处理' | '链接处理失败' | '文件未交付';

/**
 * 包装成一条 notice 消息。
 *
 * @param text - 注入正文。
 * @param summary - 卡片摘要。
 * @returns 用户消息。
 */
export function notice(text: string, summary: NoticeSummary): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'notice', summary },
  });
}

/** 格式化时长。 */
function formatDuration(seconds: number | undefined): string | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return minutes > 0 ? `${minutes}:${String(secs).padStart(2, '0')}` : `0:${String(secs).padStart(2, '0')}`;
}

/**
 * 一行身份描述：平台 · 标题 · 作者 · 时长 · 媒体构成。
 *
 * @param result - 解析结果。
 * @returns 单行文本。
 */
export function describeResult(result: ResolvedLink): string {
  const parts: string[] = [PLATFORM_BY_ID[result.platform]?.label ?? result.platform];
  if (result.title) parts.push(result.title);
  if (result.author) parts.push(`作者：${result.author}`);
  const duration = formatDuration(result.durationSec);
  if (duration) parts.push(duration);

  const videos = result.media.filter((item) => item.kind === 'video' || item.kind === 'livephoto-video').length;
  const images = result.media.filter((item) => item.kind === 'image').length;
  const media: string[] = [];
  if (videos > 0) media.push(`${videos} 个视频`);
  if (images > 0) media.push(`${images} 张图片`);
  parts.push(media.length > 0 ? media.join(' / ') : '无媒体（纯文本）');
  return parts.join(' · ');
}

/** 成功注入的输入。 */
export interface SuccessInput {
  result: ResolvedLink;
  delivery?: DeliverOutcome;
  origin: 'im' | 'local' | 'auto';
  fileCount: number;
  /** 相对工作区的文件路径（仅交付失败时使用）。 */
  fileRefs: string[];
  /** 是否命中会话缓存（未重新解析、未重新下载）。 */
  reused?: boolean;
  /** 本轮未处理的其他受支持链接。 */
  skipped?: string[];
  /** 下载阶段的警告（例如部分媒体失败）。 */
  note?: string;
}

/**
 * 成功注入文案。
 *
 * @param input - 结果与交付状态。
 * @returns 注入正文。
 */
export function successText(input: SuccessInput): string {
  const lines: string[] = [`[link-resolver] 本轮已自动处理：${describeResult(input.result)}`];
  if (input.reused) lines.push('说明：本条命中会话缓存，没有重新解析或下载。');

  const delivery = input.delivery;
  if (delivery?.ok && delivery.channel === 'im') {
    lines.push(`交付：已登记 ${delivery.delivered} 个文件，本轮结束后由 IM 渠道发送（说"已交付"，不要说"用户已收到"）。`);
  } else if (delivery?.ok && delivery.channel === 'present') {
    const more = input.fileCount - delivery.delivered;
    lines.push(`交付：已通过对话文件卡片交付 ${delivery.delivered} 个文件${more > 0 ? `，另有 ${more} 个在下载目录` : ''}。`);
  } else if (input.fileCount === 0) {
    lines.push(input.note ? '交付：媒体下载失败，没有可交付的文件。' : '交付：本条没有可下载的媒体，只提供文字信息。');
  } else {
    lines.push(`交付：未完成（${delivery?.code ?? 'no-channel'}）${delivery?.message ? `，${delivery.message}` : ''}。`);
    if (input.fileRefs.length > 0) lines.push(`文件（相对工作区）：${input.fileRefs.join('、')}`);
  }

  if (input.note) lines.push(`提示：${input.note}`);
  if (input.skipped && input.skipped.length > 0) {
    lines.push(`另有 ${input.skipped.length} 条受支持链接本轮未处理：${input.skipped.join('、')}`);
  }
  const tail =
    input.fileCount === 0
      ? '信息已完整：不要再调用 resolve_link，也不要读取下载目录；直接输出 1–3 句介绍。'
      : delivery?.ok === true
        ? '信息已完整：不要再调用 resolve_link，也不要读取下载目录；直接输出 1–3 句介绍。'
        : input.origin === 'im'
          ? '本轮无法通过 IM 投递：不要声称已经发送文件，直接说明原因（例如请稍后重新发送链接）。'
          : '本轮没有可用的文件交付通道：不要声称已经发送文件；如需交付，可调用一次 present（files 用上面的相对路径）。';
  lines.push(tail);
  return lines.join('\n');
}

/**
 * 处理失败文案（解析失败 / 无媒体可下载）。
 *
 * @param platform - 平台标签。
 * @param code - 错误码。
 * @param message - 错误说明。
 * @param skipped - 本轮未处理的其他链接。
 * @returns 注入正文。
 */
export function failureText(platform: string, code: string, message: string, skipped: string[] = []): string {
  const lines = [
    `[link-resolver] 本轮自动处理失败：${platform} · code=${code}`,
    `原因：${message}`,
    '没有可交付的文件。不要调用 resolve_link 重试；直接说明原因并给出可行建议（例如稍后重新发送链接）。',
  ];
  if (skipped.length > 0) lines.push(`另有 ${skipped.length} 条受支持链接本轮未处理：${skipped.join('、')}`);
  return lines.join('\n');
}