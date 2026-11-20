/**
 * FFmpeg 集成：参数数组调用、超时控制、子进程回收。
 *
 * @module dsh-plugin-link-resolver/media/ffmpeg
 */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

import { ResolveError } from '../core/result.js';

/** 探测 ffmpeg 是否可用。 */
export async function ffmpegAvailable(executable = 'ffmpeg'): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(executable, ['-version'], { stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/** 合并参数。 */
export interface MergeOptions {
  executable?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 合并音视频（`-c copy`，不转码）。
 *
 * @param videoPath - 视频轨文件。
 * @param audioPath - 音频轨文件。
 * @param outputPath - 输出文件。
 * @param options - 执行参数。
 */
export async function mergeAv(videoPath: string, audioPath: string, outputPath: string, options: MergeOptions = {}): Promise<void> {
  const args = ['-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', outputPath];
  await runFfmpeg(options.executable ?? 'ffmpeg', args, outputPath, options);
}

/**
 * 从视频里抽音频（转 MP3）。
 *
 * @param inputPath - 输入视频。
 * @param outputPath - 输出音频。
 * @param options - 执行参数（可加码率）。
 */
export async function extractAudio(
  inputPath: string,
  outputPath: string,
  options: MergeOptions & { bitrateKbps?: number } = {},
): Promise<void> {
  const bitrate = options.bitrateKbps ?? 192;
  const args = ['-y', '-i', inputPath, '-vn', '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, outputPath];
  await runFfmpeg(options.executable ?? 'ffmpeg', args, outputPath, options);
}

/**
 * 运行一次 ffmpeg，失败或超时时清理输出文件。
 *
 * @param executable - ffmpeg 可执行文件。
 * @param args - 参数数组。
 * @param outputPath - 预期输出（失败时删除）。
 * @param options - 执行参数。
 */
async function runFfmpeg(executable: string, args: string[], outputPath: string, options: MergeOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 300_000;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ResolveError('download-failed', `ffmpeg 超时（${timeoutMs}ms）`));
    }, timeoutMs);

    const onAbort = (): void => {
      child.kill('SIGKILL');
      reject(new ResolveError('download-failed', 'ffmpeg 已取消'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new ResolveError('tool-missing', `无法启动 ffmpeg：${error.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new ResolveError('download-failed', `ffmpeg 退出码 ${code}：${stderr.slice(-400)}`));
    });
  }).catch(async (error) => {
    await rm(outputPath, { force: true }).catch(() => {});
    throw error;
  });
}