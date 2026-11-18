# P0 阶段报告：插件骨架与 DSH 集成验真

- 日期：2026-11-17
- 范围：TASK.md 阶段三前半（插件入口 / Bundle / 配置 Schema / 生命周期 / 统一接口 / URL 识别与分发 / 工具注册 / 错误处理）
- 结论：**P0 目标达成**，DSH 能组合、导入并挂载本插件；V9（真实 LLM 工具调用）与 V10（`agent/pre-step` reject 语义）均已用临时测试网关实测通过。

---

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `package.json` | ESM 包声明、`exports`、`dsh.bundle.patch`、`engines.dsh`、peer/dev 依赖分离 |
| `cordis.patch.yml` | bundle 层：`- insert: [{ id: link-resolver, name, config }]` |
| `tsconfig.json` | NodeNext + strict + `verbatimModuleSyntax`，`src/` → `lib/` |
| `src/index.ts` | Cordis 入口：`name` / `inject` / `Config` / `apply`，全部资源经 `ctx.effect` |
| `src/adapter/config.ts` | schemastery 配置 Schema（13 项） |
| `src/adapter/tool.ts` | `resolve_link`：`defineTool` + 参数 DSL + `output.schema` + `output.render` |
| `src/core/registry.ts` | 平台注册表（7 平台，含识别正则与主机名） |
| `src/core/url.ts` | 链接规范化 / 文本抽取 / 主机名解析 |
| `test/p0-smoke.test.js` | 8 例：导出形态、开关、工具契约、识别、边界 |
| `README.md` / `CHANGELOG.md` / `LICENSE` | 安装与配置说明、变更记录、AGPL-3.0 全文 |
| `lib/` | 构建产物（10 个文件，含 `.d.ts`） |

包清单：14 个文件（`npm pack --dry-run`），含 `cordis.patch.yml` 与 `lib/**`。

---

## 2. 验证矩阵

| # | 验证项 | 命令 | 结果 |
| --- | --- | --- | --- |
| V1 | 类型检查 | `tsc -p tsconfig.json --noEmit` | ✅ 通过 |
| V2 | 构建 | `pnpm build` | ✅ 生成 `lib/index.js` + `.d.ts` |
| V3 | 冒烟测试 | `node --test test/p0-smoke.test.js` | ✅ 8/8 通过 |
| V4 | 打包清单 | `npm pack --dry-run` | ✅ 14 文件，含 `cordis.patch.yml` |
| V5 | 本地安装 | `dsh plugin --profile p0 add link:<abs>` | ✅ 成功，且自动登记 `dsh.profile.bundles` |
| V6 | 组合树 | `dsh --profile p0 --dump-config` | ✅ 条目出现，config 原样保留 |
| V7 | 模块导入 + Config | `dsh --profile p0 --dump-config-schema` | ✅ 输出含 `resolveTimeoutMs` / `maxConcurrent` / `enabledPlatforms` |
| V8 | 运行时挂载 | `dsh p0 --json "<task>"` | ✅ 启动至模型调用，未出现插件加载错误 |
| V9 | 真实 LLM 工具调用 | `dsh p0 --json "请调用 resolve_link ..."` | ✅ **模型真实调用工具，结果原样渲染**（见 §2.1） |
| V10 | `agent/pre-step` reject 语义 | 探针插件 + 标记消息 | ✅ **已实测**：turn 以 `blocked` 结束，模型零调用（见 §2.2） |

### 2.1 V9 实测证据（测试网关）

关闭凭据限制后，用临时测试网关（`openai-completions` 协议）跑了一次真实 headless turn。事件序列（截取）：

```json
{"type":"tool_call","callId":"call_00_ET_...","tool":"resolve_link","input":{"url":"https://www.bilibili.com/video/BV1xx411c7mD"}}
{"type":"tool_result","status":"completed","result":"B站 链接已识别\n- 平台：bilibili\n- 内容 id：BV1xx411c7mD\n- 链接：https://www.bilibili.com/video/BV1xx411c7mD\n- 状态：已识别平台，解析器尚未接入（P0 骨架阶段）"}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":5860,"outputTokens":55}}
{"type":"text","text":"平台是 **bilibili（B站）**，内容 id 为 **BV1xx411c7mD**。……"}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
```

要点：① 工具描述足以让模型在无提示词工程的情况下选择该工具；② `output.render` 的文本被原样送入模型上下文；③ 最终回答正确引用了工具结果。**V9 通过。**

### 2.2 V10 实测结论：`agent/pre-step` 返回 `reject` 会发生什么

用一个探针插件（监听 `session/event` / `agent/inbox/*` / `agent/pre-step`）对带 `REJECT_TEST` 标记的消息返回 `{ kind: 'reject' }`：

| 观测点 | 结果 |
| --- | --- |
| 模型是否被调用 | **否**：没有 `step_start`、没有 usage、没有 `assistant/message` |
| turn 结束状态 | `turn_end.reason = "blocked"`（headless 进程退出码 1，`final.text` 为空） |
| 用户消息去向 | `inbox/inserted` → `inbox/claimed` 后被消费；**没有** `inbox/discarded`，也不会重排到下一轮 |
| 对照组（无标记） | 正常 `completed`，探针的 `next()` 未干扰流程 |

**结论**：`reject` 是一条真正的「零 LLM」拦截通道——但它同时意味着**本轮不会产生任何回答**。因此 `autoPush` 模式必须在 reject 之前自行完成投递（`ctx.dshIm.send`），否则用户看到的是彻底静默，且 headless/自动化调用方会收到 `blocked` 失败态。

这也回答了一个架构问题：零 LLM 模式不是"省一次模型调用"，而是"由插件完全接管这一轮"，责任与风险都在插件侧。

### V5–V7 细节

安装后 profile 清单被自动改写：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-plugin-link-resolver"] } }
```

V7 是关键证据：`--dump-config-schema` 会**导入插件模块**读取 `Config`。我们的 `lib/index.js` 在模块顶层 `import { defineTool } from '@deepseek-ai/dsh-tools'`，而测试 profile 的 `node_modules` 中并无该包——它能成功导入，说明 DSH 的加载器会为 `@deepseek-ai/*` 提供别名解析（与 `dsh-free-search` 等第三方插件完全同构）。

---

## 3. 环境限制（如实记录）

| 限制 | 影响 | 绕过方式 |
| --- | --- | --- |
| `~/.dsh` 与全局 pnpm store 在 sandbox 下只读 | 不能把插件装进正在使用的 `web` profile | 用 `DSH_HOME=<工作区>/.tmp-dsh-home` 建独立 profile（已验证可行） |
| 该独立 home 无模型凭据 | 已用一次性测试网关关闭（`openai-completions` 协议 + 临时 profile patch 层，密钥仅经环境变量注入，未落盘、未入库） | — |
| 本机无 `ffmpeg` / `yt-dlp` | 相关平台（P2/P3）集成测试将标「环境受限」 | 安装后重跑，或在 Docker 中验证 |

`pnpm add link:` 会提示 peerDependencies 不从目标 node_modules 解析——这是 link 安装的预期行为，运行时由 DSH 别名接管，**不是缺陷**。

---

## 4. 与参考实现的对应

| 参考实现 | P0 对应 | 说明 |
| --- | --- | --- |
| `core/registry.py` | `src/core/registry.ts` | 同样的「单一注册表」职责；Python 内联 `(?s)` 标志改为 JS 字面量 flag，`(?P<x>)` 改为 `(?<x>)` |
| `main.py` 七个 `@filter.regex` | 未实现 | 由模式 B（L1/L2）替代，P1 接线 |
| `event.send` / 合并转发 | 未实现 | 改为工具结果 + `present` / `dsh_im_return_file` |
| `_conf_schema.json`（50 键） | `Config`（13 键） | 只保留真正生效的项；三个死配置键（`video_codecs` / `allow_hdr` / `allow_dolby`）未继承 |
| `_download_stream` | 未实现 | P1 `media/download.ts`，补总超时与并发上限 |
| 各平台 handler | 未实现 | P1–P3 |

---

## 5. 已知偏差与修正

- **工具参数形态**：`defineTool` 会把参数 DSL 编译成 JSON Schema（`{ type:'object', properties, required[] }`），不是原样保留 `parameters.url.type`。测试据此断言，避免后续误用。
- **执行返回**：`execute` 必须是 Promise（首个版本同步返回被类型系统拒绝），已改为 `async`。
- **`inject` 收敛**：只硬依赖 `tools`；`systemPrompt` 走可选 `ctx.inject([...])`，缺失时静默跳过（headless/SDK 组合下可能不存在）。

---

## 6. 下一步（P1）

1. `core/result.ts` 统一模型与错误码；`core/http.ts`（超时 / 重试 / SSRF 守卫 / 并发令牌桶）。
2. 四个低风险解析器：X（fxtwitter）、小红书（`__INITIAL_STATE__`）、微博（`ajax/statuses/show` + 访客 Cookie）、抖音免签路径。
3. 模式 B L2 接线（`agent/inbox/inserted` → `agent.inject`）与会话级去重 projection。
4. ~~补齐 V9 与 V10 两项验证~~ —— 已于本次完成（见 §2.1 / §2.2）；正式开发中的回归验证可复用同一 profile 与 patch 层。

---

## 7. 对架构决策的影响（V10 的直接结论）

`autoPush`（零 LLM 模式）从"待验证"升为"机制成立，待产品决策"：

- **成立**：`pre-step` 返回 `reject` 能完全跳过模型，且不影响下一轮。
- **代价**：该 turn 以 `blocked` 结束、无任何回答文本，自动化调用方会看到失败态。因此插件必须在 reject 之前完成 `ctx.dshIm.send()`；投递失败时应改为 `next()` 放行，让模型兜底。
- **建议**：`autoPush` 实现为「解析 → 投递成功 → reject；投递失败 → 放行」的短路逻辑，且默认关闭。

---

## 附录：本次使用的验证命令

```bash
# 构建与测试
pnpm install --store-dir ./.tmp-pnpm-store
pnpm build && pnpm typecheck
node --test test/*.test.js
npm pack --dry-run

# 隔离 profile 安装与验真
export DSH_HOME="$(pwd)/../.tmp-dsh-home"
dsh p0 --from-default-profile headless --dump-config
dsh plugin --profile p0 add link:/home/astral/workspace/DevLab/link-resolver/dsh-link-resolver \
  --store-dir /home/astral/workspace/DevLab/link-resolver/dsh-link-resolver/.tmp-pnpm-store
dsh --profile p0 --dump-config | grep -A14 'id: link-resolver'
dsh --profile p0 --dump-config-schema | grep -o 'resolveTimeoutMs\|maxConcurrent\|enabledPlatforms'
```