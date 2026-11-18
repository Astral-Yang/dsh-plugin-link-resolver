/**
 * 下载目录保留策略：按内容目录的最后修改时间清理过期媒体。
 *
 * 目录结构沿用 `docs/download-layout.md`：`<workspace>/<downloadDir>/<platform>/<contentId>/`。
 * 只删 `contentId` 这一级目录，且删除前校验解析后的路径仍在下载根目录之下。
 *
 * @module dsh-plugin-link-resolver/adapter/retention
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';

import type { SessionCache } from '../core/cache.js';
import type { LinkResolverConfig } from './config.js';

/** 清理节流：同一工作区两次清理的最小间隔。 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** 进程内节流表：工作区 → 上次清理时间。 */
const lastCleanup = new Map<string, number>();

/** 清理结果。 */
export interface CleanupResult {
  /** 下载根目录。 */
  base: string;
  /** 本轮删除的内容目录。 */
  removed: string[];
}

/**
 * 下载根目录（相对路径按会话工作区解析）。
 *
 * @param config - 插件配置。
 * @param workspace - 会话工作区。
 * @returns 绝对路径。
 */
export function downloadBase(config: LinkResolverConfig, workspace: string): string {
  return isAbsolute(config.downloadDir) ? config.downloadDir : join(workspace, config.downloadDir);
}

/**
 * 清理下载根目录下超过保留期的内容目录。
 *
 * @param config - 插件配置。
 * @param workspace - 会话工作区。
 * @returns 清理结果；目录不存在时返回空结果。
 */
export async function cleanupExpired(config: LinkResolverConfig, workspace: string): Promise<CleanupResult> {
  const base = downloadBase(config, workspace);
  const retainDays = Number.isFinite(config.retainDays) ? config.retainDays : 7;
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  let platforms: string[];
  try {
    platforms = (await readdir(base, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return { base, removed };
  }

  const baseResolved = resolve(base);
  for (const platform of platforms) {
    const platformDir = join(base, platform);
    let contents: string[];
    try {
      contents = (await readdir(platformDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const contentId of contents) {
      const target = join(platformDir, contentId);
      // 删除前校验：目标必须仍是下载根目录之下的一级子目录。
      const rel = relative(baseResolved, resolve(target));
      if (rel.startsWith('..') || rel.includes('..')) continue;
      try {
        const info = await stat(target);
        if (!info.isDirectory() || info.mtimeMs >= cutoff) continue;
        await rm(target, { recursive: true, force: true });
        removed.push(target);
      } catch {
        // 单个目录失败不影响其余
      }
    }
  }

  return { base, removed };
}

/**
 * 节流清理 + 同步失效缓存条目。
 *
 * @param ctx - 宿主上下文。
 * @param config - 插件配置。
 * @param workspace - 会话工作区。
 * @param cache - 会话缓存。
 * @returns 本次是否真的执行了清理。
 */
export async function maybeCleanup(
  ctx: Context,
  config: LinkResolverConfig,
  workspace: string,
  cache: SessionCache,
): Promise<boolean> {
  const now = Date.now();
  const previous = lastCleanup.get(workspace) ?? 0;
  if (now - previous < CLEANUP_INTERVAL_MS) return false;
  lastCleanup.set(workspace, now);

  try {
    const { base, removed } = await cleanupExpired(config, workspace);
    if (removed.length === 0) return true;
    let dropped = 0;
    for (const dir of removed) dropped += cache.dropUnder(dir);
    ctx.logger.info(`link-resolver: 保留策略清理 ${removed.length} 个过期内容目录（${base}），失效缓存条目 ${dropped} 个`);
    return true;
  } catch (error) {
    ctx.logger.warn(`link-resolver: 保留策略清理失败 ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * 工作区是否允许处理（`allow` 只处理列表内；`deny` 跳过列表内）。
 *
 * 列表项按路径前缀匹配：`/a/b` 同时匹配 `/a/b` 与 `/a/b/c`。
 *
 * @param config - 插件配置。
 * @param workspace - 会话工作区。
 * @returns 是否允许。
 */
export function workspaceAllowed(config: LinkResolverConfig, workspace: string): boolean {
  const list = config.workspaceList ?? [];
  if (list.length === 0) return true;
  const normalized = workspace.replace(/\/+$/, '');
  const hit = list.some((entry) => {
    const prefix = entry.replace(/\/+$/, '');
    return prefix.length > 0 && (normalized === prefix || normalized.startsWith(`${prefix}/`));
  });
  return config.workspaceFilterMode === 'allow' ? hit : !hit;
}