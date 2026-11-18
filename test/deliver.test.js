/**
 * 交付判定单测：按本轮来源选择唯一通道，auto 只在 consumer 缺失时退回 present。
 *
 * @module test/deliver
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { deliverFiles } from '../lib/adapter/pipeline.js';

const FILES = [{ path: '/tmp/media/01.mp4', bytes: 1024, kind: 'video' }];

/** 构造带交付工具的假 ctx。 */
function fakeCtx({ im, present, imFailure, imSuccess = true }) {
  const executed = [];
  return {
    executed,
    ctx: {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      tools: {
        get(name) {
          if (name === 'dsh_im_return_file') return im ? { name } : undefined;
          if (name === 'present') return present ? { name } : undefined;
          return undefined;
        },
        async execute(input) {
          executed.push(input.calls);
          const isIm = input.calls[0].name === 'dsh_im_return_file';
          const result = isIm
            ? imSuccess
              ? { isError: false, value: { artifactId: 'a1' }, content: [] }
              : { isError: true, error: imFailure ?? { message: 'No active IM delivery consumer owns this turn.' }, content: [] }
            : { isError: false, value: {}, content: [] };
          return {
            results: input.calls.map((call) => ({ callId: call.id, result })),
            additionalContexts: [],
            concluded: false,
          };
        },
      },
    },
  };
}

/** 执行一次交付。 */
async function deliver(ctx, origin) {
  return deliverFiles(ctx, { agent: { session: { id: 's1' } }, signal: new AbortController().signal, origin }, FILES, '摘要');
}

test('deliver：IM 轮次成功时只调 dsh_im_return_file', async () => {
  const { ctx, executed } = fakeCtx({ im: true, present: true });
  const outcome = await deliver(ctx, 'im');
  assert.deepEqual(outcome, { ok: true, channel: 'im', delivered: 1 });
  assert.equal(executed.length, 1);
  assert.equal(executed[0][0].name, 'dsh_im_return_file');
});

test('deliver：IM 轮次 consumer 缺失时不退回 present', async () => {
  const { ctx, executed } = fakeCtx({ im: true, present: true, imSuccess: false });
  const outcome = await deliver(ctx, 'im');
  assert.equal(outcome.ok, false);
  assert.match(outcome.code, /artifact-consumer-required|tool-error/);
  assert.equal(executed.length, 1, 'present 不应被调用');
});

test('deliver：auto 轮次 consumer 缺失时退回 present', async () => {
  const { ctx, executed } = fakeCtx({ im: true, present: true, imSuccess: false });
  const outcome = await deliver(ctx, 'auto');
  assert.deepEqual(outcome, { ok: true, channel: 'present', delivered: 1 });
  assert.deepEqual(
    executed.map((calls) => calls[0].name),
    ['dsh_im_return_file', 'present'],
  );
});

test('deliver：auto 轮次非 consumer 失败不退回 present', async () => {
  const { ctx, executed } = fakeCtx({
    im: true,
    present: true,
    imSuccess: false,
    imFailure: { message: 'The requested file is unavailable.', info: { name: 'HarnessError', code: 'artifact-unavailable' } },
  });
  const outcome = await deliver(ctx, 'auto');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'artifact-unavailable');
  assert.equal(executed.length, 1, 'present 不应被调用');
});

test('deliver：local 轮次只调 present，且最多 4 个文件', async () => {
  const many = Array.from({ length: 6 }, (_, index) => ({ path: `/tmp/media/0${index}.png`, bytes: 1, kind: 'image' }));
  const { ctx, executed } = fakeCtx({ im: true, present: true });
  const outcome = await deliverFiles(
    ctx,
    { agent: { session: { id: 's1' } }, signal: new AbortController().signal, origin: 'local' },
    many,
    '',
  );
  assert.deepEqual(outcome, { ok: true, channel: 'present', delivered: 4 });
  assert.equal(executed.length, 1);
  assert.equal(executed[0][0].name, 'present');
  const args = JSON.parse(executed[0][0].arguments);
  assert.equal(args.files.length, 4);
});