/**
 * 媒体下载：流式写入、`.part` 原子替换、大小限制、取消清理。
 *
 * @module dsh-plugin-link-resolver/media/download
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { assertSafeUrl } from '../core/http.js';
import { ResolveError } from '../core/result.js';

/** 下载参数。 */
export interface DownloadOptions {
  timeoutMs: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  retries?: number;
}

/** 下载结果。 */
export interface DownloadResult {
  path: string;
  bytes: number;
}

/** 等待若干毫秒。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/**
 * 下载一个文件。
 *
 * @param url - 直链。
 * @param dest - 目标路径（父目录会自动创建）。
 * @param options - 下载参数。
 * @returns 文件路径与实际字节数。
 */
export async function downloadFile(url: string, dest: string, options: DownloadOptions): Promise<DownloadResult> {
  const retries = options.retries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await attemptDownload(url, dest, options);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ResolveError ? error.retryable : false;
      if (!retryable || attempt === retries) break;
      await sleep(500 * 2 ** attempt, options.signal);
    }
  }
  if (lastError instanceof ResolveError) throw lastError;
  throw new ResolveError('download-failed', `下载失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** 单次下载。 */
async function attemptDownload(url: string, dest: string, options: DownloadOptions): Promise<DownloadResult> {
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const safeUrl = await assertSafeUrl(url);
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  try {
    let current = safeUrl.toString();
    let response: Response | undefined;
    for (let hop = 0; hop <= 5; hop += 1) {
      const target = await assertSafeUrl(current);
      response = await fetch(target, {
        headers: { 'User-Agent': 'Mozilla/5.0', ...(options.headers ?? {}) },
        redirect: 'manual',
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) break;
        current = new URL(location, target).toString();
        await response.body?.cancel();
        continue;
      }
      break;
    }
    if (!response) throw new ResolveError('download-failed', '下载请求未完成');
    if (!response.ok) {
      throw new ResolveError('download-failed', `下载返回 ${response.status}`, { retryable: response.status >= 500 || response.status === 429 });
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (options.maxBytes && declared > options.maxBytes) {
      throw new ResolveError('size-exceeded', `文件超过大小限制（${declared} > ${options.maxBytes}）`);
    }
    if (!response.body) throw new ResolveError('download-failed', '响应无内容');

    const stream = createWriteStream(part);
    const reader = response.body.getReader();
    let written = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (options.maxBytes && written > options.maxBytes) {
          throw new ResolveError('size-exceeded', `下载超过大小限制（>${options.maxBytes} 字节）`);
        }
        if (!stream.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => stream.once('drain', resolve));
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
    }
    if (written === 0) throw new ResolveError('download-failed', '下载内容为空');
    await rename(part, dest);
    const info = await stat(dest);
    return { path: dest, bytes: info.size };
  } catch (error) {
    await rm(part, { force: true }).catch(() => {});
    if (error instanceof ResolveError) throw error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ResolveError('timeout', `下载超时（${options.timeoutMs}ms）`, { retryable: true });
    }
    throw new ResolveError('download-failed', `下载失败：${error instanceof Error ? error.message : String(error)}`, { retryable: true, cause: error });
  }
}