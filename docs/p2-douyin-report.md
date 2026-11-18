# P2（提前批次）报告：抖音 a_bogus 签名

- 日期：2026-11-17
- 版本：`0.2.0`
- 背景：原计划 P2 为 B站；因实际使用场景以抖音为主，经确认将抖音签名提前，B站顺延。
- 结论：**抖音签名链路已打通并完成真实链接端到端验证**。

---

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `src/sign/abogus.ts` | a_bogus 完整移植：SM3（`node:crypto`）、RC4、自定义 Base64、`big_array` 置换、浏览器指纹、时间戳分片 |
| `src/sign/websign.ts` | WebSign：`x-secsdk-web-signature`（MD5 + 固定盐），含 Python `quote` 语义的转义实现 |
| `src/resolvers/douyin-guest.ts` | 游客身份（`ttwid` + `UIFID_TEMP`）+ 签名详情接口 + 会话刷新 |
| `src/resolvers/douyin.ts` | 三级回退：`iteminfo` → 分享页 `_ROUTER_DATA` → 签名 `aweme/detail` |
| `test/fixtures/abogus-vectors.json` | 3 组黄金向量（GET ×2、POST ×1） |
| `test/fixtures/websign-vectors.json` | 2 组黄金向量 |
| `test/sign.test.js` | 2 例：a_bogus 与 WebSign 逐字节比对 |
| `scripts/gen-abogus-vectors.py` | 可复现的向量生成脚本（直接调用参考 Python 实现） |

---

## 2. 算法移植方式

1. **不重写语义**：逐函数对照 `core/douyin/abogus.py`（877 行）移植，魔法常量（256 项 `big_array`、两张 Base64 字符表、排序表）原样保留。
2. **SM3 用 Node 原生**：`crypto.createHash('sm3')`，无需 JS 实现；已用标准向量 `66c7f0f4…` 校验。
3. **黄金向量锁定**：Python 侧缺少 `gmssl` 且无 pip，因此实现了纯 Python SM3 垫片（与 Node 原生 SM3 在 3 组输入上完全一致），再直接加载原版 `abogus.py` 生成向量；TS 侧 3/3 逐字节匹配。
4. **可测试性**：`ABogus` 支持注入 `now()` 与 `randomPrefix()`，因此黄金向量可复现；生产路径仍使用真实时间与随机前缀。

### 向量对照结果

```
get-basic   OK
get-second  OK
post-body   OK
3/3 matched
```

---

## 3. 真实链路验证

链接：`https://v.douyin.com/CVHmFXGPfHc/`

| 步骤 | 结果 |
| --- | --- |
| 短链展开 | ✅ → `iesdouyin.com/share/video/7708744445503573289` |
| `iteminfo` | 空响应（平台已收紧） |
| 分享页 SSR | 无 `videoInfoRes` |
| 游客身份 | ✅ `ttwid` + `UIFID_TEMP`（来自 `live.douyin.com`） |
| 签名详情接口 | ✅ 返回 `aweme_detail` |
| 解析结果 | 标题《本来就掉毛多…》/ 作者「好运爆棚」/ 10 秒 / 1 个视频直链 |
| DSH 端到端 | ✅ 模型调用 `resolve_link` → 结果进入回答 |

---

## 4. 设计说明与限制

- **会话复用**：游客身份缓存 30 分钟；失败时自动刷新一次。
- **指纹随机**：每次请求生成新的浏览器指纹，符合参考实现行为。
- **风控边界**：高频请求仍可能触发平台风控；错误以 `parse-failed` / `auth-required` 结构化返回，不伪造结果。
- **不绕过访问控制**：仅读取公开作品；私密/登录态内容会明确失败。

---

## 5. 下一步

1. B站（原 P2）：WBI 签名、DASH 流选择、画质降级、音视频合并。
2. `media/download.ts` + `media/ffmpeg.ts`：媒体落盘与合并（抖音当前只返回直链，不下载）。
3. YouTube / 通用站点（P3）。
