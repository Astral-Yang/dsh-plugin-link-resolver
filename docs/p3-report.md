# P3 报告：YouTube 与通用站点

- 日期：2026-11-17
- 版本：`0.4.0`
- 范围：yt-dlp CLI 封装、YouTube 解析/下载、通用站点白名单兜底
- 结论：**YouTube 真实链路（元数据 + 下载）验证通过**；通用站点代码完成、同一后端，未做真实站点冒烟。

---

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `src/media/ytdlp.ts` | `inspect()`（`-J --skip-download`）与 `download()`（格式选择、`--max-filesize`、超时、取消） |
| `src/resolvers/youtube.ts` | YouTube 链接判断、格式筛选（按高度去重）、元数据映射、`downloadYoutube()` |
| `src/resolvers/generic.ts` | 域名白名单 + yt-dlp 兜底、`downloadGeneric()` |
| `src/adapter/config.ts` | `ytdlpPath` / `ffmpegPath` / `genericAllowedDomains` / `videoMaxHeight` |

---

## 2. 验证矩阵

| # | 验证项 | 方式 | 结果 |
| --- | --- | --- | --- |
| V1 | 单元测试 | `node --test test/*.test.js` | ✅ **26/26** |
| V2 | YouTube 元数据 | `live-smoke.mjs youtube.com/watch?v=dQw4w9WgXcQ` | ✅ 标题/作者「Rick Astley」/213s/5 档格式 |
| V3 | YouTube 下载 | `downloadYoutube(..., maxHeight=360)` | ✅ 9.1MB，VP9 640×360 + AAC |
| V4 | 通用站点白名单 | 单测 `hostAllowed` | ✅ 子域命中、伪造域名拒绝 |
| V5 | 通用站点真实下载 | 需一条白名单站点链接 | ⚠️ 未执行 |
| V7 | 微博真实解析 | `live-smoke.mjs weibo.com/1647249081/Rrbfqw8g0` | ✅ 标题《新鲜出炉…》/ 作者「玄色」/ 8 图 |
| V6 | yt-dlp 版本 | `yt-dlp --version` | ⚠️ `2025.04.30`（偏旧，建议升级） |

### V2/V3 实测输出

```text
【YouTube】Rick Astley - Never Gonna Give You Up (Official Video) (4K R...
作者：Rick Astley ｜ 时长：3:33 ｜ 类型：video
媒体：5 个视频
```

下载结果：`dQw4w9WgXcQ.mp4`（9.1MB，`ffprobe` 确认 VP9 + AAC）。

---

## 3. 设计要点

1. **统一后端**：YouTube 与通用站点共用 `ytdlp.ts`；区别只在链接校验（YouTube 域名 vs 白名单）。
2. **格式筛选**：`buildYoutubeMedia` 按高度去重、同高度取 `tbr` 更高者，并受 `videoMaxHeight` 限制。
3. **下载格式**：`bv*[height<=H]+ba/b[height<=H]/best`，输出合并为 mp4（`--merge-output-format mp4`）。
4. **安全**：通用站点只接受白名单域名（含子域），避免把任意 URL 交给 yt-dlp。
5. **错误处理**：yt-dlp 退出码、超时、取消都转换为 `ResolveError`，不抛原始异常。

---

## 4. 已知限制

- **yt-dlp 版本偏旧**：2025.04.30 目前可用，但 YouTube 风控变化时可能失效；建议升级到 2026 最新版。
- **通用站点仅白名单**：默认覆盖 TikTok/Instagram/Facebook/AcFun/Reddit/Vimeo/Dailymotion/Twitch/Bilibili TV；未列出的站点需用户自行添加。
- **未做通用站点真实冒烟**：缺一条白名单站点的公开链接。
- **yt-dlp 输出格式**：部分站点可能返回 webm/vp9，`--merge-output-format mp4` 会尽量封装，但不保证所有站点。

---

## 5. 剩余工作

1. ~~微博真实链接验证~~ —— 已完成（见 V7）。
2. 可选：B站 Cookie 高画质、卡片渲染（暂缓）。
3. 发布前：npm tarball 独立安装 + DSH 加载 + 卸载验证（TASK.md 阶段七）。
