/**
 * 注入文案与来源判定单测：不依赖 ctx，只验证纯函数输出。
 *
 * @module test/notice
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { describeResult, failureText, notice, successText } from '../lib/adapter/notice.js';
import { turnOriginOf } from '../lib/adapter/chain.js';

/** 构造一条解析结果。 */
function sampleResult() {
  return {
    platform: 'xiaohongshu',
    url: 'https://www.xiaohongshu.com/explore/abc',
    originalUrl: 'https://xhslink.cn/o/abc',
    type: 'mixed',
    title: '朽骨与旧梦',
    author: '鸣潮',
    durationSec: 10,
    media: [
      { kind: 'video', url: 'https://example.com/v.mp4' },
      { kind: 'image', url: 'https://example.com/i.png' },
    ],
    warnings: [],
  };
}

test('describeResult：平台 / 标题 / 作者 / 时长 / 媒体构成', () => {
  const line = describeResult(sampleResult());
  assert.match(line, /小红书/);
  assert.match(line, /朽骨与旧梦/);
  assert.match(line, /作者：鸣潮/);
  assert.match(line, /0:10/);
  assert.match(line, /1 个视频 \/ 1 张图片/);
});

test('successText：IM 交付说「已登记」，不得声称用户已收到', () => {
  const text = successText({
    result: sampleResult(),
    delivery: { ok: true, channel: 'im', delivered: 2 },
    origin: 'im',
    fileCount: 2,
    fileRefs: [],
  });
  assert.match(text, /已登记 2 个文件/);
  assert.match(text, /IM 渠道发送/);
  assert.match(text, /不要说"用户已收到"/);
  assert.match(text, /不要再调用 resolve_link/);
});

test('successText：Web 交付写明卡片与剩余文件数', () => {
  const text = successText({
    result: sampleResult(),
    delivery: { ok: true, channel: 'present', delivered: 4 },
    origin: 'local',
    fileCount: 6,
    fileRefs: [],
  });
  assert.match(text, /对话文件卡片交付 4 个文件/);
  assert.match(text, /另有 2 个在下载目录/);
});

test('successText：交付失败给出原因码与相对路径，且禁止伪造送达', () => {
  const text = successText({
    result: sampleResult(),
    delivery: { ok: false, code: 'im-consumer-inactive', message: '本轮没有活跃的 IM 投递通道', delivered: 0 },
    origin: 'im',
    fileCount: 2,
    fileRefs: ['downloads/xiaohongshu/abc/01.png', 'downloads/xiaohongshu/abc/02.mp4'],
  });
  assert.match(text, /未完成（im-consumer-inactive）/);
  assert.match(text, /downloads\/xiaohongshu\/abc\/01\.png/);
  assert.match(text, /不要声称已经发送文件/);
  assert.match(text, /无法通过 IM 投递/);
});

test('successText：命中缓存与下载失败各有明确说明', () => {
  const cached = successText({
    result: sampleResult(),
    delivery: { ok: true, channel: 'present', delivered: 2 },
    origin: 'local',
    fileCount: 2,
    fileRefs: [],
    reused: true,
    skipped: ['https://v.douyin.com/abc/'],
  });
  assert.match(cached, /命中会话缓存/);
  assert.match(cached, /另有 1 条受支持链接本轮未处理/);

  const failed = successText({ result: sampleResult(), origin: 'local', fileCount: 0, fileRefs: [], note: '下载失败：timeout' });
  assert.match(failed, /媒体下载失败，没有可交付的文件/);
  assert.match(failed, /提示：下载失败：timeout/);
});

test('failureText：带原因码并要求不重试', () => {
  const text = failureText('小红书', 'download-failed', '下载超时');
  assert.match(text, /本轮自动处理失败：小红书 · code=download-failed/);
  assert.match(text, /原因：下载超时/);
  assert.match(text, /不要调用 resolve_link 重试/);
});

test('notice：source 为 link-resolver / notice', () => {
  const message = notice('正文', '链接已处理');
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'link-resolver');
  assert.equal(message.source.form, 'notice');
  assert.equal(message.content[0].text, '正文');
});

test('turnOriginOf：两种 dsh-im 来源标记都判定为 IM 轮次', () => {
  // 旧形态：独立的 plugin:dsh-im 消息
  assert.equal(turnOriginOf([{ source: { kind: 'plugin:dsh-im' } }]), 'im');
  // 当前形态：<dsh_im_source> 拼在用户消息文本开头
  assert.equal(
    turnOriginOf([{ content: [{ type: 'text', text: '<dsh_im_source>{"channel":"weixin"}</dsh_im_source>\n\n正文' }], source: { kind: 'user' } }]),
    'im',
  );
  // 用户自己引用该标记但不在开头时，不误判
  assert.equal(
    turnOriginOf([{ content: [{ type: 'text', text: '看看这段 <dsh_im_source> 是什么' }], source: { kind: 'user' } }]),
    'local',
  );
  assert.equal(turnOriginOf([{ source: { kind: 'user', rpcId: 'web-1' } }]), 'local');
  assert.equal(turnOriginOf([]), 'local');
});

test('turnOriginOf：无标记但会话绑定 IM 时退化为 auto', () => {
  const ctx = { dshIm: { describeConversationSync: (id) => (id === 'im-session' ? { channel: 'weixin' } : null) } };
  assert.equal(turnOriginOf([{ source: { kind: 'user' } }], ctx, 'im-session'), 'auto');
  assert.equal(turnOriginOf([{ source: { kind: 'user' } }], ctx, 'web-session'), 'local');
  assert.equal(turnOriginOf([{ source: { kind: 'user' } }], undefined, 'im-session'), 'local');
});