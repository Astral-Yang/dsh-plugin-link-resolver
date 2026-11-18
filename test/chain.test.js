/**
 * 单链路 pre-step 单测：命中会话缓存时不重新解析，直接复用并重新交付。
 *
 * 只覆盖不触网的路径（缓存命中 / 无链接 / 非首步），真实解析下载由 headless 端到端验证。
 *
 * @module test/chain
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { installChain } from '../lib/adapter/chain.js';
import { SessionCache } from '../lib/core/cache.js';

/** 构造最小可用的假 ctx。 */
function fakeCtx() {
  const listeners = new Map();
  const executed = [];
  return {
    executed,
    ctx: {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      on(name, fn) {
        listeners.set(name, fn);
        return () => listeners.delete(name);
      },
      tools: {
        get(name) {
          return name === 'present' ? { name } : undefined;
        },
        async execute(input) {
          executed.push(input);
          return {
            results: input.calls.map((call) => ({ callId: call.id, result: { isError: false, value: {}, content: [] } })),
            additionalContexts: [],
            concluded: false,
          };
        },
      },
    },
    /** 触发一次 pre-step；记录下游 next() 是否被调用。 */
    async firePreStep(payload, { downstream = [], calls } = {}) {
      const handler = listeners.get('agent/pre-step');
      assert.ok(handler, 'pre-step listener not registered');
      return handler(payload, async () => {
        if (calls) calls.next += 1;
        return { kind: 'enter', messages: downstream };
      });
    },
  };
}

/** 构造一条已下载的结果。 */
function sampleResult(filePath) {
  return {
    platform: 'twitter',
    url: 'https://x.com/a/status/20',
    originalUrl: 'https://x.com/a/status/20',
    type: 'video',
    title: '示例视频',
    author: 'someone',
    media: [{ kind: 'video', url: 'https://example.com/v.mp4' }],
    downloads: [{ path: filePath, bytes: 1024, kind: 'video' }],
    warnings: [],
  };
}

/** pre-step 载荷。 */
function payloadFor(text, workspace, step = 1) {
  return {
    agent: { session: { id: 's1', header: { cwd: workspace } } },
    messages: [
      { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
    ],
    turn: 1,
    step,
    signal: new AbortController().signal,
  };
}

test('chain：命中会话缓存 → 不重新解析、直接重新交付', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lr-chain-'));
  const file = join(dir, '01.mp4');
  await writeFile(file, 'x');

  const { ctx, firePreStep, executed } = fakeCtx();
  const cache = new SessionCache(3600_000);
  cache.set('s1', 'https://x.com/a/status/20', sampleResult(file));
  installChain(ctx, () => ({ enabled: true, enabledPlatforms: ['twitter'], downloadMedia: true, retainDays: 7, workspaceList: [], workspaceFilterMode: 'deny' }), cache);

  const calls = { next: 0 };
  const downstream = [{ role: 'user', content: [{ type: 'text', text: '下游注入的上下文' }], source: { kind: 'runtime-context' } }];
  const decision = await firePreStep(payloadFor('看看这个 https://x.com/a/status/20', dir), { downstream, calls });
  assert.equal(decision.kind, 'enter');
  assert.equal(calls.next, 1, '必须调用 next()，否则会短路下游 pre-step 监听器');
  assert.equal(decision.messages[0].source.kind, 'runtime-context', '下游消息应保留在前');
  const injected = decision.messages.at(-1);
  assert.equal(injected.source.kind, 'link-resolver');
  const body = injected.content[0].text;
  assert.match(body, /命中会话缓存/);
  assert.match(body, /对话文件卡片交付 1 个文件/);
  assert.match(body, /不要再调用 resolve_link/);

  assert.equal(executed.length, 1, 'present 应被调用一次');
  assert.equal(executed[0].calls[0].name, 'present');
});

test('chain：消息里没有受支持链接时不接管本轮', async () => {
  const { ctx, firePreStep, executed } = fakeCtx();
  installChain(ctx, () => ({ enabled: true, enabledPlatforms: ['twitter'], downloadMedia: true, retainDays: 7, workspaceList: [], workspaceFilterMode: 'deny' }), new SessionCache(1000));

  const decision = await firePreStep(payloadFor('今天没有链接', '/tmp'));
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 0);
  assert.equal(executed.length, 0);
});

test('chain：非首步与停用平台都不处理', async () => {
  const { ctx, firePreStep, executed } = fakeCtx();
  installChain(ctx, () => ({ enabled: true, enabledPlatforms: ['xiaohongshu'], downloadMedia: true, retainDays: 7, workspaceList: [], workspaceFilterMode: 'deny' }), new SessionCache(1000));

  const secondStep = await firePreStep(payloadFor('https://x.com/a/status/20', '/tmp', 2));
  assert.equal(secondStep.messages.length, 0);

  const disabled = await firePreStep(payloadFor('https://x.com/a/status/20', '/tmp'));
  assert.equal(disabled.messages.length, 0);
  assert.equal(executed.length, 0);
});