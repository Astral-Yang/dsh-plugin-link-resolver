# P2 报告（B站与下载）

- 日期：2026-11-17
- 版本：`0.3.0`
- 范围：B站解析器（WBI / DASH / 画质）、媒体下载器、ffmpeg 合并、`resolve_link` 的 `download` 参数
- 结论：**B站元数据与流清单已真实可用**；下载器可用；ffmpeg 合并因本机缺失标记「环境受限」，已实现 `durl` 单文件回退。

---

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `src/sign/wbi.ts` | WBI 签名：`mixinKey()` + `signWbi()`（排序、过滤 `!'()*`、`w_rid`） |
| `src/resolvers/bilibili.ts` | view 元数据 / playurl 流清单 / `downloadBilibili()` |
| `src/media/download.ts` | 流式下载、`.part` 原子替换、大小限制、逐跳重定向校验、取消清理 |
| `src/media/ffmpeg.ts` | `ffmpeg -version` 探测、`-c copy` 合并、超时与进程回收 |
| `src/adapter/tool.ts` | `download` 参数、`result.downloads` 输出、通用视频下载 |

---

## 2. 验证矩阵

| # | 验证项 | 方式 | 结果 |
| --- | --- | --- | --- |
| V1 | 类型检查 / 构建 | `tsc` | ✅ |
| V2 | 单元测试 | `node --test test/*.test.js` | ✅ **23/23** |
| V3 | B站真实解析 | `live-smoke.mjs https://www.bilibili.com/video/BV1xx411c7mD` | ✅ 标题「字幕君交流场所」/ 作者「碧诗」/ 34:15 / 2 档画质（480P/360P） |
| V4 | B站 DSH 端到端 | `dsh p0 --json "... BV1xx411c7mD"` | ✅ 工具结果进入回答 |
| V5 | 下载器 | 真实下载 `transparent.png` / `favicon.ico` | ✅ 123B / 4286B |
| V6 | ffmpeg 探测 | `ffmpegAvailable()` | ⚠️ 本机无 ffmpeg（`false`），DASH 合并未实测 |
| V7 | durl 回退 | 代码路径 | ✅ 已实现（`fnval=1` → 单文件 mp4） |

### V3 实测输出

```text
【B站】字幕君交流场所
作者：碧诗 ｜ 时长：34:15 ｜ 类型：video
媒体：2 个视频
提示：未登录仅返回 480P 及以下画质
```

---

## 3. 设计要点

1. **WBI 双通道**：`wbi/view` 与 `wbi/playurl` 优先；签名失败自动回退旧版 `view` / `playurl`，避免因 key 获取失败整体不可用。
2. **画质选择**：`buildDashMedia` 按 `id`（qn）去重，同档取最高 `bandwidth`，按高度降序；标签映射 8K/4K/1080P/720P/480P/360P。
3. **下载策略**：
   - 有 ffmpeg：DASH 视频 + 最高码率音频 → 下载 → `-c copy` 合并；
   - 无 ffmpeg：`fnval=1` 取 `durl` 单文件（通常 480P，自带音轨）。
4. **安全**：下载同样逐跳 `assertSafeUrl`（防重定向绕过）；`.part` 失败即删。
5. **路径**：`<DSH_HOME>/data/link-resolver/media`（无 DSH_HOME 时退回系统临时目录）。

---

## 4. 已知限制

- 未登录最高 480P；更高画质需要 B站 Cookie（后续可接入 `biliCookies`）。
- 本机无 ffmpeg，DASH 合并路径未实测；CI/Docker 中需安装后回归。
- 多 P 目前只解析并下载单 P（`?p=`）；批量多 P 待后续。
- 下载仅支持视频；图集批量下载尚未接入。

---

## 5. 下一步（P3）

1. YouTube / 通用站点：yt-dlp CLI 包装（`-J`、`--max-filesize`、取消与进度解析）。
2. B站 Cookie 配置与高画质。
3. 小红书原图链路与并发下载。
4. `ctx.sessionProjections` 会话去重。
