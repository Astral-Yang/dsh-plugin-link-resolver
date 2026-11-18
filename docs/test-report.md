# 测试与验收报告

- 版本：`dsh-plugin-link-resolver@1.0.0-rc.16`
- 日期：2026-11-17
- 结论：**满足发布候选（RC）标准**；npm 发布与远程仓库操作未执行（需授权）。

---

## 1. 测试环境

| 项 | 值 |
| --- | --- |
| DSH | `@deepseek-ai/dsh` 0.2.2-rc.1 |
| Node | v24.22.3 |
| pnpm / npm | 12.21.0 / 11.19.1 |
| ffmpeg / ffprobe | 7.1.5-0+deb13u1 |
| yt-dlp | 2025.04.30（可用，建议升级） |
| 操作系统 | Linux（Debian） |

---

## 2. 自动化测试

命令：`node --test test/*.test.js`

| 分组 | 用例数 | 覆盖内容 |
| --- | --- | --- |
| `p0-smoke.test.js` | 8 | 插件导出形态、开关、工具契约、平台识别、错误返回、渲染 |
| `resolvers.test.js` | 14 | B站 DASH 选择、抖音映射（视频/图集/分享页）、微博字段/视频/清洗、X 映射、小红书 state/Live Photo/短链/fileId、YouTube 格式、generic 白名单、WBI 签名格式 |
| `inbox.test.js` | 2 | 模式 B L2 注入、去重、自触发保护 |
| `sign.test.js` | 2 | a_bogus 3 组黄金向量、WebSign 2 组黄金向量 |
| **合计** | **26** | **26 passed / 0 failed** |

类型检查：`tsc -p tsconfig.json --noEmit` ✅
构建：`pnpm build` ✅

> 说明：fixture 测试不等同于真实平台验证；真实链路见 §4。

---

## 3. 集成测试（tarball 独立安装）

| # | 步骤 | 命令 | 结果 |
| --- | --- | --- | --- |
| I1 | 生成 tarball | `npm pack` | ✅ `dsh-plugin-link-resolver-1.0.0-rc.16.tgz`（69 文件 / 约 116 kB / unpacked 约 308 kB） |
| I2 | 新建独立 profile | `DSH_HOME=.tmp-release-home dsh rel --from-default-profile headless` | ✅ |
| I3 | 安装 tarball | `dsh plugin --profile rel add …tgz` | ✅ 仅安装 1 个包（peer 可选，无重复依赖） |
| I4 | 写入 bundles | 检查 profile `package.json` | ✅ `dsh.profile.bundles` 含 `dsh-plugin-link-resolver` |
| I5 | 组合树 | `dsh --profile rel --dump-config` | ✅ `id: link-resolver` 条目出现 |
| I6 | 模块导入 + Schema | `dsh --profile rel --dump-config-schema` | ✅ 含 `videoMaxHeight` / `ytdlpPath` / `genericAllowedDomains` |
| I7 | 真实工具调用 | `dsh rel --json "… resolve_link …"` | ✅ 工具调用成功，返回真实 X 数据 |
| I8 | 卸载 | `dsh plugin --profile rel remove …` | ✅ 依赖与 bundles 均移除 |
| I9 | 残留检查 | `--dump-config` 中 `link-resolver` 计数 | ✅ 0（无配置残留） |

---

## 4. 真实平台测试

| 平台 | 链接 | 结果 |
| --- | --- | --- |
| B站 | `BV1xx411c7mD` | ✅ 标题《字幕君交流场所》/ 作者 / 34:15 / 480P 警告 |
| B站下载 | `BV1Zos36FEZz` | ✅ 5.2MB MP4，H.264 852×480 + AAC（ffmpeg 合并） |
| 抖音 | `v.douyin.com/CVHmFXGPfHc` | ✅ 标题 / 作者「好运爆棚」/ 10s / 1 视频（a_bogus 签名） |
| 小红书 | `xhslink.cn/o/57JtPg6lQP` | ✅ 标题 / 作者 / 4 图；下载 4 张 PNG 1440×2400 |
| 微博 | `weibo.com/1647249081/Rrbfqw8g0` | ✅ 标题 / 作者「玄色」/ 8 图；下载 JPEG 1080×1800 |
| X | `x.com/jack/status/20` | ✅ `just setting up my twttr` / jack(@jack) |
| YouTube | `youtube.com/watch?v=dQw4w9WgXcQ` | ✅ 元数据；下载 9.1MB MP4（VP9 640×360 + AAC） |
| 通用站点 | 无真实白名单链接 | ⚠️ 未执行（白名单单测通过） |

---

## 5. 外部工具测试

| 项 | 结果 |
| --- | --- |
| `ffmpeg -version` | ✅ 7.1.5 |
| `ffprobe` 产物校验 | ✅ B站/YouTube 产物均含视频+音频轨 |
| `yt-dlp --version` | ✅ 2025.04.30（偏旧） |
| 缺失降级 | B站无 ffmpeg 时走 durl（代码路径） |

---

## 6. 未执行 / 环境受限

| 项 | 原因 | 影响 |
| --- | --- | --- |
| 通用站点真实解析 | 缺一条白名单站点链接 | 仅影响该平台冒烟，不影响其他平台 |
| B站高画质（>480P） | 未配置 B站 Cookie | 平台限制，已返回 warning |
| IM 媒体投递 | 需 IM 发起的 turn | 已在 dsh-im 文档中确认机制；插件只给路径 |
| 卡片渲染 | 已决定暂缓 | 纯文本摘要可用 |
| npm publish / GitHub Release | 需用户明确授权 | 发布前人工操作 |

---

## 7. 开发期发现并修复的问题（摘要）

1. `198.18.0.0/15` 被透明代理用作 fake-IP，SSRF 守卫误杀全部外网请求 → 从黑名单移除并记录风险。
2. 小红书 `explore` 页返回登录墙 → 增加移动 UA `discovery/item` 的 `noteData` 路径。
3. 小红书原图实际为 PNG 但 URL 不含 `.png` → 扩展名判定补充 `format/png`。
4. headless profile 无 `present` 工具 → 媒体交付说明区分 Web/IM；插件不直接推送。
5. `defineTool` 参数 DSL 会编译为 JSON Schema → 测试断言已按实际形态编写。

---

## 8. 结论

- 代码质量：类型检查、构建、26 项测试全部通过。
- 集成：tarball 可独立安装、DSH 正确加载、真实工具调用成功、卸载无残留。
- 真实平台：六个平台完成真实链路验证；通用站点待一条链接。
- **可交付状态：发布候选（RC）**；正式发布需人工执行 npm publish 与远程仓库操作。
