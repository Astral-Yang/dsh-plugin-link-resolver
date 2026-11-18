# 链接自动处理链路：需求契约

- 版本基线：`dsh-plugin-link-resolver@1.0.0-rc.16`
- 日期：2026-11-18
- 状态：**需求定稿（仍未改代码）**，第 6 节两项待验证后再进入实现。

一句话：三种模式收敛为**一条链路**——插件把链接解析、下载、交付全部做完，再把结果作为上下文递给模型，模型只做播报，本轮以 `completed` 结束。

---

## 1. 现状（rc.16，作为复盘基线）

单一配置项 `mode`，其余布尔由它派生（`src/adapter/config.ts:84-88`、`:152-154`）：

| mode | autoDownload | autoDeliver | autoProcess | 实际装配的监听器（`src/index.ts:52-65`） |
| --- | --- | --- | --- | --- |
| `auto` | ✔ | ✔ | ✔ | `installAutoProcess`（inbox 预下载 + pre-step 交付/结束轮次） |
| `assistant` | ✔ | ✔ | ✘ | `installInboxHint`（消息含链接时注入一句提示） |
| `metadata` | ✘ | ✘ | ✘ | `installInboxHint` |

两条执行路径共用同一管线（`src/adapter/pipeline.ts`），差别只在「谁发起」：工具路径由模型调用 `resolve_link`（`src/adapter/tool.ts:322-337`）；自动路径在 `agent/inbox/inserted` 预启动、在 `agent/pre-step` 交付并决定是否结束轮次（`src/adapter/auto.ts`）。

---

## 2. 渠道能力（外部事实，均已取证）

| # | 事实 | 证据 |
| --- | --- | --- |
| C1 | 轮次结束原因可枚举：`completed` / `blocked` / `aborted` / `error` / … | `dsh-session/lib/types/types.d.ts` → `TurnEndReasonMap` |
| C2 | `agent/pre-step` 返回 `{kind:'reject'}` → 轮次以 **blocked** 结束，无 step、无助手文本 | 实测 `.tmp-rc14.json` |
| C3 | `dsh_im_return_file` **只在本轮存在活跃 IM consumer 时成功**，否则抛 `artifact-consumer-required` | dsh-im `lib/index.js` → `stage()` |
| C4 | IM 渠道只上传 `dsh_im_return_file` **登记**的文件，且只在轮次 completed 时上传；非 completed 按 `TURN_BLOCKED` 处理 | dsh-im 出站 artifact registry |
| C5 | `present` 只写会话 `deliverables/presented`；IM 渠道不会上传它 | `dsh-tool-present/lib/index.js` |
| C6 | `present` 的可用前提是「有 agent + 本轮 turn 处于打开状态」 | 同上 |
| C7 | 工具可见性：`ctx.tools.get(name)` 默认读**全局视图**；`view(scope)` 合并 global 层与 scope 链，全局视图看不到 agent 作用域注册 | `dsh-tools/lib/index.js` → `get` / `view`，`executor.d.ts` → `ToolBatchInput.toolSet` |
| C8 | dsh-im 服务 `dshIm` 暴露 `describeConversation(Sync)(sessionId)`：`null` = 该会话不属于任何 IM 对话；**不暴露** `hasActiveConsumer` | dsh-im README「会话 → 对话反查」 |
| C9 | 同一 Session 可被 Web 与 IM 交替驱动：绑定在 IM 的会话，某一轮来自 Web 完全正常 | 实测 IM 工作区会话 turn 4 无 `<dsh_im_source>` |
| C10 | dsh-im 注册了**全局** `agent/pre-step` 监听器：`await next()` 之后用 `oDe()` 把消息里的 `<dsh_im_source>` / `<dsh_im_source_guidance>` / `<dsh_im_context>` / `<dsh_im_reply_to>` 内联块拆成独立消息（source → notice、guidance → instructions、已拥有的 guidance 去重） | dsh-im `lib/index.js` 唯一一处 `agent/pre-step` 注册 |
| C11 | `agent/pre-step` 是 waterfall：任一监听器不调用 `next()` 直接返回，**后续监听器全部不执行** | DSH `runtime-types.d.ts`（`next: () => Promise<PreStepDecision>`） |

C2 + C4 是旧问题的根源：**「跳过模型」与「IM 收到文件」在机制上互斥。**

---

## 3. 现状链路与实测（rc.16）

| 链路 | 实测结果 |
| --- | --- |
| Web `auto` | 预下载成功后交付失败 → 注入 fallbackHint → 模型跑一轮 → 又调一次 `resolve_link` → 再次失败，最后模型自己去 `read_image` / `ls` 翻下载目录，用户中断（Playground `session-047744be`） |
| IM `auto`（turn 3） | `dsh_im_return_file` 成功 → 注入「请简短确认」→ completed → 上传 ✔ |
| IM `auto`（turn 2） | `turn_end blocked`、无 step；该 profile 内只有本插件会 `reject`，即走了「present 成功 → reject」→ 渠道按 `TURN_BLOCKED` 丢弃 |
| IM `assistant`（turn 1） | `已自动通过 dsh_im_return_file 交付 2 个文件` → completed → 上传 ✔ |

断点汇总：

| 编号 | 问题 | 影响 |
| --- | --- | --- |
| B1 | 交付失败被 `catch {}` 吞掉（`pipeline.ts:232-234`） | 无原因、无日志，用户与模型都不知道为什么没收到文件 |
| B2 | 用全局视图判断交付工具可见性（C7） | Web 下 `present` 可能根本不在可见集里 |
| B3 | 自动路径不写 `SessionCache` | 回退后重复解析、重复下载 |
| B4 | `present` 在 IM 会话「成功假象」→ reject | **IM 丢文件**（最严重） |
| B5 | IM 下 `auto` 无法真正零模型（C4） | 模式描述与实际不符 |
| B6 | 交付结果不记录实际通道 | 无法追溯、无法断言 |
| B7 | 三模式文案写死 | `metadata` 与回退场景误导模型 |
| B8 | Web `auto` 以 blocked 结束 | 用户观感 = 疑似失败轮次 |
| B9 | `pending` 以 session 为键、单槽位 | 多链接丢链接；异常轮次留陈旧 job |
| B10 | 同会话跨渠道（C9） | 「会话级渠道」判定不可靠，只能按本轮 consumer 判定 |

---

## 4. 新契约（已定稿）

### 4.1 决策记录

| 决策 | 结论 |
| --- | --- |
| Web 下以 blocked 结束轮次 | **不接受**——两条渠道都必须以 completed 收尾 |
| IM 下跑一次模型 | **接受**——C4 的直接后果，不是缺陷 |
| 模式数量 | **只保留 `auto`**，三种模式收敛为单链路 |
| 解析/下载失败后重试 | **不允许**，模型只解释原因 |
| 交付失败的兜底 | 允许模型做**一次**交付尝试（它自己可见 `present`），因为文件已经下载，不交付等于白下载 |

### 4.2 链路

```
用户消息含受支持链接
  └ pre-step(step=1)：
      1. 解析（超时 / 重试次数按配置）
      2. 下载（上限：大小 / 时长 / 数量 / 并发）
      3. 交付（按本轮渠道判定，见 4.4）
      4. 注入结果上下文（notice，见 4.3）
  └ 模型 1 步：只播报结果，1–3 句
  └ turn/end: completed
```

关键约束：

- **插件不得再返回 `reject`**；`blocked` 与 `TURN_BLOCKED` 两条失败路径随之消失。
- **必须调用 `next()` 再追加自己的 notice**（C10 + C11）：命中链接时直接 `return` 会短路下游，dsh-im 的内联块拆分器、以及任何其他插件的 pre-step 逻辑都不会执行。rc.19 起改为先 `await next()` 取回下游决策，再把 notice 追加在其后；下游返回 `reject` 时由本插件接管为 `enter`。

### 4.3 注入契约（三态）

成功：

```
[link-resolver] 本轮已自动处理：小红书 · 朽骨与旧梦 · 鸣潮 · 1 视频 / 1 图片
已通过 present 交付 2 个文件。信息已完整：不要再调用 resolve_link，
不要读取 downloads 目录，直接输出 1–3 句介绍。
```

解析/下载失败（不重试）：

```
[link-resolver] 本轮自动处理失败：小红书 · code=download-failed
<一句话原因>。没有可交付的文件；不要调用 resolve_link 重试，
直接说明原因并给出可行建议（例如稍后重新发送链接）。
```

交付失败（文件已在本地）：

```
[link-resolver] 已下载 2 个文件但未能自动交付：reason=no-channel
文件：downloads/xiaohongshu/<id>/01.png、02.mp4（相对工作区路径）
如本轮支持文件交付，可调用一次 present；否则不要伪造交付。
```

硬约束：

- 注入**不包含**本地绝对路径（相对路径只在交付失败态出现，供模型调用 `present`）；
- 注入内容必须是真实结果（标题/作者/时长/类型/媒体数/交付通道），不是「已交付」四个字；
- 同一会话同一链接只注入一次；重复出现在后续轮次时不重复下载（查询会话结果缓存）。

### 4.4 交付判定（每轮独立）

#### 4.4.0 判定顺序：先定「本轮是谁在看」，再选工具

```
origin = 消息带 IM 标记（文本以 <dsh_im_source 开头，或旧形态 plugin:dsh-im 通知）→ 'im'
       否则 dshIm.describeConversationSync(session) 非空            → 'auto'
       否则                                                        → 'local'

im    → dsh_im_return_file（每个文件一次）
        成功 = 已排队（不是已送达）
        失败 → 交付失败态，**不得**改用 present
auto  → 先试 dsh_im_return_file；仅当失败码为 artifact-consumer-required（本轮不是 IM 驱动）
        才退回 present，其余失败原样上报
local → present（一次调用，≤4 个文件）
        不可见/失败 → 交付失败态 tool-unavailable，注入相对路径让模型自行调一次
```

为什么不能「先试 IM 工具、失败再 present」：IM 绑定会话被 Web 打开时（C9），该判定会把 Web 用户当成 IM 用户；反过来，present 在 IM 轮里「成功」但渠道不上传 —— 这正是 rc.16 丢文件的原因（B4）。

来源标记是弱依赖：dsh-im 未安装时不存在该标记，自然走 local 分支。**rc.18 实测发现 dsh-im 当前把 `<dsh_im_source>` 拼在用户消息文本开头**（不是独立通知消息），因此判定必须同时认两种形态；`auto` 分支只在 `artifact-consumer-required` 时退回 present，其余失败原样上报。

#### 4.4.1 Web / 桌面

| 项 | 规则 |
| --- | --- |
| 工具 | `present({ files: [{ path, description }] })`，**绝对路径** |
| 前提 | 有 agent；本轮 turn 打开（pre-step 时成立）；文件为普通文件 |
| 上限 | 最多 4 个：1 个视频 + 最多 3 张图片；其余在注入文本里写明数量与相对目录 |
| 用户看到 | 本轮**结束后**出现文件卡片（`deliverables/presented`），与本轮助手文本一起 |
| 成功判定 | `deliverables/presented` 事件存在，且 files 数一致 |
| 失败原因码 | `tool-unavailable`（作用域不可见，B2）/ `no-open-turn` / `fs-error` / `too-many-files` |

#### 4.4.2 IM

| 项 | 规则 |
| --- | --- |
| 工具 | `dsh_im_return_file({ path })`，**每个文件调用一次**（该工具无批量参数） |
| 顺序 | 视频 → 图片（按下载序号）；封面不作为交付物 |
| 前提 | 本轮存在活跃 IM consumer（工具内部校验，失败抛 `artifact-consumer-required`） |
| 上限 | 受 `maxMedia` 约束；单文件大小由渠道自身限制，插件只守 `maxDownloadMb` |
| 用户看到 | 本轮 **completed 之后**由渠道逐条上传 |
| 成功判定 | 每次调用返回 `artifactId`（= 已排队）。**插件无法确认最终送达**，文案只能说「已交付/已登记」 |
| 失败原因码 | `im-consumer-inactive`（该轮无 consumer）/ `artifact-context-required`（无 live session）/ `fs-error` |
| 部分失败 | 已登记的文件照常上传；未登记的在注入文本里列相对路径，不伪造成功 |

#### 4.4.3 混合场景（IM 绑定会话被 Web 打开）

按 **本轮来源** 判定，不按会话绑定判定。Web 发起的轮次走 `present`，即使该会话绑定了微信；此时微信侧不会收到文件（除非开启了会话双向同步）。

#### 4.4.4 工具解析

判定必须用 **agent 作用域**解析工具（`ctx.tools.get(name, agent)` 或直接带 `agent` 执行并读真实错误），不得用全局视图（C7）。失败一律落日志：`channel` / `tool` / `code` / `message`。

### 4.5 配置面收敛

| 配置 | 处置 |
| --- | --- |
| `mode` | **删除**（单链路） |
| `autoDownload` / `autoDeliver` / `autoProcess` | **删除**（不再派生） |
| `inboxHint` | **删除**（自动链路自带注入） |
| `autoGuidance` | **改写**：「上下文中已出现 `[link-resolver]` 结果时直接采用，不要重复解析、不要读取下载目录」 |
| `downloadMedia` | **新增**，默认 `true`：关闭时只解析元数据、不下载不交付 |
| `toolEnabled` | **默认 `false`**：`resolve_link` 默认不注册，「重复解析」结构上不可能；需要手动解析时打开 |
| 其余（平台白名单、超时、上限、目录、Cookie、ffmpeg/yt-dlp） | 保留 |

### 4.6 事件与状态

- 只监听 `agent/pre-step`；**不再监听** `agent/inbox/inserted`（去掉预启动，预取收益小于复杂度）；
- 删除 `pending` 表（session 单槽位问题随之消失）；改为「本轮 step=1 + 会话级已处理链接集合」去重；
- 解析成功后写入 `SessionCache`，工具路径复用同一份结果与同一目录。

### 4.7 不变项（回归基线）

- IM `assistant` 的成功路径（登记 → completed → 上传）必须保持；
- 下载目录结构 `<workspace>/downloads/<platform>/<contentId>/` 不变；
- `resolve_link` 工具的输出 schema 与渲染不变。

---

## 5. 验收标准（可断言）

| # | 断言 |
| --- | --- |
| A1 | Web：只发一条链接 → 出现 `deliverables/presented`，`turn/end` 为 `completed`，助手文本 ≤ 3 句，无 `![` 本地路径 |
| A2 | IM：只发一条链接 → `dsh_im_return_file` 调用成功，`turn/end` 为 `completed`，渠道收到文件 |
| A3 | 任一渠道：`resolve_link` 在自动链路的轮次内被模型调用次数 = 0 |
| A4 | 解析失败：`turn/end` 为 `completed`，模型回答含原因与建议，且未调用工具 |
| A5 | 交付失败：注入中出现原因码与相对路径，模型不得声称已发送 |
| A6 | 同一链接在同一会话第二次出现：不再下载（命中缓存），不再注入 |

---

## 6. 验证状态

已确认（rc.17 headless 实测）：

| 场景 | 结果 |
| --- | --- |
| 本地轮次 + `present` 可用 | 注入真实结果 → `deliverables/presented` → `turn_end completed`；模型 0 次工具调用 |
| 本地轮次 + 无 `present` | 注入 `交付：未完成（tool-unavailable）` → 模型如实说明未交付、未声称已发送 |
| 单测 | 43/43 通过（含 notice / chain / 交付判定用例；新增「命中链接必须调用 next() 且保留下游消息」断言） |
| rc.19 headless | 消息顺序为 `user → runtime-context → link-resolver notice`，`present` 交付成功，`turn_end completed`，模型 0 次工具调用 |

仍待确认：

1. **B2（真实 Web profile）**：`present` 由 agent preset 装配，需在实际 Web 会话确认 `ctx.tools.get('present', agent)` 可见。rc.17 的交付日志会打印
   `交付判定 origin=local im=visible|hidden present=visible|hidden（全局视图 …）`，一次真实会话即可定论；
   若仍不可见，则 4.4 的第 2 步退化为「把 `present` 留给模型调用」。
2. **IM 真实链路**：`plugin:dsh-im` 来源判定与 `dsh_im_return_file` 登记需在真实 IM 轮次复验（rc.16 的 turn 1/turn 3 是回归基线）。

---

## 7. 实现记录（rc.17 已完成）

1. ✅ 交付判定与原因码（`pipeline.deliverFiles`）；
2. ✅ 单链路 pre-step（`adapter/chain.ts`，删除 `auto.ts` / `inbox.ts` 与 `pending` 表）；
3. ✅ 注入文案（`adapter/notice.ts`）与 guidance 改写；
4. ✅ 配置 Schema 收缩（`downloadMedia` 新增、`toolEnabled` 默认关）与设置卡片；
5. ✅ README / CHANGELOG / 本文档同步；A1–A3、A6 已在 headless 验证，A2 待 IM 真机复验。