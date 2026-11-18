/**
 * 真实网络冒烟脚本（手动执行，不进入 `npm test`）。
 *
 * 用法：
 *   node scripts/live-smoke.mjs <url> [url...]
 *
 * 输出每个链接的解析摘要或结构化错误；用于区分「代码缺陷」与「平台环境限制」。
 */

import { detectPlatform } from '../lib/core/registry.js';
import { resolveByPlatform } from '../lib/resolvers/index.js';

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('usage: node scripts/live-smoke.mjs <url> [url...]');
  process.exit(2);
}

for (const url of urls) {
  const detection = detectPlatform(url);
  if (!detection) {
    console.log(JSON.stringify({ url, ok: false, code: 'unsupported-url' }));
    continue;
  }
  try {
    const result = await resolveByPlatform(detection.platform, url, { timeoutMs: 20_000, retries: 1 });
    console.log(
      JSON.stringify(
        {
          url,
          ok: true,
          platform: result.platform,
          type: result.type,
          title: result.title?.slice(0, 60),
          author: result.author,
          durationSec: result.durationSec,
          mediaCount: result.media.length,
          firstMedia: result.media[0]?.url?.slice(0, 120),
          warnings: result.warnings,
        },
        null,
        1,
      ),
    );
  } catch (error) {
    console.log(
      JSON.stringify(
        { url, ok: false, code: error?.code ?? 'internal', message: String(error?.message ?? error).slice(0, 240) },
        null,
        1,
      ),
    );
  }
}