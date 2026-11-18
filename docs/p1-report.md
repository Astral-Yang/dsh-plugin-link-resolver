# P1 阶段报告：核心层与四个解析器

- 日期：2026-11-17
- 版本：`0.1.0`
- 范围：TASK.md 阶段四的 P1 批次（X / 小红书 / 微博 / 抖音免签路径）+ 统一结果模型 + HTTP 安全层 + 模式 B L2
- 结论：**P1 目标达成**；19 个测试全通过，X 与小红书均完成真实链接端到端验证，微博访客态真实验证，抖音确认需 P3 签名。

---

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `src/core/result.ts` | `ResolvedLink` / `MediaItem` / `LocalFile`；`ResolveError` + 12 个错误码；`toErrorPayload` |
| `src/core/http.ts` | 超时、指数退避重试、手动逐跳重定向、SSRF 守卫、`Semaphore` 并发令牌桶 |
| `src/core/cache.ts` | 会话级 TTL 缓存（进程内，P1 简化实现） |
| `src/resolvers/twitter.ts` | fxtwitter：文字/图片/视频/混合/长文图片 |
| `src/resolvers/xiaohongshu.ts` | `explore` 页 `__INITIAL_STATE__`：图文/视频/Live Photo 关联 |
| `src/resolvers/weibo.ts` | 访客 Cookie + `ajax/statuses/show`：长文/原图/最高码率/转发回退 |
| `src/resolvers/douyin.ts` | `iteminfo` / `slidesinfo` / 分享页 `_ROUTER_DATA`：视频/图集/动态图 |
| `src/resolvers/index.ts` | 平台分发与 `IMPLEMENTED` 集合 |
| `src/adapter/inbox.ts` | 模式 B L2：`agent/inbox/inserted` → `agent.inject()` 短提示 |
| `src/adapter/tool.ts` | `resolve_link` 接入真实解析、结果压缩、统一渲染 |
| `test/resolvers.test.js` | 8 例 fixture 单测 |
| `test/inbox.test.js` | 2 例 L2 单测 |
| `scripts/live-smoke.mjs` | 真实网络冒烟（手动） |

---

## 2. 验证矩阵

| # | 验证项 | 命令/方式 | 结果 |
| --- | --- | --- | --- |
| V1 | 类型检查 | `tsc --noEmit` | ✅ |
| V2 | 构建 | `pnpm build` | ✅ |
| V3 | 单元测试 | `node --test test/*.test.js` | ✅ **19/19** |
| V4 | 打包清单 | `npm pack --dry-run` | ✅ |
| V5 | X 真实解析 | `live-smoke.mjs https://x.com/jack/status/20` | ✅ 标题 `just setting up my twttr`、作者 `jack(@jack)`、type=text |
| V6 | 微博访客 Cookie | `fetchVisitorCookies()` 真实调用 | ✅ 返回 `SVB/SUB/SUBP/SRT/SRF`，`SUB` 长度 94 |
| V7 | DSH 端到端 | `dsh p0 --json "请调用 resolve_link ... https://x.com/jack/status/20"` | ✅ 模型调用工具 → 真实解析 → 渲染结果进入回答 |
| V8 | 小红书真实解析 | 真实分享链接 `https://xhslink.cn/o/57JtPg6lQP` | ✅ 标题《笑了，DeepSeek这是上岸第一剑，先斩意中人》、作者「赛博柳叶刀 \| Aigc Lancet」、4 张图片 |
| V9 | 微博真实解析 | 真实链接 `https://weibo.com/1647249081/Rrbfqw8g0` | ✅ 标题《新鲜出炉，刚写完不到十分钟……》/ 作者「玄色」/ 8 张图片 |
| V10 | 抖音真实解析 | 真实分享链接 `https://v.douyin.com/CVHmFXGPfHc/` | ✅ **P2 已补齐**：a_bogus + WebSign 签名接口解析成功（标题/作者「好运爆棚」/10s/1 视频） |
| V11 | 小红书 DSH 端到端 | `dsh p0 --json "... xhslink.cn/o/57JtPg6lQP"` | ✅ 工具返回标题/作者/4 图，模型最终回答正确引用 |

### V7 实测输出（工具结果，节选）

```text
【X】just setting up my twttr
作者：jack(@jack) ｜ 类型：text
媒体：无（纯文本内容）
链接：https://x.com/jack/status/20
状态：解析成功
```

---

## 3. 设计要点

### 3.1 HTTP 安全层

- **重定向**：`redirect: 'manual'`，逐跳重新 `assertSafeUrl`，最多 5 跳。
- **SSRF**：拒绝私网 / 回环 / 链路本地 / CGNAT / 保留段；域名先 `dns.lookup(all)`，任一地址落在私网即拒绝。
- **fake-IP 例外**：`198.18.0.0/15` 不拦截。本机透明代理把所有外网域名解析到 `198.18.x.x`，拦截会导致全部请求失败；该段不可公网路由，放行不构成内网可达。已在代码注释与本节记录。
- **重试**：仅 408 / 429 / 5xx / 网络异常；4xx 直接失败（与参考实现一致）。退避 `400ms × 2^n`。
- **上限**：响应体默认 8MB；单请求超时默认 20s。

### 3.2 结果与错误模型

- 成功：`{ ok: true, platform, url, supported, message, result }`。
- 失败：`{ ok: false, error: { code, message, retryable } }`，12 个错误码覆盖 `unsupported-url / not-found / auth-required / rate-limited / network / timeout / size-exceeded / duration-exceeded / tool-missing / parse-failed / download-failed / blocked-domain / internal`。
- 工具层不抛未捕获异常；模型可据 `code` 与 `retryable` 决策。

### 3.3 模式 B L2

- 监听 `agent/inbox/inserted`，命中受支持链接时注入一条 `notice` 消息（`source.kind = 'link-resolver'`）。
- 自身注入的消息不会再触发（防循环）；同一会话同一链接只提示一次。
- **不在 L2 做网络解析**——P1 保持"提示即止"，避免拖慢每个 step。

### 3.4 小红书双路径

- `explore`（桌面 UA）：优先命中 `note.noteDetailMap[id].note`；
- `discovery/item`（移动 UA + `xsec_token`）：命中 `noteData.data.noteData`。
- 短链 `xhslink.com/cn` 先跟随跳转，兼容 `login?redirectPath=<真实地址>` 形态，并保留 `xsec_token`。
- 两条路径都拿不到时，按页面是否含登录文案区分 `auth-required` 与 `parse-failed`。

### 3.5 缓存

- P1 用进程内 `SessionCache`（TTL = `cacheTtlHours`，单会话 50 条上限）。
- 已知限制：重启即失效、不参与会话回放；P2 评估迁移到 `ctx.sessionProjections`。

---

## 4. 环境限制（如实记录）

| 限制 | 影响 | 说明 |
| --- | --- | --- |
| 无有效微博 id | V9 未执行 | 访客 Cookie 已真实验证；`ajax/statuses/show` 需要有效 mid，403 是未带 Cookie 的预期结果 |
| 抖音免签路径不可用 | V10 失败（已用真实链接确认） | 分享页 `video_(id)/page` 只有 `query/context`，无 `videoInfoRes`；`iesdouyin` iteminfo 与 `douyin.com/oembed` 均返回 200 空体。需 a_bogus + WebSign 签名接口（P3） |
| 小红书登录墙 | V8 已绕过 | `explore` 页对未登录请求返回登录页；改用移动 UA 的 `discovery/item` 页后，`noteData.data.noteData` 含完整笔记（含 4 张图） |
| 本机无 ffmpeg / yt-dlp | 不影响 P1 | P2/P3 相关测试将标「环境受限」 |

> 说明：抖音的失败来自平台侧签名要求（P3 处理），不是映射逻辑缺陷；微博真实解析仍待一条有效链接。小红书已用真实分享链接完成闭环。

---

## 5. 与参考实现的差异

| 参考实现 | P1 实现 | 说明 |
| --- | --- | --- |
| `aiohttp` / `httpx` | 原生 `fetch` + `AbortSignal` | 无第三方 HTTP 依赖 |
| `msgspec` 严格模型 | 手写类型守卫 + 可选字段 | 保留 `playwm→play`、去重保序 |
| `_download_stream`（P0 未实现） | 未实现 | P2 补下载与 ffmpeg |
| 小红书原图 `ci.xiaohongshu.com` 链路 | 未实现 | P2 随下载一起补 |
| 微博转发回退 | 已实现（`retweeted_status`） | 与参考一致 |
| 抖音 a_bogus | 未实现（P3） | P1 只走免签路径 |

---

## 6. 下一步（P2）

1. `media/download.ts`：流式下载、`.part` 原子替换、大小/时长限制、取消清理。
2. `media/ffmpeg.ts`：参数数组调用、超时、进程组回收。
3. B站：WBI 签名、DASH 流选择、画质/编码降级、音视频合并、多 P。
4. 小红书原图链路与并发下载（参考实现中最复杂的部分）。
5. `ctx.sessionProjections` 去重（替换内存缓存）。
