/**
 * 签名模块 golden-vector 测试：直接比对参考 Python 实现的输出。
 *
 * @module test/sign
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ABogus } from '../lib/sign/abogus.js';
import { sign as webSign } from '../lib/sign/websign.js';

const abogusVectors = JSON.parse(readFileSync(new URL('./fixtures/abogus-vectors.json', import.meta.url), 'utf8'));
const websignVectors = JSON.parse(readFileSync(new URL('./fixtures/websign-vectors.json', import.meta.url), 'utf8'));

test('a_bogus：与参考 Python 实现逐字节一致（3 组向量）', () => {
  for (const item of abogusVectors.cases) {
    const abogus = new ABogus({
      userAgent: item.ua,
      fingerprint: item.fp,
      now: () => item.now,
      randomPrefix: () => abogusVectors.fixedPrefix,
    });
    const result = abogus.generate(item.params, item.body);
    assert.equal(result.signature, item.a_bogus, `case ${item.name}`);
    assert.equal(result.params, item.params_with, `case ${item.name} params`);
  }
});

test('WebSign：与参考 Python 实现一致', () => {
  for (const item of websignVectors.cases) {
    const result = webSign(item.query, item.uifid, item.timestamp);
    assert.equal(result.signature, item.signature, `case ${item.timestamp}`);
    assert.equal(result.query, item.signedQuery, `case ${item.timestamp} query`);
  }
});