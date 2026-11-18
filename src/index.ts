/**
 * dsh-plugin-link-resolver —— Cordis 插件入口。
 *
 * 职责边界：本文件与 `adapter/` 是唯一接触 DSH API 的地方；`core/` 与 `resolvers/`
 * 只处理协议与数据，可脱离宿主单独测试。
 *
 * 单链路：用户消息含受支持链接时，插件在 `agent/pre-step` 完成「解析 → 下载 → 交付 →
 * 注入结果」，模型只负责播报，本轮以 `completed` 结束。
 *
 * @module dsh-plugin-link-resolver
 */

import type { Context } from '@deepseek-ai/cordis';

import { Config, readConfig } from './adapter/config.js';
import { installChain } from './adapter/chain.js';
import { createResolveLinkTool } from './adapter/tool.js';
import { SessionCache } from './core/cache.js';

export { Config };

/** 稳定的 Cordis 插件名。 */
export const name = 'link-resolver';

/** 仅在 `tools` 服务就绪时启动；其余服务按需可选注入。 */
export const inject = ['tools'];

/** 系统提示段：上下文里已有结果时直接采用。 */
const GUIDANCE = [
  '当用户消息中出现 B站、抖音、小红书、微博、X 或 YouTube 链接时，插件会先行解析并在上下文注入 [link-resolver] 结果。',
  '看到该结果就直接采用作答：不要再次解析、不要读取下载目录，也不要凭链接文字猜测内容。',
  '若上下文中没有该结果（插件未启用、工作区被过滤或平台不支持），按普通消息如实回答，不要编造或猜测链接内容。',
].join('');

/**
 * 插件入口。
 *
 * @param ctx - 宿主上下文。
 * @param rawConfig - 已校验配置。
 * @returns 无返回值；所有资源经 ctx.effect 注册，随插件卸载释放。
 */
export function apply(ctx: Context, rawConfig: unknown): void {
  // volatile 字段可能在运行期被设置页改写：每次使用都重新读取。
  const getConfig = () => readConfig(rawConfig);
  const config = getConfig();

  if (!config.enabled) {
    ctx.logger.info('link-resolver: 已加载，但总开关关闭');
    return;
  }

  const cache = new SessionCache(config.cacheTtlHours * 3600 * 1000);
  ctx.effect(() => () => cache.clear(), 'link-resolver: cache');

  if (config.toolEnabled) {
    ctx.effect(() => ctx.tools.register(createResolveLinkTool(getConfig, cache, ctx)), 'link-resolver: resolve_link tool');
  }

  ctx.effect(() => installChain(ctx, getConfig, cache), 'link-resolver: chain');

  // 插件自带设置卡片：告知设置服务不要额外生成 schema 表单。
  ctx.inject(['settings'], (scope) => {
    try {
      const settings = (scope as unknown as { settings?: { configure: (presentation: { auto?: boolean }, owner?: unknown) => () => void } }).settings;
      const fiber = (ctx as unknown as { fiber?: unknown }).fiber;
      if (!settings || !fiber) return;
      scope.effect(() => settings.configure({ auto: false }, fiber), 'link-resolver: settings presentation');
    } catch (error) {
      ctx.logger.warn(`link-resolver: settings.configure 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  if (config.autoGuidance) {
    // systemPrompt 为可选服务：headless / SDK 组合下可能不存在，缺失时静默跳过。
    ctx.inject(['systemPrompt'], (scope) => {
      scope.effect(
        () =>
          scope.systemPrompt.section({
            name: 'link-resolver:guidance',
            order: 40,
            text: GUIDANCE,
          }),
        'link-resolver: guidance section',
      );
    });
  }

  ctx.logger.info(
    `link-resolver: 已启用（平台=${config.enabledPlatforms.join('/') || '无'}，工具=${config.toolEnabled ? '开' : '关'}，下载=${config.downloadMedia ? '开' : '关'}）`,
  );
}

export default { name, inject, Config, apply };