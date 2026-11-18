/**
 * 保留策略与工作区过滤单测：用临时目录验证清理范围、缓存失效与前缀匹配。
 *
 * @module test/retention
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cleanupExpired, workspaceAllowed } from '../lib/adapter/retention.js';
import { SessionCache } from '../lib/core/cache.js';

/** 造一个内容目录，并把 mtime 设为 N 天前。 */
async function makeContent(base, platform, id, daysAgo) {
  const dir = join(base, platform, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '01.mp4'), 'x');
  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await utimes(dir, when, when);
  await utimes(join(dir, '01.mp4'), when, when);
  return dir;
}

test('workspaceAllowed：空列表全部允许', () => {
  assert.equal(workspaceAllowed({ workspaceList: [], workspaceFilterMode: 'deny' }, '/a/b'), true);
  assert.equal(workspaceAllowed({ workspaceList: [], workspaceFilterMode: 'allow' }, '/a/b'), true);
});

test('workspaceAllowed：deny 跳过列表内，allow 只放行列表内', () => {
  const config = { workspaceList: ['/home/me/work'], workspaceFilterMode: 'deny' };
  assert.equal(workspaceAllowed(config, '/home/me/work'), false);
  assert.equal(workspaceAllowed(config, '/home/me/work/proj'), false);
  assert.equal(workspaceAllowed(config, '/home/me/workshop'), true);
  assert.equal(workspaceAllowed(config, '/home/other'), true);

  const allow = { workspaceList: ['/home/me/work/'], workspaceFilterMode: 'allow' };
  assert.equal(workspaceAllowed(allow, '/home/me/work'), true);
  assert.equal(workspaceAllowed(allow, '/home/me/work/x'), true);
  assert.equal(workspaceAllowed(allow, '/home/me/other'), false);
});

test('cleanupExpired：只删超过保留期的内容目录', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'lr-retain-'));
  const base = join(workspace, 'downloads');
  const oldDir = await makeContent(base, 'douyin', 'old', 10);
  const freshDir = await makeContent(base, 'douyin', 'fresh', 1);

  const { removed } = await cleanupExpired({ retainDays: 7, downloadDir: 'downloads' }, workspace);
  assert.deepEqual(removed, [oldDir]);

  const { stat } = await import('node:fs/promises');
  await assert.rejects(stat(oldDir));
  await stat(freshDir);
});

test('cleanupExpired：目录不存在时安全返回', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'lr-retain-missing-'));
  const { removed } = await cleanupExpired({ retainDays: 7, downloadDir: 'downloads' }, workspace);
  assert.deepEqual(removed, []);
});

test('SessionCache.dropUnder：引用被删目录的条目失效', async () => {
  const cache = new SessionCache(60 * 60 * 1000);
  const under = '/tmp/lr-cache/douyin/old';
  const other = '/tmp/lr-cache/douyin/fresh';
  const make = (path) => ({ platform: 'douyin', url: 'u', originalUrl: 'u', type: 'video', media: [], warnings: [], downloads: [{ path: `${path}/01.mp4`, bytes: 1, kind: 'video' }] });
  cache.set('s1', 'u-old', make(under));
  cache.set('s1', 'u-fresh', make(other));

  assert.equal(cache.dropUnder(under), 1);
  assert.equal(cache.get('s1', 'u-old'), undefined);
  assert.ok(cache.get('s1', 'u-fresh'));
});