# Changelog

## 1.0.0-rc.20 — B站 Cookie、下载保留策略、工作区过滤

### 新增

- **`biliCookies`**：B站登录态（`SESSDATA=...`），解析与下载请求都会带上；未登录时画质上限 480P 的警告保留。
- **`retainDays`**（1–30，默认 7）：按**内容目录** mtime 清理 `downloads/<平台>/<id>/`，按工作区节流（一小时最多一次），在处理链接时顺带执行。
- **`workspaceFilterMode` / `workspaceList`**：按会话工作区路径前缀过滤（`allow` 只处理列表内、`deny` 跳过列表内），用于多工作区共用同一 profile 时限定生效范围。

### 改进（缓存与保留策略联动）

- 清理过期目录后，同步**失效引用这些路径的会话缓存**（`SessionCache.dropUnder`），避免缓存把已删目录当成可复用。
- 缓存命中但文件已被清理时，**只补下载、不重新解析**（少一次网络请求），补下载失败再回退完整重解析。
- `cacheTtlHours` 的语义明确为「元数据复用窗口」，与 `retainDays`（文件生命周期）解耦。

### 验证

- 单测 48/48：新增工作区前缀匹配、按 mtime 清理、目录缺失安全返回、缓存按路径失效四组用例。

## 1.0.0-rc.19 — 不再短路下游 pre-step 监听器

### 修复

- 命中链接时插件直接 `return {kind:'enter'}`，**没有调用 `next()`**，于是排在下游的 `agent/pre-step` 监听器全部不执行。
  dsh-im 的全局监听器正是其中之一：它负责把消息里的 `<dsh_im_source>` / `<dsh_im_source_guidance>` 内联块
  **拆成独立消息**（source → notice、guidance → instructions）。被短路后这些块留在用户消息里未展开，
  这也是「插件开着就内联、关了就不内联」的由来——与卡片格式无关，是走到没走到拆分器的问题。
- 改为先 `await next()` 拿到下游决策，再把本轮的 notice 追加在其后；下游返回 `reject` 时由本插件接管为 `enter`
  （单链路永不 `reject` 的既定契约）。

### 影响

- 轨迹/会话日志里，微信链接消息的来源块会恢复成独立 notice（与插件关闭时一致）；
- 其他插件的 global `pre-step` 逻辑不会再因为本插件命中链接而被吞掉。

## 1.0.0-rc.18 — 修复 IM 来源判定

### 修复

- **IM 轮次被误判成本地轮次**：rc.17 只认 `source.kind === 'plugin:dsh-im'` 的独立通知消息，而当前 dsh-im 把
  `<dsh_im_source>…</dsh_im_source>` **拼在用户消息文本开头**。于是微信轮次走了 `present`，
  渠道不会上传，用户收不到文件（实测会话 `session-6c08ea03`：注入写的是「已通过对话文件卡片交付 2 个文件」）。
- 来源判定改为三级信号：
  1. 消息带 IM 标记（两种形态都认）→ `im`，只走 `dsh_im_return_file`；
  2. 无标记但 `dshIm.describeConversationSync(sessionId)` 非空（会话绑定 IM）→ `auto`，先试 IM，consumer 不活跃再退回 `present`；
  3. 其余 → `local`，只走 `present`。
- `auto` 分支只有在失败码为 `artifact-consumer-required` 时才退回 `present`；其他失败（文件缺失、渠道拒绝等）原样上报，不再被 `present` 掩盖。

### 验证

- 单测 38/38（新增 `<dsh_im_source>` 前缀识别、非前缀不误判、`describeConversationSync` 退化用例）。
- Web 侧 rc.17 实测已确认 `present` 在 agent 作用域可见（用户复验通过）。

## 1.0.0-rc.17 — 单链路：插件做完，模型只播报

### 变更（含破坏性）

- 三种模式收敛为**一条链路**：`mode`、`autoDownload`、`autoDeliver`、`autoProcess`、`inboxHint` 全部移除；新增 `downloadMedia`（默认 `true`）。
- `toolEnabled` 默认改为 **`false`**：`resolve_link` 默认不注册。链接由插件自动处理，「重复解析」从「靠提示约束」变成「结构上不可能」；需要手动解析时在设置里打开。
- 执行位置改为只在 `agent/pre-step`（每轮第一步）；删除 `agent/inbox/inserted` 预启动与 `pending` 表（单槽位、多链接丢失、陈旧 job 一并消失）。
- 注入**真实结果**（平台 / 标题 / 作者 / 时长 / 媒体构成 / 交付通道），模型只播报 1–3 句；注入文案明确禁止再调用工具、读取下载目录。
- 插件**不再返回 `reject`**：blocked 轮次与 dsh-im 的 `TURN_BLOCKED` 丢文件路径一并消除，两条渠道都以 `completed` 收尾。

### 修复

- 交付按**本轮来源**判定（有 `plugin:dsh-im` 通知 → IM，否则本地），不再「先试 IM 工具、失败退回 present」；IM 轮里不再出现「present 假成功 → 文件被丢弃」。
- `present` / `dsh_im_return_file` 改为按 **agent 作用域**解析——`present` 由 agent preset 装配，全局视图看不到它，这是 rc.16 Web 侧「自动交付未成功」的根因。
- 交付失败不再静默：原因码（`tool-unavailable` / `im-consumer-inactive` / …）同时写入日志与注入文案。
- 自动路径写入会话缓存：同一链接再次出现不再二次解析、二次下载；文件仍在本地时直接重新交付。

### 验证

- headless（插入 `present`）：注入结果 → `deliverables/presented` → `turn_end completed`；模型 0 次工具调用，回答无本地路径 Markdown。
- headless（无 `present`）：注入 `交付：未完成（tool-unavailable）`，模型如实说明未交付、未声称已发送。
- 单测 34/34 通过（新增 notice / chain 纯函数用例）。

## 1.0.0-rc.16 — Web 兜底提示

### 修复

- `autoProcess` 启用但未能接管时（无自动任务、解析失败、下载为空、交付失败），`pre-step` 会注入 `[link-resolver] 检测到…链接` 上下文并交给模型，避免 Web 会话在无提示的情况下直接猜内容或重复解析。
- 自动处理成功时行为不变：Web `present` → 跳过模型；IM `dsh_im_return_file` → 放行模型完成本轮。

## 1.0.0-rc.15 — 文档：IM 依赖说明

### 文档

- README 新增「IM 集成」章节：明确 IM 文件投递依赖 `@xmanrui/dsh-im`，未安装时只能发文本。
- 说明 dsh-im 将 `blocked` 轮次视为失败（`TURN_BLOCKED`）并跳过上传，因此 IM 场景会放行模型完成本轮。

## 1.0.0-rc.14 — IM 交付与 blocked 轮次

### 修复

- 查明 `dsh_im_return_file` 未送达的原因：dsh-im 将 `turn_end.reason = blocked` 映射为 `TURN_BLOCKED` 并跳过文件上传，与调用顺序无关。
- `auto` 模式改为渠道感知：
  - `present` 成功 → `reject`（Web 零模型）；
  - `dsh_im_return_file` 成功 → 放行模型，让本轮以 `completed` 结束，渠道才会上传文件；同时注入一条「已登记交付，请只做简短确认」的提示，避免模型重复解析。
- 文档明确：IM 侧无法同时做到「零模型」与「文件投递」，需要 `assistant` 模式或接受一次模型调用。

## 1.0.0-rc.13 — 合并为单一模式

### 变更

- `autoDownload` / `autoDeliver` / `autoProcess` 三个布尔合并为 `mode`：
  - `auto`（默认）：解析 → 下载 → 交付 → 跳过模型（零 LLM）；
  - `assistant`：模型参与，但插件自动下载并交付；
  - `metadata`：只解析元数据，不下载不交付。
- 设置卡片改为「工作模式」下拉框，避免出现 `autoProcess=true` 且 `autoDeliver=false` 这类非法组合。
- 旧的三个布尔键仍会被 Schema 接受（忽略），不会导致配置校验失败。

### 内部

- `LinkResolverConfig` 保留 `autoDownload/autoDeliver/autoProcess` 作为 `mode` 的派生值，工具与自动处理代码不变。

## 1.0.0-rc.12 — 零模型自动处理

### 新增

- `autoProcess`（默认 `true`）：用户消息含受支持链接时，插件在 `inbox` 阶段解析并下载，在 `pre-step` 阶段交付文件；交付成功后返回 `reject` 跳过模型，全流程不调用 LLM。
- 交付失败时自动放行模型兜底（模型仍可调用 `resolve_link`）。
- `present` 描述写入固定格式摘要（平台 · 作者 / 标题 / 时长 / 文件路径与大小）。

### 验证

- headless 实测：仅发链接 → 自动下载 905KB 抖音视频 → `present` 提交成功（会话日志含 `deliverables/presented`）→ `turn_end: blocked`，**无 `step_start`**（模型未被调用）。

## 1.0.0-rc.11 — 注入提示去渠道化

### 修复

- `inbox` 注入提示不再写死 `present`：
  - `autoDeliver: true` → 「默认会下载媒体并由插件自动交付」；
  - `autoDeliver: false` → 「请调用 present（Web/桌面）或 dsh_im_return_file（IM）交付媒体」。
- 避免 IM 会话被提示误导去调用 Web 专用的 `present`。

## 1.0.0-rc.10 — 小红书短链与下载修复

### 修复

- 短链跳转后**保留完整查询串**：不再只取 `xsec_token`/`xsec_source`，避免因丢失 `xhsshare`、`shareRedId`、`track_code` 等参数导致 404 或笔记详情缺失。
- 新增 HTML 兜底解析：`noteData` 结构不可用时，直接从页面提取 `"masterUrl"` 视频直链与 `sns-webpic-qc` / `sns-na-i6` 图片直链。
- `downloadXiaohongshu` 复用已解析结果，不再二次请求短链，避免 token 过期导致「未找到笔记详情」。
- 错误提示区分「登录墙」与「短链过期/结构变化」。

### 验证

- 真实图文笔记 `xhslink.cn/o/57JtPg6lQP` 解析与下载回归通过（4 张原图）。
- 新增 redirectPath / HTML 兜底单测（总计 27 例）。

## 1.0.0-rc.9 — 原生配置表单

### 变更

- 客户端设置卡片改用 DSH 原生 `ctx.configForms.get('link-resolver')` 读写配置，**不再依赖自定义 HTTP 路由**（`/api/link-resolver/config` 已移除）。
- 保存通过设置的 revision 机制提交，字段级写入、即时生效。

## 1.0.0-rc.8 — 路由诊断

### 变更

- 设置页路由注册增加日志与异常保护：启动日志会输出「设置页路由已注册 /api/link-resolver/config」。
- `settings.configure` 增加防护，避免设置服务异常影响插件加载。

## 1.0.0-rc.7 — 插件页配置卡片

### 变更

- 参照 `dsh-free-search`：客户端注册 `plugins.bundle.config`（key = 包名）与 `plugins.row.config`（key = 包名#link-resolver），在插件详情页直接渲染配置卡片。
- 宿主调用 `settings.configure({ auto: false })`，避免设置服务重复生成 schema 表单。

## 1.0.0-rc.6 — 独立设置页

### 新增

- 客户端设置页：`client.js` 注册「设置 → 链接解析」分区，提供常用配置表单。
- 宿主设置路由：`GET/POST /api/link-resolver/config`，经 `configEditor` 持久化，保存即生效。
- `dsh.client` 清单与 `./client` 导出。

### 说明

- 由于 DSH 插件页不渲染第三方 host-only 插件的通用 Config 表单，改为插件自带设置页；
- 配置仍可通过 `cordis.patch.yml` 覆盖。

## 1.0.0-rc.5 — 设置页可编辑

### 变更

- 配置字段改为 `.volatile()`：DSH **设置 → 插件** 页现在会自动生成本插件的配置表单，修改即时生效。
- `apply` 与工具改为每次读取最新配置（`readConfig`），支持运行期热更新。

### 验证

- `Config.dict.*.meta.volatile === true`；测试 26/26 通过。
- 真实链接：自动下载 + 自动 present 交付仍正常。

## 1.0.0-rc.4 — 自动交付

### 变更

- 新增 `autoDeliver`（默认 `true`）：下载完成后插件自动调用 `dsh_im_return_file`（IM）或 `present`（Web/桌面）交付文件。
- 工具结果明确区分「已自动交付」与「需模型调用」，并禁止用 Markdown 本地路径代替文件交付。
- 修复 IM 场景下模型只输出 `![预览](本地路径)`、未调用 IM 工具的问题。

### 验证

- 仅发送链接（无下载措辞）：插件自动下载 905 KB 抖音视频并自动 `present` 成功；模型不再重复调用 `present`，最终回答无 Markdown 图片链接。

## 1.0.0-rc.3 — 工作区下载目录

### 变更

- 下载目录改为**会话工作区**下：`<workspace>/<downloadDir>/<platform>/<contentId>/`。
- 新增配置 `downloadDir`（默认 `downloads`，支持绝对路径）。
- 统一命名：媒体按 `01.mp4` / `01.jpg` / `01.png` 编号；B站 `video.mp4`；YouTube `<id>.mp4`。
- 每个内容目录写入 `metadata.json`（元数据快照）并 best-effort 下载 `cover.jpg`。
- 新增文档 `docs/download-layout.md`。

### 验证

- 抖音：`downloads/douyin/7708744445503573289/{01.mp4, cover.jpg, metadata.json}` ✅
- 小红书：`downloads/xiaohongshu/6afbbf45000000002501f97a/{01.png … 04.png, metadata.json}` ✅
- B站：`downloads/bilibili/BV1Zos36FEZz/{video.mp4, cover.jpg, metadata.json}` ✅

## 1.0.0-rc.2 — 默认自动下载

### 变更

- 新增配置 `autoDownload`（默认 `true`）：调用 `resolve_link` 时自动下载媒体，用户无需说「下载」。
- 工具描述与 inbox 提示更新：明确「解析 → 下载 → present/dsh_im_return_file 交付」的完整流程。
- 渲染文本补充下载文件路径、大小与交付指引。

### 验证

- 仅发送链接（无任何下载措辞）的端到端测试：模型调用 `resolve_link` → 自动下载 905 KB 抖音视频 → 调用 `present` 交付成功。

## 1.0.0-rc.1 — 发布候选

### 变更

- 包元数据：版本 `1.0.0-rc.1`；`peerDependenciesMeta` 标记为 optional，避免 pnpm 重复安装 DSH 运行时包。
- README 完整化：安装（npm/tarball/link）、完整配置表、媒体交付、Docker、更新与卸载、常见问题。
- 新增 `docs/test-report.md`、`docs/release-checklist.md`。

### 验收

- tarball 独立安装 → DSH 加载 → Agent 真实工具调用 → 卸载无残留（详见 `docs/test-report.md` §3）。
- 测试 26/26 通过；类型检查与构建通过。

## 0.4.1 — 微博验证与通用图片下载

### 新增

- 非视频平台的图片/图集下载：`resolve_link(download=true)` 现在会下载图片与 Live Photo 动态片段（并发受 `maxConcurrent` 限制）。

### 验证

- 微博真实链接 `https://weibo.com/1647249081/Rrbfqw8g0`：标题/作者「玄色」/ 8 张图片；图片真实下载 1080×1800 JPEG 通过。
- DSH 端到端：工具结果进入最终回答。

## 0.4.0 — YouTube 与通用站点（P3 完成）

### 新增

- `src/media/ytdlp.ts`：yt-dlp CLI 封装（`-J` 元数据、下载、`--max-filesize`、超时、取消）。
- `src/resolvers/youtube.ts`：YouTube 元数据 + 格式筛选（按高度去重，≤ `videoMaxHeight`）+ 下载。
- `src/resolvers/generic.ts`：域名白名单 + yt-dlp 兜底（TikTok/Instagram/Facebook/AcFun/Reddit 等）。
- 配置新增：`ffmpegPath`、`ytdlpPath`、`genericAllowedDomains`。
- 小红书下载：`ci.xiaohongshu.com` 原图链路 + 并发下载 + PNG/JPEG 扩展名判定。
- 测试新增 YouTube / generic / 小红书 fileId 用例（总计 26 例）。

### 验证

- YouTube 真实链接 `dQw4w9WgXcQ`：元数据（标题/作者/213s/5 档格式）✅；下载 9.1MB（VP9 640×360 + AAC）✅。
- B站下载合并：5.2MB（H.264 852×480 + AAC）✅。
- 小红书下载：4 张原图（PNG 1440×2400）✅。
- 微博真实链接：标题《新鲜出炉，刚写完不到十分钟……》/ 作者「玄色」/ 8 张图片 ✅。
- 环境：ffmpeg 7.1.5、yt-dlp 2025.04.30、ffprobe 7.1.5。

### 已知限制

- yt-dlp 2025.04.30 偏旧，YouTube 风控变化时可能失败，建议升级到 2026 最新版。
- 通用站点仅白名单域名；未做全站覆盖。
- 微博真实链接验证仍待补。

## 0.3.0 — B站与下载（P2 完成）

### 新增

- `src/sign/wbi.ts`：B站 WBI 签名（mixin key + `w_rid`），带 10 分钟 key 缓存与免签回退。
- `src/resolvers/bilibili.ts`：view 元数据 + playurl 流清单（多 P、画质/编码、DASH 媒体列表）。
- `src/media/download.ts`：流式下载、`.part` 原子替换、大小限制、取消清理、逐跳重定向校验。
- `src/media/ffmpeg.ts`：`-c copy` 合并、超时、进程回收、ffmpeg 探测。
- `downloadBilibili()`：有 ffmpeg 走 DASH + 合并；缺失时回退 `durl` 单文件。
- `resolve_link` 新增 `download` 参数与 `result.downloads` 输出；非 B站平台下载首个视频。
- 配置新增 `videoMaxHeight`。

### 验证

- B站真实链接 `BV1xx411c7mD`：标题「字幕君交流场所」/ 作者「碧诗」/ 34:15 / 2 档画质，DSH 端到端通过。
- 下载器真实下载小文件成功（123B / 4286B 两次）。
- ffmpeg 在本机缺失：合并路径标记「环境受限」，durl 回退路径保留。

### 已知限制

- 未登录最高 480P（平台限制，已返回 warning）。
- 本机无 ffmpeg，DASH 合并未实测；durl 回退可用。
- YouTube / 通用站点仍为 P3。

## 0.2.0 — 抖音签名（P2 提前）

### 新增

- `src/sign/abogus.ts`：a_bogus 签名完整移植（SM3 / RC4 / 自定义 Base64 / 指纹与时间戳分片）。
- `src/sign/websign.ts`：WebSign（`x-secsdk-web-signature`，MD5 + 固定盐）。
- `src/resolvers/douyin-guest.ts`：游客身份（ttwid + UIFID_TEMP）+ 签名详情接口。
- 抖音解析链路升级为三级回退：`iteminfo` → 分享页 `_ROUTER_DATA` → **签名 `aweme/detail`**。
- 黄金向量：`test/fixtures/abogus-vectors.json`（3 组）与 `websign-vectors.json`（2 组），由参考 Python 实现生成；`scripts/gen-abogus-vectors.py` 可复现。
- 测试新增 2 例签名一致性（总计 21 例）。

### 验证

- 真实链接 `https://v.douyin.com/CVHmFXGPfHc/` 解析成功：标题 / 作者「好运爆棚」/ 时长 10s / 1 个视频直链。
- DSH 端到端：模型调用 `resolve_link` → 签名解析 → 结果进入回答。

### 已知限制

- 游客会话 TTL 30 分钟，过期自动刷新；高频请求可能触发平台风控。
- B站解析器仍未接入（顺延）。

## 0.1.0 — P1 核心与四个解析器

### 新增

- `core/result.ts`：统一结果模型（`ResolvedLink` / `MediaItem` / `LocalFile`）与结构化错误（`ResolveError` + 12 个错误码）。
- `core/http.ts`：超时、指数退避重试、手动逐跳重定向校验、SSRF 守卫（私网/回环/链路本地/metadata）、全局并发令牌桶。
- `core/cache.ts`：会话级 TTL 缓存（进程内），同一链接不重复请求。
- 四个解析器：
  - X / Twitter：fxtwitter 接口，支持文字、图片、视频、混合媒体与长文图片。
  - 小红书：短链展开（`redirectPath`）+ `explore`/`discovery` 双路径，支持图文、视频、Live Photo 关联；登录墙时返回明确错误。
  - 微博：访客 Cookie（`genvisitor2`）+ `ajax/statuses/show`，支持长文、原图、最高码率视频、转发回退。
  - 抖音（免签路径）：`iteminfo` / `slidesinfo` / 分享页 `_ROUTER_DATA`，支持视频、图集、动态图。
- `resolve_link` 工具接入真实解析：统一渲染标题、作者、时长、媒体数量与首个直链。
- 模式 B L2：`agent/inbox/inserted` → `agent.inject()` 短提示，含去重与自触发保护。
- 测试：P0 冒烟 8 例 + 解析器 fixture 8 例 + inbox 2 例（共 18 例）。

### 变更

- `resolve_link` 返回结构改为 `{ ok, platform, url, supported, message, result?, error? }`。
- 配置新增 `weiboCookies`（可选；留空使用访客态）与 `xhsCookies`（可选；登录墙时必需）。

### 已知限制

- B站解析器未接入（P2）；YouTube / 通用站点未接入（P3）。
- 下载、ffmpeg 合并、缓存文件生命周期未实现（P2）。
- 小红书 / 微博 / 抖音的真实内容冒烟需要有效作品链接；本环境仅 X 完成真实链路验证。
- `tools/result` 与 `autoPush` 相关能力仍为 P4 可选项。

## 0.0.1 — P0 骨架

### 新增

- Cordis 插件入口（`name` / `inject` / `Config` / `apply`），资源经 `ctx.effect` 注册。
- `resolve_link` 工具：`defineTool` + `output.schema` + `output.render`，返回结构化识别结果。
- 平台注册表：B站 / 抖音 / 小红书 / 微博 / X / YouTube / 通用站点（默认关闭）的识别正则与主机名。
- 链接规范化与文本抽取（`normalizeUrl` / `extractLinks`）。
- 配置 Schema（schemastery）：13 项，含并发、超时、限额等参考实现缺失的能力。
- `cordis.patch.yml` bundle 层与 `dsh.bundle.patch` 声明。
- 构建产物（`lib/`）+ 打包清单。
- P0 冒烟测试（8 例）：导出形态、开关、工具契约、识别、边界。

### 已知限制

- 各平台解析器尚未接入，`execute` 只做识别。
- 模式 B L2（inbox 提示）尚未接线。
- 媒体下载与缓存管理未实现。
- 真实 LLM 工具调用已在一次性测试网关上验证（P0 报告 V9）；正式回归仍需要可用凭据。