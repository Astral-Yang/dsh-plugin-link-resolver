/**
 * 音频策略单测：平台过滤、输出路径，以及一次真实 ffmpeg 转换。
 *
 * @module test/audio
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { audioTarget, deliverableFiles, wantsAudio } from '../lib/media/audio.js';
import { extractAudio, ffmpegAvailable } from '../lib/media/ffmpeg.js';

test('wantsAudio：关闭时不转，开启且列表为空时全部转', () => {
  assert.equal(wantsAudio(false, [], 'bilibili'), false);
  assert.equal(wantsAudio(false, ['bilibili'], 'bilibili'), false);
  assert.equal(wantsAudio(true, [], 'bilibili'), true);
  assert.equal(wantsAudio(true, [], 'youtube'), true);
});

test('wantsAudio：白名单只命中的平台', () => {
  assert.equal(wantsAudio(true, ['youtube', 'generic'], 'youtube'), true);
  assert.equal(wantsAudio(true, ['youtube', 'generic'], 'bilibili'), false);
});

test('audioTarget：同目录同名换扩展名（mp3）', () => {
  assert.equal(audioTarget('/a/b/video.mp4'), '/a/b/video.mp3');
  assert.equal(audioTarget('/a/b/clip.m4s'), '/a/b/clip.mp3');
  assert.equal(audioTarget('/a/b/noext'), '/a/b/noext.mp3');
});

test('deliverableFiles：音频模式排除音频，只交付视频', () => {
  const files = [
    { path: '/a/01.mp4', kind: 'video' },
    { path: '/a/01.mp3', kind: 'audio' },
  ];
  assert.deepEqual(deliverableFiles(files, true, [], 'bilibili'), [{ path: '/a/01.mp4', kind: 'video' }]);
  assert.deepEqual(deliverableFiles(files, false, [], 'bilibili'), files);
  assert.deepEqual(deliverableFiles(files, true, ['youtube'], 'bilibili'), files);
});

test('deliverableFiles：只有音频时退回全部，避免交付为空', () => {
  const audioOnly = [{ path: '/a/01.mp3', kind: 'audio' }];
  assert.deepEqual(deliverableFiles(audioOnly, true, [], 'douyin'), audioOnly);
});

test('extractAudio：真实 ffmpeg 转出 mp3', async (t) => {
  if (!(await ffmpegAvailable())) {
    t.skip('ffmpeg 未安装');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'lr-audio-'));
  const video = join(dir, 'clip.mp4');
  const audio = audioTarget(video);

  // 1 秒 160x120 测试画面 + 440Hz 正弦音
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac',
      video,
    ], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`ffmpeg 生成样例失败：${code}`))));
  });

  await extractAudio(video, audio, { timeoutMs: 30_000 });
  const info = await stat(audio);
  assert.ok(info.size > 0, '输出音频应为非空');
});