/**
 * 链接提取单测：覆盖 Markdown 包裹、中文标点、多链接与去重。
 *
 * @module test/url
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { extractLinks, normalizeUrl } from '../lib/core/url.js';

test('extractLinks：Markdown 链接只取目标，不吞 ](', () => {
  const links = extractLinks('[https://xhslink.cn/o/6m7HmbcEgnj](https://xhslink.cn/o/6m7HmbcEgnj)');
  assert.deepEqual(links, ['https://xhslink.cn/o/6m7HmbcEgnj']);
});

test('extractLinks：Markdown 链接里的文字与目标不同', () => {
  const links = extractLinks('看这个 [B站视频](https://www.bilibili.com/video/BV1xx411c7mD?p=2) 挺有意思');
  assert.deepEqual(links, ['https://www.bilibili.com/video/BV1xx411c7mD?p=2']);
});

test('extractLinks：残缺 Markdown（缺右括号）仍能取到裸链接', () => {
  const links = extractLinks('[https://b23.tv/abc](https://b23.tv/abc');
  assert.deepEqual(links, ['https://b23.tv/abc']);
});

test('extractLinks：中文标点与括号结尾被剔除', () => {
  assert.deepEqual(extractLinks('链接：https://b23.tv/abc）。'), ['https://b23.tv/abc']);
  assert.deepEqual(extractLinks('（https://b23.tv/abc）'), ['https://b23.tv/abc']);
});

test('extractLinks：多条链接保序去重', () => {
  const links = extractLinks('[一](https://b23.tv/a) 和二 https://b23.tv/b 以及 https://b23.tv/a');
  assert.deepEqual(links, ['https://b23.tv/a', 'https://b23.tv/b']);
});

test('normalizeUrl：补 scheme 并拒绝非 http(s)', () => {
  assert.equal(normalizeUrl('b23.tv/abc'), 'https://b23.tv/abc');
  assert.equal(normalizeUrl('ftp://example.com/a'), '');
});