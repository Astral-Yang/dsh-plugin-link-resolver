/**
 * P0 冒烟测试：验证插件入口可加载、工具可注册、`execute` 与 `render` 契约成立。
 *
 * 这是「不依赖 LLM」的链路验证：用最小的假 Context 驱动真实的 `defineTool`
 * 运行时，因此覆盖的是我们自己代码与 DSH 工具契约的接缝。
 *
 * @module test/p0-smoke
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import plugin, { Config, apply, inject, name } from '../lib/index.js';
import { DEFAULTS } from '../lib/adapter/config.js';

/** 默认配置（用 Schema 自身补默认值，确保与运行时一致）。 */
function defaults() {
  return Config({});
}

/** 构造最小可用的假 Context。 */
function fakeContext() {
  const registered = [];
  const effects = [];
  const injected = [];
  return {
    registered,
    effects,
    injected,
    ctx: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      effect(fn) {
        const dispose = fn();
        effects.push(dispose);
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      },
      inject(services) {
        injected.push(services);
      },
      on() {
        return () => {};
      },
      tools: {
        register(definition) {
          registered.push(definition);
          return () => {};
        },
      },
    },
  };
}

test('插件导出 shape 符合 Cordis 约定', () => {
  assert.equal(name, 'link-resolver');
  assert.deepEqual(inject, ['tools']);
  assert.equal(typeof apply, 'function');
  assert.equal(typeof Config, 'function');
  assert.equal(plugin.name, name);
  assert.equal(plugin.apply, apply);
});

test('Schema 字段与 DEFAULTS 保持一致（防止漏声明）', () => {
  assert.deepEqual(Object.keys(Config({})).sort(), Object.keys(DEFAULTS).sort());
});

test('不再向系统提示注入静态引导', () => {
  const { ctx, injected } = fakeContext();
  apply(ctx, defaults());
  assert.deepEqual(injected.filter((services) => services.includes('systemPrompt')), []);
});

test('总开关关闭时不注册工具', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { ...defaults(), enabled: false });
  assert.equal(registered.length, 0);
});

test('默认配置不注册 resolve_link 工具（toolEnabled=false）', () => {
  const { ctx, registered, effects } = fakeContext();
  apply(ctx, defaults());
  assert.equal(registered.length, 0);
  assert.ok(effects.length >= 1);
});

test('toolEnabled=true 时注册一个 resolve_link 工具', () => {
  const { ctx, registered, effects } = fakeContext();
  apply(ctx, { ...defaults(), toolEnabled: true });
  assert.equal(registered.length, 1);
  const tool = registered[0];
  assert.equal(tool.name, 'resolve_link');
  assert.ok(tool.description.length > 0);
  // defineTool 会把参数 DSL 编译为 JSON Schema：{ type, properties, required[] }
  assert.equal(tool.parameters.type, 'object');
  assert.equal(tool.parameters.properties.url.type, 'string');
  assert.deepEqual(tool.parameters.required, ['url']);
  assert.equal(typeof tool.output.render, 'function');
  assert.ok(tool.output.schema);
  assert.ok(effects.length >= 1);
});

test('execute：B站链接识别出平台与 BV 号', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { ...defaults(), toolEnabled: true, enabledPlatforms: [] });
  const tool = registered[0];
  const value = await tool.execute({ url: 'https://www.bilibili.com/video/BV1xx411c7mD' }, {});
  assert.equal(value.platform, 'bilibili');
  assert.equal(value.ok, false);
});

test('execute：各平台识别（只测识别，不触发网络）', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { ...defaults(), toolEnabled: true, enabledPlatforms: [] });
  const tool = registered[0];
  const cases = [
    ['https://www.xiaohongshu.com/explore/65a1b2c3d4e5f6a7b8c9d0e1', 'xiaohongshu'],
    ['https://x.com/someone/status/1234567890123456789', 'twitter'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://weibo.com/1234567890/Nabc1234567', 'weibo'],
    ['https://v.douyin.com/iRabcdef/', 'douyin'],
  ];
  for (const [url, expected] of cases) {
    const value = await tool.execute({ url }, {});
    assert.equal(value.platform, expected, `expected ${expected} for ${url}`);
    assert.equal(value.ok, false);
  }
});

test('execute：未启用平台返回 supported=false', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { ...defaults(), toolEnabled: true, enabledPlatforms: ['bilibili'] });
  const tool = registered[0];
  const value = await tool.execute({ url: 'https://x.com/someone/status/1234567890123456789' }, {});
  assert.equal(value.supported, false);
  assert.match(value.message, /未启用/);
});

test('execute：非法与不支持链接均有结构化返回', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { ...defaults(), toolEnabled: true });
  const tool = registered[0];
  const bad = await tool.execute({ url: 'not a url at all' }, {});
  assert.equal(bad.ok, false);
  const none = await tool.execute({ url: 'https://example.com/a' }, {});
  assert.equal(none.ok, false);
  assert.equal(none.platform, 'unknown');
});

test('render 输出人类可读文本', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { ...defaults(), toolEnabled: true });
  const tool = registered[0];
  const value = await tool.execute({ url: 'https://example.com/a' }, {});
  const blocks = tool.output.render({ url: 'https://example.com/a' }, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /解析失败/);
  assert.match(blocks[0].text, /unsupported-url|未识别平台/);
});