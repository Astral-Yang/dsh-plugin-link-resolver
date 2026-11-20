/**
 * 单链路自动处理：一条链接从「用户消息」走到「模型播报」。
 *
 * 时序（`agent/pre-step`，仅在每轮第一步）：
 * 1. 从本步消息里取第一条受支持链接（其余列入注入文本）；
 * 2. 命中会话缓存且文件仍在本地 → 直接复用（不重新解析、不重新下载）；
 * 3. 否则解析 + 下载；
 * 4. 按**本轮来源**交付（IM → `dsh_im_return_file`；本地 → `present`）；
 * 5. 把真实结果注入为一条 notice，本轮始终以 `completed` 结束（永不 `reject`）。
 *
 * @module dsh-plugin-link-resolver/adapter/chain
 */

import { stat } from 'node:fs/promises';
import { relative } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';

import { detectPlatform, PLATFORM_BY_ID } from '../core/registry.js';
import type { LocalFile } from '../core/result.js';
import type { SessionCache } from '../core/cache.js';
import { extractLinks } from '../core/url.js';
import type { LinkResolverConfig } from './config.js';
import { failureText, notice, successText } from './notice.js';
import { deliverFiles, downloadMedia, formatSummary, processLink } from './pipeline.js';
import { maybeCleanup, workspaceAllowed } from './retention.js';

/** dsh-im 随每个入站 IM 消息注入的通知 source kind（旧形态：独立消息）。 */
const IM_SOURCE_KIND = 'plugin:dsh-im';

/** dsh-im 注入的来源标记（当前形态：拼在用户消息文本开头）。 */
const IM_SOURCE_PREFIX = '<dsh_im_source';

/** 提取消息纯文本。 */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => (block as { type?: string })?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** dsh-im 宿主服务的最小投影（只用到同步反查）。 */
interface DshImServiceLike {
  describeConversationSync?: (sessionId: string) => unknown;
}

/**
 * 消息里是否带 dsh-im 的来源标记。
 *
 * 当前 dsh-im 把 `<dsh_im_source>…</dsh_im_source>` 拼在**用户消息文本开头**；
 * 旧形态是独立消息（`source.kind === 'plugin:dsh-im'`）。两种都认。
 *
 * @param messages - 本步消息。
 * @returns 是否来自 IM。
 */
function hasImMarker(messages: readonly unknown[]): boolean {
  for (const message of messages) {
    if ((message as { source?: { kind?: string } })?.source?.kind === IM_SOURCE_KIND) return true;
    if (textOf(message).trimStart().startsWith(IM_SOURCE_PREFIX)) return true;
  }
  return false;
}

/**
 * 会话是否绑定在某个 IM 对话上（只是弱信号：同一会话也能被 Web 驱动）。
 *
 * @param ctx - 宿主上下文。
 * @param sessionId - 会话 id。
 * @returns 是否绑定。
 */
function isImBound(ctx: Context, sessionId: string): boolean {
  try {
    const service = (ctx as unknown as { dshIm?: DshImServiceLike }).dshIm;
    if (typeof service?.describeConversationSync !== 'function') return false;
    return service.describeConversationSync(sessionId) !== null;
  } catch {
    return false;
  }
}

/**
 * 判定本轮动作该走哪条交付链。
 *
 * - `im`：消息带 IM 来源标记 → 只允许 `dsh_im_return_file`；
 * - `auto`：无标记但会话绑定 IM（可能是 Web 打开的同一会话）→ 先试 IM，consumer 不活跃再退回 present；
 * - `local`：其余 → `present`。
 *
 * @param messages - 本步消息。
 * @param ctx - 宿主上下文（可缺省，缺省即退化为只看标记）。
 * @param sessionId - 会话 id。
 * @returns 交付来源。
 */
export function turnOriginOf(messages: readonly unknown[], ctx?: Context, sessionId?: string): 'im' | 'auto' | 'local' {
  if (hasImMarker(messages)) return 'im';
  if (ctx && sessionId && isImBound(ctx, sessionId)) return 'auto';
  return 'local';
}

/** 文件是否都还在本地。 */
async function allFilesExist(files: readonly LocalFile[]): Promise<boolean> {
  for (const file of files) {
    try {
      const info = await stat(file.path);
      if (!info.isFile()) return false;
    } catch {
      return false;
    }
  }
  return files.length > 0;
}

/**
 * 安装单链路监听。
 *
 * @param ctx - 宿主上下文。
 * @param getConfig - 读取当前配置。
 * @param cache - 会话缓存。
 * @returns disposer。
 */
export function installChain(ctx: Context, getConfig: () => LinkResolverConfig, cache: SessionCache): () => void {
  // DSH 的 pre-step 决策类型只在宿主包里导出；插件按结构签名实现，避免耦合内部类型包。
  const handler = async (payload: unknown, next: () => Promise<unknown>): Promise<unknown> => {
    const { agent, messages, step, signal } = payload as {
      agent: { session: { id: string; header?: { cwd?: string } } };
      messages: unknown[];
      step: number;
      signal: AbortSignal;
    };

    // 只在每轮第一步处理，避免工具结果步骤重复触发。
    if (step !== 1) return next();
    if (signal.aborted) return next();

    const config = getConfig();
    if (!config.enabled) return next();

    const batch = messages.filter((message) => (message as { source?: { kind?: string } })?.source?.kind !== 'link-resolver');
    const text = batch.map(textOf).join('\n');
    if (text.length === 0) return next();

    const supported = extractLinks(text).filter((link) => {
      const detection = detectPlatform(link);
      return detection !== null && config.enabledPlatforms.includes(detection.platform);
    });
    if (supported.length === 0) return next();

    const url = supported[0]!;
    const skipped = supported.slice(1);
    const sessionId = agent.session.id;
    const workspace = agent.session.header?.cwd ?? process.cwd();
    const origin = turnOriginOf(batch, ctx, sessionId);
    if (!workspaceAllowed(config, workspace)) {
      ctx.logger.info(`link-resolver: 工作区被过滤，跳过 ${workspace}`);
      return next();
    }
    const exec = { agent, signal, origin };
    // 保留策略：按工作区节流清理过期内容目录，并让缓存把已删文件判为不可复用。
    await maybeCleanup(ctx, config, workspace, cache);
    const label = PLATFORM_BY_ID[detectPlatform(url)!.platform].label;

    // 必须先走完 pre-step 链条再追加自己的 notice：直接 return 会短路后续监听器。
    // dsh-im 的全局监听器就在下游，它负责把消息里的 <dsh_im_source> 等内联块拆成独立消息。
    let base: unknown[] = messages;
    try {
      const downstream = (await next()) as { kind?: string; messages?: unknown[] } | undefined;
      if (signal.aborted) return downstream ?? { kind: 'enter', messages };
      if (downstream?.kind === 'enter' && Array.isArray(downstream.messages)) base = downstream.messages;
    } catch (error) {
      ctx.logger.warn(`link-resolver: 下游 pre-step 失败，按原始消息继续：${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const cached = cache.get(sessionId, url);
      if (cached?.downloads?.length && (await allFilesExist(cached.downloads))) {
        ctx.logger.info(`link-resolver: 命中会话缓存 ${url}（${cached.downloads.length} 个文件）`);
        const delivery = await deliverFiles(ctx, exec, cached.downloads, formatSummary(cached, cached.downloads));
        const refs = cached.downloads.map((file) => relative(workspace, file.path));
        const body = successText({ result: cached, delivery, origin, fileCount: cached.downloads.length, fileRefs: refs, reused: true, skipped, toolEnabled: config.toolEnabled });
        return { kind: 'enter' as const, messages: [...base, notice(body, delivery.ok ? '链接已处理' : '文件未交付')] };
      }

      // 元数据还在但文件被保留策略清理：只补下载，不重新解析。
      if (cached && config.downloadMedia) {
        ctx.logger.info(`link-resolver: 缓存命中但文件已清理，补下载 ${url}`);
        try {
          const refilled = await downloadMedia(cached, config, exec);
          if (refilled.length > 0) {
            const result = { ...cached, downloads: refilled };
            cache.set(sessionId, url, result);
            const delivery = await deliverFiles(ctx, exec, refilled, formatSummary(result, refilled));
            const refs = refilled.map((file) => relative(workspace, file.path));
            const body = successText({ result, delivery, origin, fileCount: refilled.length, fileRefs: refs, skipped, toolEnabled: config.toolEnabled });
            return { kind: 'enter' as const, messages: [...base, notice(body, delivery.ok ? '链接已处理' : '文件未交付')] };
          }
        } catch (error) {
          ctx.logger.warn(`link-resolver: 补下载失败，改为完整重解析 ${url}：${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const outcome = await processLink(ctx, url, config, exec, { deliver: false });
      if (!outcome.result) {
        const code = outcome.error?.code ?? 'unknown';
        const message = outcome.error?.message ?? '未知错误';
        ctx.logger.warn(`link-resolver: 处理失败 ${url} code=${code} message=${message}`);
        return { kind: 'enter' as const, messages: [...base, notice(failureText(label, code, message, skipped, config.toolEnabled), '链接处理失败')] };
      }

      const result = outcome.result;
      cache.set(sessionId, url, result);
      const note = result.warnings.filter((warning) => warning.startsWith('下载失败')).join('；');

      if (outcome.files.length === 0) {
        ctx.logger.info(`link-resolver: 无可交付媒体 ${url}${note ? `（${note}）` : ''}`);
        const body = successText({ result, origin, fileCount: 0, fileRefs: [], ...(note ? { note } : {}), ...(skipped.length > 0 ? { skipped } : {}), toolEnabled: config.toolEnabled });
        return { kind: 'enter' as const, messages: [...base, notice(body, '链接已处理')] };
      }

      const delivery = await deliverFiles(ctx, exec, outcome.files, formatSummary(result, outcome.files));
      const refs = outcome.files.map((file) => relative(workspace, file.path));
      ctx.logger.info(
        `link-resolver: 处理完成 ${url} files=${outcome.files.length} origin=${origin} delivery=${delivery.ok ? delivery.channel : `failed(${delivery.code})`}`,
      );
      const body = successText({
        result,
        delivery,
        origin,
        fileCount: outcome.files.length,
        fileRefs: refs,
        ...(note ? { note } : {}),
        ...(skipped.length > 0 ? { skipped } : {}),
        toolEnabled: config.toolEnabled,
      });
      return { kind: 'enter' as const, messages: [...base, notice(body, delivery.ok ? '链接已处理' : '文件未交付')] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(`link-resolver: 自动处理异常 ${url} ${message}`);
      return { kind: 'enter' as const, messages: [...base, notice(failureText(label, 'internal', message, skipped, config.toolEnabled), '链接处理失败')] };
    }
  };

  return ctx.on('agent/pre-step', handler as never) as () => void;
}