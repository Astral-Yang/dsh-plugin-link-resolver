# 发布检查清单（Release Checklist）

- 包名：`dsh-plugin-link-resolver`
- 版本：`1.0.0-rc.19`
- 日期：2026-11-18（真机验收通过，同日）

## 一、代码与构建

- [x] TypeScript 类型检查（`tsc --noEmit`）
- [x] 生产构建（`pnpm build` → `lib/`）
- [x] 单元测试 43/43（`node --test test/*.test.js`）
- [x] 黄金向量：a_bogus 3/3、WebSign 2/2 与参考实现一致
- [x] 无 Python 运行时依赖（仅开发期向量生成使用）
- [x] 无未声明的全局 npm 依赖

## 二、npm 包内容

- [x] `package.json`：`name` / `version` / `description` / `license` / `engines` / `main` / `exports` / `files` / `dsh.bundle`
- [x] `lib/**` 预构建产物（含 `.d.ts`）
- [x] `cordis.patch.yml`
- [x] `README.md` / `CHANGELOG.md` / `LICENSE`
- [x] `docs/**`（可行性、P0–P3 报告、测试报告）
- [x] `npm pack --dry-run` 清单核对（70 文件）
- [x] 包体积：约 130 kB（unpacked 约 394 kB）

## 三、安装与加载验收

- [x] 干净 profile 安装 tarball（仅 1 个包，无 peer 重复）
- [x] `dsh.profile.bundles` 自动登记
- [x] `--dump-config` 出现 `link-resolver` 条目
- [x] `--dump-config-schema` 读取到插件 Config
- [x] 单链路 pre-step：headless 实跑「链接 → 下载 → 交付 → 注入 → completed」
- [x] 卸载后 bundles / node_modules / 配置条目均清理
- [x] 真实 IM 轮次复验（`dsh_im_return_file` 登记 + 微信渠道收到文件）
- [x] 真实 Web 轮次复验（`present` 文件卡片）

## 四、许可证与合规

- [x] `LICENSE` 为 AGPL-3.0 全文
- [x] `package.json` `license: AGPL-3.0-only`
- [x] README 注明上游项目与作者
- [ ] 发布仓库地址（`repository` 字段）待确定后补充
- [x] 无真实 Cookie / Token / 内网地址进入仓库（已扫描）

## 五、外部工具

- [x] `ffmpeg` / `ffprobe` 探测与版本输出
- [x] `yt-dlp` 探测与版本输出（2025.04.30，建议升级）
- [x] 缺失时明确报错（`tool-missing`），不自动安装
- [x] 配置支持 `ffmpegPath` / `ytdlpPath`

## 六、待人工执行（需授权）

- [ ] `npm publish`（当前 registry 上包名可用）
- [ ] 创建 GitHub Release / 推送 tag
- [ ] 在目标 profile（如 `web`）安装并做交互验收

## 七、已知限制（发布说明需保留）

- 通用站点仅白名单域名；未做全站覆盖。
- B站未登录最高 480P；抖音签名受平台风控影响。
- 卡片渲染暂缓（纯文本摘要）。
- 媒体交付依赖 `present`（Web）或 `dsh_im_return_file`（IM），插件不直接推送。

## 八、安装命令（供验收）

```bash
# 使用本地 tarball
dsh plugin --profile <profile> add /home/astral/workspace/DevLab/link-resolver/dsh-link-resolver/dsh-plugin-link-resolver-1.0.0-rc.19.tgz

# 卸载
dsh plugin --profile <profile> remove dsh-plugin-link-resolver
```
