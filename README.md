# dsh-plugin-link-resolver

把 B站 / 抖音 / 小红书 / 微博 / X / YouTube（以及白名单内的通用站点）链接一步解析、下载并交付到 Web 或 IM：插件在 `agent/pre-step` 完成全部工作，模型只负责播报结果。

> **当前状态：1.0.0-rc.19（发布候选）**
> 七个解析器均已用真实链接验证；支持元数据解析与媒体下载（含 B站 DASH 合并）。
> **单链路**：用户消息含链接时由插件完成解析、下载与交付，模型只负责播报结果。
> 卡片渲染暂缓；YouTube / 通用站点依赖外部 `yt-dlp`。

## 功能

| 平台 | 解析内容 | 下载 |
| --- | --- | --- |
| B站 | 标题 / UP主 / 时长 / 简介 / 统计 / 画质列表（多 P） | 视频（DASH + ffmpeg 合并；无 ffmpeg 时 durl 单文件） |
| 抖音 | 标题 / 作者 / 时长 / 视频或图集 / 动态图（a_bogus + WebSign 签名） | 视频 / 图片 |
| 小红书 | 标题 / 作者 / 正文 / 图片 / 视频 / Live Photo | 原图（ci.xiaohongshu.com）/ 视频 |
| 微博 | 正文 / 作者 / 原图 / 最高码率视频（访客态或 Cookie） | 图片 / 视频 |
| X | 正文 / 作者 / 图片 / 视频 / 混合媒体 | 图片 / 视频 |
| YouTube | 标题 / 作者 / 时长 / 封面 / 格式列表 | 视频（yt-dlp） |
| 通用站点 | 白名单域名的单视频（TikTok / Instagram / Facebook / AcFun / Reddit 等） | 视频（yt-dlp） |

## 安装

前置：DSH `>=0.2.2-rc.1 <0.3.0-0`、Node `>=24.9.0`。

**方式一：npm（发布后）**

```bash
dsh plugin --profile <profile> add dsh-plugin-link-resolver
```

**方式二：本地 tarball（发布包验收）**

```bash
npm pack                      # 生成 dsh-plugin-link-resolver-1.0.0-rc.19.tgz
dsh plugin --profile <profile> add /absolute/path/to/dsh-plugin-link-resolver-1.0.0-rc.19.tgz
```

**方式三：本地源码（开发）**

```bash
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-link-resolver
```

包内自带 `cordis.patch.yml`，`dsh plugin add` 会同时写入 profile 的 `dsh.profile.bundles`。
安装后在 DSH 设置页或 `cordis.patch.yml` 中确认插件已启用。

## 配置

配置由 schemastery Schema 声明，**全部字段为 volatile**。安装后打开 **设置 → 插件 → dsh-plugin-link-resolver** 的详情页，
即可看到「链接解析」配置卡片（与 `dsh-free-search` 相同的 `plugins.bundle.config` 插槽）。修改即时生效；
也可以在 profile 的 `cordis.patch.yml` 覆盖，未设置的字段使用默认值。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 插件总开关 |
| `downloadMedia` | `true` | 自动链路是否下载媒体；关闭时只解析元数据，不下载、不交付 |
| `toolEnabled` | `false` | 是否向模型注册 `resolve_link` 工具；默认关闭，链接由插件自动处理 |
| `autoGuidance` | `true` | 系统提示引导：上下文已有结果时直接采用、不要重复解析 |
| `enabledPlatforms` | 六平台（不含 generic） | 平台白名单 |
| `resolveTimeoutMs` | `20000` | 单次解析超时（毫秒） |
| `downloadTimeoutMs` | `300000` | 单次下载总超时（毫秒） |
| `retryCount` | `2` | 失败重试次数 |
| `maxConcurrent` | `2` | 全局并发上限 |
| `maxMedia` | `30` | 单次结果媒体数量上限 |
| `downloadDir` | `downloads` | 下载根目录（相对会话工作区；绝对路径直接使用） |
| `maxDownloadMb` | `200` | 下载大小上限（0 不限） |
| `maxDurationSec` | `300` | 媒体时长上限（0 不限） |
| `cacheTtlHours` | `24` | 会话缓存有效期 |
| `videoMaxHeight` | `1080` | 视频下载最大高度（px） |
| `ffmpegPath` | `ffmpeg` | ffmpeg 可执行文件（名称或绝对路径） |
| `ytdlpPath` | `yt-dlp` | yt-dlp 可执行文件（名称或绝对路径） |
| `genericAllowedDomains` | TikTok/Instagram/Facebook/AcFun/Reddit/Vimeo/Dailymotion/Twitch/Bilibili TV | 通用站点白名单 |
| `weiboCookies` | `''` | 微博 Cookie（可选；留空用访客态） |
| `xhsCookies` | `''` | 小红书 Cookie（可选；登录墙时必需） |
| `xhsPreferCiPng` | `true` | 小红书优先 ci 原图 |

敏感项（Cookie）不会写入日志；建议通过 profile 的用户 patch 层或 DSH 凭据机制提供。

## 自动链路（默认行为）

用户消息里出现受支持链接时，插件在 `agent/pre-step`（每轮第一步）完成整条链路，模型只负责播报：

```
用户发链接 → 解析 → 下载 → 交付 → 注入结果 → 模型 1–3 句播报 → 本轮 completed
```

注入形如：

```
[link-resolver] 本轮已自动处理：小红书 · 朽骨与旧梦 · 作者：鸣潮 · 0:10 · 1 个视频 / 1 张图片
交付：已通过对话文件卡片交付 2 个文件
信息已完整：不要再调用 resolve_link，也不要读取下载目录；直接输出 1–3 句介绍。
```

失败也走同一条链路（本轮仍是 `completed`，不会出现 blocked 轮次）：

```
[link-resolver] 本轮自动处理失败：小红书 · code=download-failed
原因：…
没有可交付的文件。不要调用 resolve_link 重试；直接说明原因并给出可行建议。
```

行为约束：

- 每轮只处理**第一条**受支持链接，其余在注入里列明；
- 同一会话再次发送同一链接：命中会话缓存，不重新解析、不重新下载；文件仍在本地则直接重新交付；
- 插件**永不**返回 `reject`，因此不会产生 blocked 轮次，也不会触发 dsh-im 的 `TURN_BLOCKED` 跳过上传。

## 工具

`resolve_link` 仅在 `toolEnabled: true` 时注册（默认关闭）。用于需要手动重新解析的场景：

`resolve_link({ url, download? })`

- 默认会下载媒体并在 `result.downloads` 返回本地路径；`download: false` 时只取元数据；
- 失败返回 `{ ok: false, error: { code, message, retryable } }`，不抛未捕获异常；
- 工具路径的交付顺序为「IM 优先、失败退回 present」。

```json
{
  "ok": true,
  "platform": "weibo",
  "url": "https://weibo.com/1647249081/Rrbfqw8g0",
  "supported": true,
  "message": "解析成功",
  "result": {
    "type": "images",
    "title": "新鲜出炉，刚写完不到十分钟……",
    "author": "玄色",
    "media": [{ "kind": "image", "url": "https://wx3.sinaimg.cn/large/…jpg" }],
    "warnings": [],
    "downloads": [{ "path": "/…/data/link-resolver/media/weibo_Rrbfqw8g0_1.jpg", "bytes": 252731, "kind": "image" }]
  }
}
```

## 下载目录

默认下载到**当前会话工作区**的 `downloads/<平台>/<内容 id>/`，结构示例：

```
downloads/
├── bilibili/BV1Zos36FEZz/{video.mp4, cover.jpg, metadata.json}
├── douyin/7708744445503573289/{01.mp4, cover.jpg, metadata.json}
├── xiaohongshu/6afbbf45000000002501f97a/{01.png … 04.png, metadata.json}
├── weibo/Rrbfqw8g0/{01.jpg …, metadata.json}
├── twitter/20/{01.jpg …, metadata.json}
└── youtube/dQw4w9WgXcQ/{dQw4w9WgXcQ.mp4, cover.jpg, metadata.json}
```

详细规则见 [`docs/download-layout.md`](docs/download-layout.md)。

## 媒体交付

交付按**本轮来源**判定，不按「会话绑定在哪个渠道」判定——同一会话可以被 Web 与 IM 交替使用。

| 本轮来源 | 判定依据 | 交付工具 | 用户看到 |
| --- | --- | --- | --- |
| IM | 消息文本以 `<dsh_im_source>` 开头（旧形态为 `plugin:dsh-im` 通知） | `dsh_im_return_file`（每文件一次） | 本轮结束后渠道逐条上传 |
| Web / 桌面 / CLI | 无上述标记，且会话未绑定 IM 对话 | `present`（一次调用，最多 4 个文件） | 本轮结束后对话内文件卡片 |

规则：

1. 工具必须按 **agent 作用域**解析（`present` 由 agent preset 装配，全局视图看不到它）；
2. IM 轮次里 `dsh_im_return_file` 失败（无活跃 consumer）→ 判定「本轮无法投递」，**不**改用 `present` 假装成功；
3. 交付失败会在注入里写明原因码（如 `tool-unavailable`、`im-consumer-inactive`）与相对路径，并禁止模型声称已发送；
4. IM 的「成功」只是**已排队**，注入文案明确要求模型说「已交付」，不能说「用户已收到」。

### IM 集成（依赖 `@xmanrui/dsh-im`）

IM 渠道的文件投递**必须与 `@xmanrui/dsh-im` 插件配合使用**。未安装时没有 `dsh_im_return_file`，IM 会话只能收到文本。

**completed 是前提**：dsh-im 把 `turn_end.reason = blocked` 映射为 `TURN_BLOCKED` 并跳过上传。本插件因此永不 `reject`，IM 轮次始终以 completed 结束。

- **文字**：IM 侧可用 `ctx.dshIm.send()` 或 dsh-im 的回答同步（仅文本）。

## 外部依赖

| 工具 | 用途 | 缺失时 |
| --- | --- | --- |
| `ffmpeg` / `ffprobe` | B站 DASH 合并、yt-dlp 合流 | B站自动回退 `durl` 单文件；YouTube 可能只能拿到单轨 |
| `yt-dlp` | YouTube / 通用站点 | 这两个平台返回 `tool-missing`，其余平台不受影响 |

插件只做版本探测与明确报错，**不会自动安装系统依赖**。路径可通过 `ffmpegPath` / `ytdlpPath` 指定。

## Docker 部署

```dockerfile
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*
# 之后按 DSH 官方方式安装 profile，并执行：
# dsh plugin --profile web add dsh-plugin-link-resolver
```

容器内需保证 `ffmpeg`、`yt-dlp` 在 PATH 中，或通过配置指定绝对路径。

## 更新与卸载

```bash
# 更新
dsh plugin --profile <profile> add dsh-plugin-link-resolver@latest

# 卸载
dsh plugin --profile <profile> remove dsh-plugin-link-resolver
```

卸载后插件注册的工具会随 Cordis 生命周期自动注销；下载缓存位于 `<DSH_HOME>/data/link-resolver/media`，可手动清理。

## 常见问题

- **B站只有 480P**：未登录限制；配置 `biliCookies`（后续版本支持）可提升。
- **小红书返回登录墙**：配置 `xhsCookies`（浏览器登录态）。
- **抖音解析失败**：签名接口依赖游客身份，频繁请求可能触发风控；稍后重试。
- **YouTube 解析失败**：确认 `yt-dlp --version` 可用，且版本足够新（建议 2026 最新版）。
- **下载文件在哪里**：会话工作区的 `downloads/<平台>/<内容 id>/`（见「下载目录」一节）。

## 开发

```bash
pnpm install --store-dir ./.tmp-pnpm-store
pnpm build            # tsc → lib/
pnpm typecheck
node --test test/*.test.js       # 43 例
node scripts/live-smoke.mjs <url> # 真实网络冒烟（手动）
npm pack --dry-run
```

黄金向量复现（需要参考 Python 项目）：

```bash
PYTHONPATH=../.tmp-py python3 scripts/gen-abogus-vectors.py \
  --abogus ../astrbot_plugin_link_resolver/core/douyin/abogus.py \
  --out test/fixtures/abogus-vectors.json
```

## 许可证

AGPL-3.0-only。移植自 [vacacia/astrbot_plugin_link_resolver](https://github.com/vacacia/astrbot_plugin_link_resolver)（AGPL-3.0），
保留其版权与许可要求；协议实现与业务逻辑由该项目的 Python 源码移植而来。
