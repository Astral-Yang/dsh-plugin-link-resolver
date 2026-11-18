# DSH Link Resolver 移植可行性分析报告

- 文档版本：v0.1（预研稿）
- 日期：2026-11-17
- 状态：待评审，评审通过后并入 `docs/source-analysis.md`（TASK.md 阶段一正式产物）
- 依据：原项目源码逐文件审计（15,752 行 Python）、当前 DSH 实现源码取证（`@deepseek-ai/dsh` 0.2.2-rc.1 dist）、本机环境实测

---

## 1. 结论摘要

**总体判断：可行。** 原项目的协议层与业务层（约八成代码量）可以忠实迁移到 TypeScript，框架层（约两千行 AstrBot 胶水）必须按 DSH 的形态重写。

| 结论项 | 判定 | 依据摘要 |
| --- | --- | --- |
| 纯 TypeScript 插件能否实现 | 可行 | DSH 插件即 Cordis plugin，`name/inject/Config/apply` 四件套 + `defineTool` + `ctx.tools.register` |
| 七个平台能否全部保留 | 可行，但分档 | X/小红书/微博/抖音（无签名路径）为低风险；B站需自研 WBI；抖音签名需移植 a_bogus；YouTube/通用站点依赖外部 CLI |
| Agent 主动调用（模式 A） | 完全可行 | 工具结果契约 `ContentBlock[]` 明确，`render` 必填 |
| 自动解析（模式 B） | 分级可行，本期做 L1+L2 | `systemPrompt.section`（L1）与 `agent/inbox/inserted` + `agent.inject`（L2）均已验证存在 |
| 零 LLM 自动推送（可选） | 机制已实测成立 | 解析与 `ctx.dshIm.send()` 均不依赖模型；`pre-step` 返回 `reject` 可完全跳过模型，但 turn 以 `blocked` 结束、无回答（P0 V10 实测，见 `docs/p0-report.md` §2.2） |
| 图片/视频回显到会话 | **受限** | 自定义工具返回的 `image` 块不会被客户端渲染（客户端硬判 `read_image`）；`dshIm.send()` 只接受文本 |
| 卡片渲染 | 本期不做（已定） | 原实现依赖 Pillow，900px 布局 + 彩色 Emoji + 高斯模糊，复刻成本高、收益低 |
| npm 分发 | 可行 | `dsh.bundle.patch` + `cordis.patch.yml` + `engines.dsh` 校验链完整，`link:` 本地安装受支持 |
| 许可证 | 约束项 | 原项目 AGPL-3.0，衍生作品必须 AGPL-3.0 |

**三条已确认的产品决策**

1. IM 侧投递由 `@xmanrui/dsh-im` 承担，本插件只负责「把解析结果交回会话」。
2. 卡片渲染不进入首版。
3. 自动解析只做 L1（系统提示引导）+ L2（收到消息时后台解析并经 `agent.inject` 注入上下文）。

**三个最大的技术风险**

1. 抖音 `a_bogus` 签名（877 行 Python，SM3 + RC4 + 自定义 base64）。
2. B站 `bilibili-api-python` 依赖（需自研 WBI 签名与 DASH 流选择）。
3. 通用站点「yt-dlp 是否认识该域名」的判定在 CLI 模式下没有等价能力。

---

## 2. 事实基线

### 2.1 原项目（`astrbot_plugin_link_resolver` v1.0.15，AGPL-3.0）

**规模**：15,752 行 Python / 43 个模块 / 15 个测试文件 / 9 组 50 个配置键。

**架构**：平台 Mixin + 单一注册表。

```
main.py (1,352)              AstrBot 胶水层：@filter.regex 监听、event.send、群过滤、兜底
core/registry.py (114)       平台注册表：key / label / pattern / handle / process
core/{bilibili,douyin,xhs,weibo,twitter,youtube,generic}/
    extractor.py             协议层（HTTP + 解析）—— 可移植
    handler.py               业务 + 框架胶水（混合层）—— 必须切分
core/common/                 paths / font_manager / card_renderer（985 行 Pillow）
_conf_schema.json (450)      配置 Schema
```

**关键事实**

- `handler.py` 是混合层：下载、画质降级、子进程合并与 `event.send`、`Comp.*` 组件构造写在同一个方法里（如 `core/bilibili/handler.py:1010 _process_bili_video`）。
- 各平台实际协议：

| 平台 | 协议 | 签名/鉴权 | 依赖 |
| --- | --- | --- | --- |
| B站 | `bilibili-api-python` 高阶封装（`get_info` / `get_download_url` / `VideoDownloadURLDataDetecter`） | WBI 签名（库内实现）+ 可选 Cookie | `bilibili-api-python >=17.4,<18` |
| 抖音 | `iesdouyin` iteminfo / slidesinfo（免签）+ `aweme/detail`（需签名） | a_bogus + WebSign | `gmssl`（SM3）、`msgspec` |
| 小红书 | `explore` HTML 内 `window.__INITIAL_STATE__` | 无 | `aiohttp` |
| 微博 | `weibo.com/ajax/statuses/show` + 访客 Cookie `genvisitor2` | 无签名，访客/登录双态 | `httpx` |
| X | `api.fxtwitter.com/status/{id}` | 无 | `httpx` |
| YouTube | yt-dlp **Python 库**（线程内调用） | Cookie 文件 | `yt-dlp >=2026.8.19` |
| 通用站点 | yt-dlp 提取器**内省**（`gen_extractor_classes()` + `suitable()`） | 同上 | 同上 |

- **下载器**：`main.py:935 _download_stream` 统一流式下载，`.part` 临时文件 + `replace` 原子落盘，`2**attempt` 指数退避，4xx（除 408/429）不重试；**`timeout=None`，无总超时**。
- **并发**：全仓库无 `Semaphore`；小红书图片用无上限 `asyncio.gather`；最坏单图请求数约 26 次（4 原图候选 + 9 兜底候选）× 2 种 header × (retry+1)。
- **卡片渲染**：900px 宽、6 套主题、明暗由**服务器本地时间**决定（19:00–08:00 走暗色，且 `force_dark` 未被调用）、`embedded_color` 绘制彩色 Emoji、高斯模糊半径 20；渐变条与毛玻璃为死代码。
- **配置缺陷（已在源码确认）**：`main.py:183-188` 读取 `bili_settings.video_codecs` / `allow_hdr` / `allow_dolby`，但 Schema 中**不存在**这三个键 → 恒取默认值，即 HDR/杜比/编码选择在原项目里是死配置。
- **Cookie**：4 个明文配置项，其中 B站/YouTube/通用站点三个会落盘成明文文件（`data/cookies/*.txt`），微博仅注入内存。
- **框架耦合点**：`@filter.regex` 七个处理器 + JSON 卡片分发器、`event.send(MessageChain([Nodes]))` 合并转发、`Image/Video.fromFileSystem`、`set_msg_emoji_like` 表情回应、群黑/白名单、`should_call_llm`、`cleanup_files`。

### 2.2 目标平台 `@deepseek-ai/dsh` 0.2.2-rc.1

**版本与运行时**：`engines.node >= 24.9.0`；Cordis 4.1（vendored fork `@deepseek-ai/cordis`）。

**插件形态**（官方样板 `dsh-tool-todo`、`dsh-tool-present`）：

```js
export const name = 'xxx';
export const inject = ['tools'];
export const Config = z.object({ ... });          // @deepseek-ai/schemastery
export function apply(ctx, config) { ctx.tools.register(defineTool({...})); }
```

**工具契约（强制）**

- `ctx.tools.register(definition, options?) => () => void`。
- `defineTool({ name, description, parameters, output: { schema, render }, execute, ... })`；**缺 `output.schema` 或 `output.render` 会在注册时抛 `TypeError`**。
- `execute(args, exec)` 只返回规范化 JSON 值；模型可见文本由 `render(args, value): ContentBlock[]` 生成。
- 参数 schema 是 DSH 自有 `ParameterSchemaSpec` DSL（不是 zod，也不是 raw JSON Schema）；Config 统一用 schemastery。
- `ContentBlock` 词表：`text / reasoning / image / file / tool-call / tool-addition / tool-removal`。
- `image` 块必须携带 `ImageAttachmentRef`（由 `ctx.attachments.saveImage(...)` 铸造）。
- **客户端不给自定义工具渲染图片画廊**：`imageCardModel` 硬判 `call.name === "read_image"`，且 `tool.call.images` 是 single child slot。文件交付走 `present` 工具（`deliverables/presented` → `PresentedFileCard`）。

**上下文与消息能力**

| 能力 | API | 说明 |
| --- | --- | --- |
| 用户消息通知 | `agent/inbox/inserted`、`session/event`（含 `user/message`） | emit |
| 系统提示段 | `ctx.systemPrompt.section()` / `.context()` / `.variable()` | `context()` 物化为 durable user-role 快照 |
| 每 agent 上下文注入 | `agent.inject(userMessage)` | 不唤醒驱动，落库为 `agent/inbox/spliced` |
| 改写本步消息 | `agent/pre-step` 返回 `{ ...decision, kind: 'enter', messages }` | 必须 spread 保留 `startsRequestSeries` |
| 主动发送 | `agent.followup()` / `steer()` / `send(msg, target, wakeup)` / `agent.inbox.*` | 入参是 `UserMessage`（文本语义） |
| 明确不可用 | `agent/request` 不可改消息（且 deprecated）、`llm/stream` deep-frozen、无 `beforeRequest`/`middleware` | — |

**生命周期**：`ctx.effect(fn)` 收集 disposer（逆序执行）；`ctx.on()` 返回 disposer；**不存在 `ctx.on('dispose')`**；`ctx.tools.register` 内部走分层 effect，插件卸载会自动注销工具。注册到 `agent.ctx` 的 effect **不会**因插件卸载而释放，需自行持有 disposer。

**会话/工作区**：`exec.agent.session`、`session.header.cwd`、`ctx.workingDirectory.ensure(agent, signal)`；读取历史**必须**走 `ctx.sessionProjections`（`session.eventAt/snapshotEvents/ownEvents` 全部 deprecated 且禁止新调用）。

**分发**：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`（`- insert: [{ id, name, config }]`）；`engines.dsh` 一旦声明即**独占**版本判定（peer 全忽略），用 `semver.satisfies(..., { includePrerelease: true })`；`dsh plugin --profile <p> add link:<abs>` 受支持。

### 2.3 本机环境实测

| 项 | 值 | 影响 |
| --- | --- | --- |
| Node | v24.22.3 | 满足 `>=24.9.0` |
| pnpm / npm | 12.21.0 / 11.19.1 | 满足构建与打包 |
| `ffmpeg` | **未安装** | B站音视频合并、yt-dlp 合流不可用 → 相关集成测试标记「环境受限」 |
| `yt-dlp` | **未安装** | YouTube/通用站点不可用 → 同上 |
| `python3` | 3.13.5 | 仅用于生成签名黄金向量（开发期），运行期零依赖 |
| `crypto` SM3 | **可用**，`sm3("abc")` 命中标准向量 `66c7f0f4...` | a_bogus 可直接用 Node 原生 SM3，无需 JS 实现 |
| `Headers.getSetCookie()` | 可用 | 微博 `Set-Cookie` 逐条解析可直接实现 |
| `Intl.Segmenter` | 可用 | 若未来做卡片渲染，可用作字素切分 |
| 已装 IM 插件 | `@xmanrui/dsh-im` 5.10.0（web profile） | 决定投递链路的边界（见 §3） |

---

## 3. 投递链路确认（对应「第 1 点」）

### 3.1 结论

**「把解析结果发回会话」在文本层面完全可行；媒体层面受限且需要显式动作。**

`@xmanrui/dsh-im` 提供的公共能力（`PROACTIVE_DELIVERY.md` 明文记载）：

```js
export const inject = ['dshIm'];
await ctx.dshIm.send(botId, targetId, text, { signal, format: 'plain' | 'markdown' });
await ctx.dshIm.listTargets(botId);
await ctx.dshIm.createTarget(botId, { targetId, kind, route, name });
await ctx.dshIm.listBots();
```

**只有这四个方法**，且文档明确：

> 当前主动投递只发送非空文字，不支持在该接口中发送图片、文件、卡片或富文本。

**会话双向同步**同样只同步文字：

> 首版仅同步当前 Host 的文字，不同步图片、文件、卡片、工具过程、审批或历史消息。

而 IM 侧唯一的媒体出口是工具 `dsh_im_return_file`（参数 `{ path }`）：它把文件登记为 outbound artifact，由渠道在**本轮结束后**上传发送；前置条件是「本 turn 由 IM 聊天发起且有活跃 consumer」，否则报 `artifact-consumer-required` 并提示改用 `present`。

### 3.2 三条投递路径与责任划分

| 路径 | 触发条件 | 承载内容 | 由谁负责 |
| --- | --- | --- | --- |
| A. 最终回答同步 | IM 发起的 turn 正常完成 | **文字**（最后一次工具调用之后的回答） | dsh-im（受「通用设置 → 投递」开关控制，默认关闭） |
| B. 主动投递 `ctx.dshIm.send()` | 插件显式调用，需 `botId` + `targetId` | **文字**（plain / markdown） | 本插件（可选增强，非首版必须） |
| C. 媒体交付 | IM turn：`dsh_im_return_file`；Web：`present` | 文件 / 图片 / 视频（作为文件） | 本插件产出本地文件 + 引导模型调用对应工具 |

### 3.3 对本插件的设计含义

1. **本插件不承担 IM 投递**，只负责产出「结构化结果 + 本地文件绝对路径」，这与你设定的分工一致。
2. **媒体必须留出显式动作**：`resolve_link` 默认只返回元数据与直链；需要落地文件时返回 `downloads[]`（本地路径），并在工具结果文本里提示「如需交付，请调用 `present` 或 `dsh_im_return_file`」。
3. **不做静默推送**：不主动 `dshIm.send()` 发解析结果，避免与 dsh-im 的回答同步重复投递（同一 turn 会到聊天两次）。
4. **模式 B 的注入内容必须是文本摘要**（标题/作者/时长/媒体数量/直链），不能塞二进制。

### 3.4 程序化调用 `dsh_im_return_file` 的可行性

**结论：进程内可以，进程外不行；并且是否成功取决于「本轮是不是 IM 发起的」。**

#### (1) 进程内（插件 TS 代码）——可以

DSH 的 `ToolsService` 暴露了程序化执行入口（`@deepseek-ai/dsh-tools/lib/types/index.d.ts:130`）：

```ts
execute(input: ToolBatchInput): Promise<ToolBatchResult>
```

```ts
export interface ToolBatchInput {
  readonly calls: readonly ToolCallBlock[];
  readonly signal: AbortSignal;
  readonly agent?: Agent;              // 提供会话/工作区作用域与执行上下文
  readonly toolSet?: ResolvedToolSet;  // 省略即"仅放行无条件注册"
  readonly log?: { turn: number; step: number };
}
```

注意 `ToolCallBlock.arguments` 是**原始 JSON 字符串**（`dsh-llm/lib/types/types.d.ts:92-99`），不是对象：

```ts
const out = await ctx.tools.execute({
  calls: [{
    type: 'tool-call',
    id: 'lr-file-1' as ToolCallId,
    name: 'dsh_im_return_file',
    arguments: JSON.stringify({ path: absPath }),
  }],
  signal: exec.signal,
  agent: exec.agent,
});
```

`agent` 不可省略：`dsh_im_return_file` 的 `stage()` 需要 `exec.agent.session.header.id` 与 `.cwd`，缺失即抛 `artifact-context-required`。

#### (2) 进程外（独立脚本 / 另一个进程）——不行

工具活在 Host 进程的 cordis context 内；进程外只剩 HTTP 与 Connection RPC，而 dsh-im 的 RPC `message.send` **只发文本**，没有文件通道。`@xmanrui/dsh-im` 的 `exports` 仅有 `.` 与 `./client`，artifact registry 是模块内单例，无法从外部 import。

#### (3) 三个限制（都会导致运行时失败或静默失败）

| # | 限制 | 表现 | 规避 |
| --- | --- | --- | --- |
| L1 | 需要活跃的 IM 投递消费者 | Web 发起的 turn 调用即抛 `artifact-consumer-required`，错误消息自身建议改用 `present` | 先试后回退：捕获该错误码再调 `present` |
| L2 | 提交依赖 `tools/result` 事件 | 程序化 `execute` 未传 `log` 时根 call/result 事件被省略，事件链是否仍触发**需实测** | P4 实测；不确定则改由模型调用 |
| L3 | 无法自行访问 artifact registry | registry 未导出 | 只能走"调工具"，无绕行路径 |

#### (4) 推荐策略

**默认不代调**，采用「产出路径 + 引导模型调用」：

1. `resolve_link` 在 `render()` 文本中给出本地绝对路径，并明确提示：IM 会话调用 `dsh_im_return_file`、Web 会话调用 `present`。
2. 模型天然知道当前 turn 的来源，比插件猜测 consumer 状态可靠；同时零私有依赖。
3. 若 P4 确需"插件自动投递"，实现为配置项 `autoDeliver`，顺序为：`dsh_im_return_file` → 失败（`artifact-consumer-required`）→ `present` → 均失败则纯文本回退，全程 `try/catch` 且不阻断主结果返回。

---

## 4. 平台可行性矩阵

| 平台 | 可移植性 | 迁移方式 | 主要风险 | 首版 |
| --- | --- | --- | --- | --- |
| X / Twitter | 高 | 直接迁移 fxtwitter JSON 映射 | 第三方接口稳定性 | ✅ |
| 小红书 | 高 | 直接迁移 `__INITIAL_STATE__` 解析 | 页面结构漂移 | ✅ |
| 微博 | 中高 | 直接迁移 JSON + 访客 Cookie 双态 | 风控 / 访客校验 | ✅ |
| 抖音（图文/slides/分享页） | 中 | 迁移 iteminfo / slidesinfo / `_ROUTER_DATA` | 字段兼容、msgspec 严格性 | ✅ |
| 抖音（web 详情签名） | 已完成 | 重写 a_bogus + WebSign（`src/sign/*`） | 已用黄金向量 + 真实链接验证（见 `docs/p2-douyin-report.md`） | ✅ P2 提前 |
| B站 | 已完成 | WBI + DASH 解析 + 画质/编码选择 + ffmpeg 合并（`src/resolvers/bilibili.ts`） | 真实链接验证通过；合并路径待 ffmpeg 环境（见 `docs/p2-bilibili-report.md`） | ✅ P2 |
| YouTube | 已完成 | yt-dlp CLI 包装（`src/media/ytdlp.ts`） | 真实元数据 + 下载验证通过（`docs/p3-report.md`） | ✅ P3 |
| 通用站点 | 已完成（代码） | CLI + 域名白名单 | 白名单单测通过；缺真实链接冒烟 | ✅ P3 |

**「不可移植」清单（删除或改造）**

| 原能力 | 处理方式 |
| --- | --- |
| `@filter.regex` 自动监听 | 改为 模式 B（L1 提示 + L2 注入） |
| `event.send` / 合并转发 / 节点 | 改为工具结果 + `present` / `dsh_im_return_file` |
| `set_msg_emoji_like` 表情回应 | 删除 |
| 群黑/白名单 | 改为按工作区/会话的启用与排除配置 |
| QQ 图片体积上限 `qq_image_size_limit_mb` | 改为通用「媒体尺寸守卫」 |
| Pillow 卡片渲染（985 行） | 本期不做；若恢复则用 SVG/satori 或纯文本摘要 |
| 字体自动安装（Noto CJK + OpenMoji 下载） | 删除 |
| Cookie 落盘 `cookies/*.txt` | 改为 DSH 凭据服务 + 遮罩读取 |
| 死配置三键（`video_codecs` / `allow_hdr` / `allow_dolby`） | 不迁移（或作为正式能力重新设计） |

---

## 5. 目标架构

```
dsh-link-resolver/
  package.json                 # name=dsh-plugin-link-resolver, type=module, exports, dsh.bundle
  cordis.patch.yml             # - insert: [{ id: link-resolver, name, config }]
  tsconfig.json
  src/
    index.ts                   # Cordis 入口：name / inject / Config / apply
    adapter/                   # 唯一允许出现 DSH API 的层
      tool.ts                  # resolve_link 定义 + output.render
      config.ts                # schemastery schema + 敏感项读取
      context.ts               # 系统提示段 / inbox 监听 / agent.inject
      projection.ts            # 会话级去重 projection
    core/
      registry.ts              # 平台注册表（对齐原 registry.py）
      url.ts                   # 识别 / 规范化 / 去重 / 短链
      result.ts                # 统一数据模型 + 错误模型
      http.ts                  # 请求封装：超时 / 重试 / 限流 / SSRF 守卫
      limits.ts                # 大小、时长、数量、并发
    resolvers/
      bilibili.ts douyin.ts xhs.ts weibo.ts twitter.ts youtube.ts generic.ts
    media/
      download.ts              # fetch 流式下载 + .part + 原子替换 + AbortSignal
      ffmpeg.ts                # spawn 参数数组 + 超时 + 子进程回收
      ytdlp.ts                 # CLI 包装：--print-json / -f / --max-filesize / -J
      cache.ts                 # 目录布局 + TTL 清理
    sign/
      wbi.ts                   # B站 WBI
      abogus.ts                # 抖音 a_bogus（SM3 走 node:crypto）
      websign.ts               # 抖音 WebSign（MD5 + 固定盐）
  test/                        # node:test
  fixtures/                    # 录制的 JSON 样本 + 签名黄金向量
  docs/
```

**四条硬约束**

1. `adapter/` 之外不得出现任何 DSH API（解析器只接收 `AbortSignal` 与 `HttpClient`，返回纯数据）。
2. 原 Python 项目只作协议参考：不 import、不 spawn python、不包装成外部服务。
3. 签名与常量用黄金向量锁死：开发期用原 Python 生成固定输入→输出样本，运行时零 Python 依赖。
4. 单一出口：所有平台经 `core/result.ts` 归一化，禁止平台自有返回结构外泄。

---

## 6. 工作模式（A / B / 零 LLM 草案）

### 6.1 模式 A：Agent 主动调用（核心）

工具名 `resolve_link`。

```ts
parameters: {
  url:        { type: 'string',  required: true,  description: '受支持的链接（B站/抖音/小红书/微博/X/YouTube）' },
  download:   { type: 'boolean', default: false,  description: '是否下载媒体到本地缓存（默认只解析元数据）' },
  maxItems:   { type: 'integer', description: '媒体数量上限（图片/视频），覆盖配置默认值' },
  maxHeight:  { type: 'integer', description: '视频高度上限（px），仅影响下载选择' },
}
```

`execute` 流程：识别平台 → 解析元数据 → （可选）落盘媒体 → 返回统一模型。

`output.render` 输出纯文本 + 直链 + 本地路径，**不返回 image 块**（客户端不会渲染），必要时提示调用 `present` / `dsh_im_return_file`。

### 6.2 模式 B：L1 + L2

**L1（默认开启，零副作用）**：`ctx.systemPrompt.section({ name: 'link-resolver:guidance', text })`，内容是短规则：

> 当用户消息包含受支持平台的链接时，先调用 `resolve_link` 获取真实标题、作者与媒体信息，再回答；不要凭链接文本猜测内容。

**L2（默认开启，可关）**：监听 `agent/inbox/inserted`：

1. 从 `message` 的文本块中提取候选链接（复用 `core/url.ts`）。
2. 命中受支持平台 → 立即 `agent.inject()` 一条**短上下文**：「检测到 B站链接，可用 resolve_link 解析；建议先取元数据」。**不在注入阶段做网络解析**，避免拖慢 step。
3. 是否允许 L2 在注入前预解析（带 3s 超时）作为配置项，默认关闭。

**明确不做 L3**：不在 `agent/pre-step` 里做网络解析并改写消息——该钩子每步都执行，任一路径超时都会拖慢整个 step。

**会话级去重**：注册一个 `ctx.sessionProjections` 单元 `linkResolver`，记录本会话已解析的 `platform:id`；同一链接重复出现时返回 cached 结果并标注 `cached: true`。（不得使用 `session.events` / `snapshotEvents`，已被禁止。）

### 6.3 对 LLM 的依赖分层（以及"零 LLM 模式"的成立条件）

这一节回答一个会反过来影响架构的问题：**这套实现是否必然需要 LLM 参与？**

答案是分层的——解析、呈现、投递三件事的依赖关系完全不同。

| 环节 | 依赖 LLM | 机制 | 确定性 |
| --- | --- | --- | --- |
| 链接识别 + 解析 | **否** | `agent/inbox/inserted` / `session/event`（`user/message`）只是事件钩子，插件自行发 HTTP | 确定 |
| 文本推送到 IM | **否** | `ctx.dshIm.send(botId, targetId, text)` 为直接 API 调用 | 确定，但有前置条件（见下） |
| 媒体文件交付 | **当前是** | 只有 `dsh_im_return_file`（需活跃 IM consumer）与 `present` | 待验证（见 §3.4） |
| 零 LLM 的完整链路 | 理论可行，有坑 | 需阻止模型处理该消息 | **未验证** |

**隐藏依赖**：在 DSH 里，用户消息一旦进入 inbox 就会驱动一个 turn，模型**无论如何会被调用一次**。这与原项目不同——AstrBot 的 `@filter.regex` 直接接管，模型全程不参与。要在 DSH 复现"零 LLM"，必须显式拒绝该 step：

```ts
ctx.on('agent/pre-step', async ({ messages }, next) => {
  if (hasSupportedLink(messages)) {
    // 自行解析 + 自行推送
    return { kind: 'reject' };   // 不让模型进入本步
  }
  return next();
});
```

`PreStepDecision` 中确实存在 `{ kind: 'reject' }`。**P0 已用探针插件实测**（2026-11-17，`docs/p0-report.md` §2.2）：

| 观测点 | 实测结果 |
| --- | --- |
| 模型是否被调用 | 否（无 `step_start`、无 usage、无 `assistant/message`） |
| turn 结束状态 | `blocked`；headless 退出码 1，`final.text` 为空 |
| 用户消息去向 | `inbox/inserted` → `claimed` 后被消费，不会留到下一轮 |

结论：`reject` 是真正的零 LLM 通道，但**本轮不会产生任何回答**。因此 `autoPush` 必须在 reject 前完成 `ctx.dshIm.send()`；投递失败时应放行（`next()`）让模型兜底，否则用户看到的是彻底静默。

**两条硬约束（决定零 LLM 模式的边界）**

1. `ctx.dshIm.send()` 必须显式传 `botId` + `targetId`；而 dsh-im 维护的"Session 当前聊天绑定"**未对外暴露**（公开方法只有 `send` / `listTargets` / `createTarget` / `listBots`）。因此"谁发来就回给谁"需要用户在配置里指定投递目标。
2. 媒体只有 IM 发起的 turn 才有投递通道（`artifact-consumer-required`）。零 LLM 模式下若要推视频/图集，除非程序化调用 `dsh_im_return_file` 成功，否则只能退回给链接。

**零 LLM 模式草案（`autoPush`，默认关闭，列为 P4 可选项）**

```
autoPush: false
  ├─ 监听 agent/inbox/inserted
  ├─ 命中受支持链接 → 解析（带超时）
  ├─ ctx.dshIm.send(botId, targetId, 摘要文本)
  ├─ 媒体：dsh_im_return_file → 失败回退 present → 再失败只留链接
  └─ 阻止模型：pre-step 返回 reject（已实测：turn 以 blocked 结束、无回答，故必须先投递成功再 reject）
```

**当前取舍**：首版仍以模式 A 为核心，不是"必须用 LLM"，而是工具路径行为可预期、结果天然进入会话、且无需维护投递目标。零 LLM 模式作为可选增强，代价是**手动配置投递目标、媒体可能降级为链接、`pre-step` 拒绝语义待验证**。

---

## 7. 统一数据模型

```ts
type Platform = 'bilibili' | 'douyin' | 'xiaohongshu' | 'weibo' | 'twitter' | 'youtube' | 'generic';

interface ResolvedLink {
  platform: Platform;
  url: string;               // 规范化后的链接
  originalUrl: string;       // 用户输入的原始链接
  contentId: string;         // bvid / aweme_id / note_id / mid / tweet_id / video_id
  type: 'video' | 'images' | 'image' | 'text' | 'mixed';
  title?: string;
  description?: string;
  author?: string;
  authorId?: string;
  cover?: string;
  durationSec?: number;
  media: MediaItem[];
  stats?: { views?: number; likes?: number; comments?: number; shares?: number; coins?: number };
  downloads?: LocalFile[];   // 仅 download=true 时出现
  warnings: string[];        // 降级、跳过、截断等
  cached?: boolean;
}

interface MediaItem {
  kind: 'video' | 'image' | 'livephoto-video';
  url: string;               // 原始直链（可能带时效签名）
  candidates?: string[];     // 备用地址
  width?: number; height?: number;
  filesize?: number; mimeType?: string;
  quality?: { label: string; height?: number; codec?: 'avc' | 'hevc' | 'av1' };
  pairedWith?: number;       // Live Photo：静态图 ↔ 动态视频的索引关联
}

interface LocalFile { path: string; bytes: number; mimeType?: string; kind: 'video' | 'image'; }
```

**错误模型**（对 Agent 可读、可决策）：

```ts
type ErrorCode =
  | 'unsupported-url' | 'not-found' | 'auth-required' | 'rate-limited'
  | 'network' | 'timeout' | 'size-exceeded' | 'duration-exceeded'
  | 'tool-missing' | 'parse-failed' | 'download-failed' | 'blocked-domain';
```

错误一律通过工具返回结构化错误（`isError` + 建议下一步），**不抛未捕获异常**。

---

## 8. 配置方案（建议约 25 键）

| 分组 | 键 | 默认 | 说明 |
| --- | --- | --- | --- |
| 通用 | `enabled` | true | 插件总开关 |
| | `toolEnabled` | true | 模式 A 开关 |
| | `autoGuidance` | true | 模式 B L1 |
| | `inboxHint` | true | 模式 B L2 |
| | `enabledPlatforms` | 全部（generic 除外） | 平台白名单 |
| | `resolveTimeoutMs` | 20000 | 单平台解析超时 |
| | `downloadTimeoutMs` | 300000 | 下载总超时 |
| | `retryCount` | 2 | 重试次数 |
| | `maxConcurrent` | 2 | 全局限并发（原项目缺口，本期补齐） |
| | `cacheTtlHours` | 24 | 媒体缓存有效期 |
| | `maxCacheMb` | 2048 | 缓存上限 |
| B站 | `bilibili.cookies` | '' | 凭据服务优先，遮罩显示 |
| | `bilibili.quality` | '1080P' | 目标画质 |
| | `bilibili.codec` | 'avc' | avc / hevc / av1 |
| | `bilibili.allowFallback` | true | 超限降画质 |
| | `bilibili.maxPages` | 1 | 多P上限 |
| 抖音 | `douyin.maxMedia` | 30 | 媒体数量上限 |
| | `douyin.useSignedApi` | false | 是否启用 a_bogus 路径 |
| 小红书 | `xhs.downloadOriginal` | true | 原图优先 |
| | `xhs.maxMedia` | 30 | 媒体数量上限 |
| 微博 | `weibo.cookies` | '' | 可选 |
| | `weibo.maxMedia` | 30 | 媒体数量上限 |
| X | `twitter.maxMedia` | 30 | 媒体数量上限 |
| YouTube | `youtube.ytdlpPath` | 'yt-dlp' | PATH 查找，不写死绝对路径 |
| | `youtube.maxHeight` | 1080 | |
| 通用站点 | `generic.enabled` | **false** | 默认关闭 |
| | `generic.allowedDomains` | 精选白名单 | 取代 yt-dlp 内省 |
| | `generic.maxHeight` | 720 | |
| 外部工具 | `ffmpegPath` | 'ffmpeg' | 缺失时降级并告警 |
| 下载 | `maxDownloadMb` | 200 | 大小上限 |
| | `maxDurationSec` | 300 | 时长上限 |

敏感项（四个 Cookie）通过 `ctx.credentials` / 遮罩机制读取，**不写明文文件、不进日志**。

---

## 9. 安全与可靠性

| 项 | 要求 | 实现位置 |
| --- | --- | --- |
| SSRF | 拒绝私网/回环/链路本地/云元数据/非 http(s)，每次重定向重新校验 | `core/http.ts` |
| 短链 | 展开后重新过一遍安全校验 | `core/url.ts` |
| 外部命令 | 参数数组 `spawn`，禁止 shell 拼接；超时 + 输出截断 + 进程组回收 | `media/ffmpeg.ts`, `media/ytdlp.ts` |
| 下载 | `Content-Length` 预检 + 流式累计硬限 + 总超时 + AbortSignal + `.part` 清理 | `media/download.ts` |
| 并发 | 全局令牌桶（原项目缺失，本期补） | `core/limits.ts` |
| 路径 | 缓存根目录之外不可写；禁止路径穿越 | `media/cache.ts` |
| 凭据 | 不打印 Cookie/Token；不进测试快照 | 全链路 |
| 内容 | 默认只处理用户明确给出的链接；generic 默认关闭且需白名单 | 配置 |

---

## 10. 风险登记册

| # | 风险 | 等级 | 对策 |
| --- | --- | --- | --- |
| R1 | 抖音 a_bogus 移植错误 | 低（已闭环） | 3 组黄金向量逐字节一致 + 真实链接解析成功；SM3 用 `node:crypto`；相关代码在 `src/sign/abogus.ts` |
| R2 | B站 WBI 签名与 DASH 选择错误 | 中高 | 先实现 nav→img_key/sub_key→mixin key；用真实视频比对可用画质列表；HEVC `hvc1/hev1` 归一化照抄 |
| R3 | 通用站点判定能力退化 | 中高 | 改为白名单 + 用户自定义域名；文档明确「不再等价于 yt-dlp 全站支持」 |
| R4 | 外部工具缺失（本机无 ffmpeg/yt-dlp） | 中 | 版本探测 + 缺失时明确报错并降级；集成测试标「环境受限」 |
| R5 | 媒体无法直接回显 | 中 | 默认文本 + 直链；文件经 `present` / `dsh_im_return_file`；如实写入 README |
| R6 | 平台风控变化 | 中 | 结构化错误码 + 候选地址回退 + 可切换签名路径 |
| R7 | AGPL-3.0 义务 | 中 | 包 `license: AGPL-3.0-only` + 完整 LICENSE + README 注明来源与作者 |
| R8 | 大文件拖垮会话 | 中 | 默认不下载；显式 `download` + 大小/时长/并发限制 |
| R9 | 会话去重实现走错 API | 低 | 只用 `sessionProjections`，禁用 `session.events` |
| R10 | 插件卸载残留 | 低 | 一律 `ctx.effect`；`agent.ctx` 注册必须双持有 disposer |
| R11 | 程序化调用 `dsh_im_return_file` 依赖 turn 来源，且提交事件链未实测 | 中 | 默认不代调（产出路径 + 引导模型调用）；若做 `autoDeliver`，按 `dsh_im_return_file` → `present` → 文本 三级回退，并在 P4 实测 `tools/result` 是否触发 |
| R12 | 零 LLM 模式依赖 `agent/pre-step` 的 `reject` 语义 | 低（已实测） | P0 实测：reject 跳过模型、turn 以 `blocked` 结束、无回答文本。实现 `autoPush` 时必须「先投递成功再 reject，投递失败则放行」 |

---

## 11. 分期实施计划

| 阶段 | 内容 | 交付物 | 验证 |
| --- | --- | --- | --- |
| **P0 骨架**（0.5–1 天） | `package.json` / `cordis.patch.yml` / tsconfig / 构建脚本 / `Config` / `apply` / 空工具 | 可加载的最小插件 | `dsh plugin add link:<abs>` + 冒烟加载 + 工具出现在列表 |
| **P1 核心 + 低风险平台**（1.5–2 天） | `registry` / `url` / `http` / `result` / `limits`；X、小红书、微博、抖音免签路径；`resolve_link` 完整实现 | 首个可用版本 | 单测 + 四平台真实解析 |
| **P2 B站**（1–1.5 天） | WBI 签名、DASH 解析、画质/编码选择、下载、ffmpeg 合并、降级 | B站可用 | 黄金向量 + 真实视频（含多P） |
| **P3 抖音签名 + YouTube/generic**（1.5–2 天） | a_bogus/WebSign；yt-dlp CLI 包装（含 `--max-filesize`、`-J`、取消）、白名单 | 全平台覆盖 | 黄金向量 + 真实请求（外部工具缺失处标注） |
| **P4 交付与发布**（1 天） | 模式 B 打磨、可选 `autoDeliver` / `autoPush`（含 `pre-step` reject 与 `tools/result` 事件实测）、缓存清理、README、CHANGELOG、LICENSE、`npm pack --dry-run`、tarball 独立安装、卸载验证 | 发布候选 | 全套验收命令 |

**关键前置**：P0 必须先验证「工具注册 + 一次真实调用 + 结果渲染」，再进入平台迁移（TASK.md 明确要求）。

---

## 12. 验收标准（可执行）

```bash
pnpm -s tsc --noEmit                  # 类型检查
node --test test/                     # 单元 + 集成测试
npm pack --dry-run                    # 包清单
npm pack                              # 生成 tarball
dsh plugin --profile <p> add link:<abs>   # 本地安装
dsh web                               # 启动并确认工具可见、可调用
```

必须逐项记录：**通过 / 失败 / 未执行 / 环境受限**（不得把 mock 通过当成真实平台验证）。

---

## 13. 未决问题

1. 包名最终确认：`dsh-plugin-link-resolver`（TASK.md 暂定）还是更短的 `dsh-link-resolver`（与工作区 `dsh-bark-push` 风格一致）。
2. 缓存目录位置：DSH home 下 `data/link-resolver/`（跨会话共享）vs 工作区内 `.dsh/cache/`（随项目走）。
3. 是否在 P4 提供可选的 `ctx.dshIm.send()` 文本推送（仅摘要，不含媒体）。
4. 通用站点白名单的初始集合（建议：TikTok / Instagram / Facebook / AcFun / Reddit / Bilibili 国际站除外）。
5. 是否在 P4 实测并启用 `autoDeliver`（插件程序化调用 `dsh_im_return_file`）；当前默认方案是由模型调用，插件只给路径与提示。
6. **是否保留零 LLM 模式（`autoPush`）**：机制已在 P0 实测成立（reject 可跳过模型，但该轮无回答、需插件自行投递），剩余为产品取舍，建议在 P1 之前定案（见 §6.3）。

---

## 附录 A：证据索引

**原项目**

- 规模与结构：`wc -l` 全量统计；`core/registry.py:48-76`
- 下载器：`main.py:885-1014`（`_probe_stream_size` / `_stream` / 4xx 不重试）
- 合并：`main.py:1016-1041`（`_merge_av`，参数数组调用 ffmpeg）
- B站：`core/bilibili/handler.py:547-750`（流选择 + 降级下载）
- 抖音签名：`core/douyin/abogus.py`（877 行）、`core/douyin/websign.py`、`core/douyin/guest_api.py`
- 小红书原图链路：`core/xiaohongshu/handler.py:165-529`
- 微博：`core/weibo/extractor.py:245-346`（访客 Cookie + 状态码分支）
- 卡片渲染：`core/common/card_renderer/base.py`（900px/布局）、`components.py`、`themes.py:120-127`
- 配置缺陷：`main.py:183-188` vs `_conf_schema.json`

**DSH**

- 插件四件套：`@deepseek-ai/dsh-tool-todo/lib/index.js`、`dsh-tool-present/lib/types/index.d.ts`
- 工具契约强制 `output`：`@deepseek-ai/dsh-tools/lib/index.js:436`
- 程序化执行工具：`@deepseek-ai/dsh-tools/lib/types/index.d.ts:130`（`execute(ToolBatchInput)`）
- 批次入参形态：`@deepseek-ai/dsh-tools/lib/types/executor.d.ts:16-56`（`calls` / `signal` / `agent` / `toolSet` / `log`）
- `ToolCallBlock`（`arguments` 为 JSON 字符串）：`@deepseek-ai/dsh-llm/lib/types/types.d.ts:92-99`
- `ContentBlock` 词表：`@deepseek-ai/dsh-llm/lib/types/types.d.ts:121-133`
- `ImageBlock` 需 attachment：同上 `:68-78`
- 客户端图片硬绑 `read_image`：`@deepseek-ai/dsh-client-ui-tool/lib/client.js:2971`
- `present` 与文件卡：`@deepseek-ai/dsh-tool-present/lib/index.js:24-124`
- 上下文与消息：`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:213-237, 290-339`
- `PreStepDecision`（`reject` / `enter`）：同文件 `:117-124`；`agent/pre-step` 说明 `:320-339`
- 系统提示注册表：`@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:27, 256-299`
- 生命周期：`@deepseek-ai/cordis/src/fiber.ts:408-424`、`events.ts:285-307`
- 版本校验：`@deepseek-ai/dsh-app-boot/lib/index.js:1094-1117`
- `link:` 安装：`@deepseek-ai/dsh-plugin-manager/lib/index.js:223-232`
- 官方插件开发 skill：`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`

**IM**

- 服务方法：`@xmanrui/dsh-im/PROACTIVE_DELIVERY.md`「在同一 Host 的插件中发送」
- 仅文本限制：同文档「投递语义与限制」
- 文件返回工具：`@xmanrui/dsh-im/src/channels/shared/semantic/artifact.mjs`（`OUTBOUND_ARTIFACT_TOOL = 'dsh_im_return_file'`）
- 消费者前置条件与提交链：同文件 `stage()`（`artifact-context-required` / `artifact-consumer-required`）、`commit()`、`take()`；包 `exports` 仅 `.` 与 `./client`（registry 不可外部 import）
- `tools/result` 提交钩子：同文件 `XNe()` 内 `onResult` + `n.on("tools/result", ...)`