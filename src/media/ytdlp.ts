/**
 * yt-dlp CLI 封装：参数数组调用、超时、取消、JSON 解析与下载。
 *
 * @module dsh-plugin-link-resolver/media/ytdlp
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { ResolveError } from '../core/result.js';

/** 运行参数。 */
export interface YtdlpOptions {
  executable?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

/** 运行 yt-dlp 并返回 stdout。 */
async function run(args: string[], options: YtdlpOptions): Promise<string> {
  const executable = options.executable ?? 'yt-dlp';
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ResolveError('timeout', `yt-dlp 超时（${timeoutMs}ms）`, { retryable: true }));
    }, timeoutMs);
    const onAbort = (): void => {
      child.kill('SIGKILL');
      reject(new ResolveError('download-failed', 'yt-dlp 已取消'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 32 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new ResolveError('tool-missing', `无法启动 yt-dlp（${executable}）：${error.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve(stdout);
      else reject(new ResolveError('parse-failed', `yt-dlp 退出码 ${code}：${stderr.slice(-400)}`));
    });
  });
}

/** 探测 yt-dlp 是否可用。 */
export async function ytdlpAvailable(executable = 'yt-dlp'): Promise<boolean> {
  try {
    await run(['--version'], { executable, timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取视频信息（不下载）。
 *
 * @param url - 视频链接。
 * @param options - 运行参数。
 * @returns yt-dlp info dict。
 */
export async function inspect(url: string, options: YtdlpOptions = {}): Promise<Record<string, unknown>> {
  const stdout = await run(['-J', '--no-warnings', '--skip-download', '--no-playlist', url], options);
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (parsed['_type'] === 'playlist' || parsed['_type'] === 'multi_video') {
      throw new ResolveError('unsupported-url', '不是单个视频（播放列表/主页/搜索结果）', { retryable: false });
    }
    return parsed;
  } catch (error) {
    if (error instanceof ResolveError) throw error;
    throw new ResolveError('parse-failed', 'yt-dlp 返回的 JSON 无法解析', { cause: error });
  }
}

/** 下载结果。 */
export interface YtdlpDownloadResult {
  path: string;
  bytes: number;
}

/**
 * 下载视频。
 *
 * @param url - 视频链接。
 * @param outputDir - 输出目录。
 * @param options - 运行参数。
 * @param format - 格式选择器。
 * @returns 本地文件。
 */
export async function download(
  url: string,
  outputDir: string,
  options: YtdlpOptions & { format?: string } = {},
): Promise<YtdlpDownloadResult> {
  await mkdir(outputDir, { recursive: true });
  const before = new Set(await readdir(outputDir).catch(() => []));
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--no-progress',
    '-f',
    options.format ?? 'bv*[height<=1080]+ba/b[height<=1080]/best',
    '--merge-output-format',
    'mp4',
    '-o',
    join(outputDir, '%(id)s.%(ext)s'),
    ...(options.maxBytes ? ['--max-filesize', String(options.maxBytes)] : []),
    url,
  ];
  await run(args, options);

  const after = await readdir(outputDir);
  const created = after.filter((name) => !before.has(name) && !name.endsWith('.part'));
  if (created.length === 0) throw new ResolveError('download-failed', 'yt-dlp 未生成可交付文件');
  const name = created[0]!;
  const info = await stat(join(outputDir, name));
  return { path: join(outputDir, name), bytes: info.size };
}