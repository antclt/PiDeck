# 远端并入 dev：合并方案与前置清单

> 状态：**已执行 FF（2026-10-26 18:0x），未提交、未推送**。基线 `dev` = `3bf7b0ff8` → `fc377eaff`，目标 `origin/integration/dev-sync`（2026-10-26 17:03）已并入。
> 落地形状见 §0；执行记录与门禁结果见 §5。

## 0. 合并形状

- `git merge-base dev origin/integration/dev-sync` = `3bf7b0ff8` = dev 的 HEAD；ahead/behind = **0 / 225**。
- 因此 `git merge --ff-only` 即落地：**0 冲突文件、0 hunk、不产生 merge commit**。
- 体量：653 文件 / +115,167 / −3,068（461 新增、192 修改）；生产代码 302 文件 +43,018/−2,386（不含 i18n），i18n 5 文件 +1,685；tests 290 / e2e 23 / docs 21 / scripts 8 / spikes 3。
- `package.json`、`package-lock.json`、`resources/` **零改动**（无新依赖、无打包资源变更），版本仍 0.9.7。
- 192 个被修改的既有文件里，remote/ssh 命名的 **0 个**——远端代码是纯新增，侵入全部落在共享汇聚点（`SessionCatalog` +1,072、`AgentManager` +731、`main/index.ts` +651、`ProjectStore` +489、`sessionIpc` +428、`gitIpc` +356、`preload` +203、`shared/ipc.ts` +126）。

## 1. 合并前必须先处理（都在分支侧，不是解冲突）

### 1.1 `AGENTS.md` 在分支上是两份（阻断项）

- 证据：dev 的 `AGENTS.md` = **6,790 B**；分支的 = **13,570 B**（≈ 同一份贴了两遍，标题 `# AGENTS.md`、`## 铁律`、`## 改动前先读`、`## 协作` 各出现两次）。
- 引入点：`ff462c1a6`（2026-10-26「追上 origin/dev 最后 5 个提交（AGENTS.md 拆分）」）——该提交 ours = 45,339 B（分支旧长版）、theirs = 6,790 B（dev 拆分版），结果落了 13,570 B。
- 修法（FF 之后一个独立 commit；或先在 `integration/dev-sync` 修再 FF）：

```bash
git checkout 3bf7b0ff8 -- AGENTS.md
git diff --stat 3bf7b0ff8 -- AGENTS.md    # 必须为空
```

- 不要手工逐段合并：分支对 `AGENTS.md` 没有独立增量，dev 版就是最终态。
- 验证：`grep -c '^# AGENTS.md' AGENTS.md` = 1；`grep -c '^## 铁律' AGENTS.md` = 1。

### 1.2 远端开关：合并即全量开启

`src/main/index.ts:3205`：

```ts
const remoteExperimentEnabled = true;   // 2026-10-19 集成分支策略：任何构建都开
```

| 选项 | 要改什么 | 合并当天风险 | 发版风险 | 工时 |
|---|---|---|---|---|
| **A 保持恒开**（推荐用于合并提交） | 0 行代码，只对齐文档口径 | 最低：零代码 diff | 正式包带远端入口；macOS 无证据、无人工安全签字 | 0.5 天（文档） |
| **B 恢复分档**（stable 恒关 / dev 品牌或 env 开） | 恢复 `resolveRemoteExperimentEnabled()` 纯函数与 `isDevBrandBuild()`（分支已删），改 `tests/remoteHostIpc.test.mjs:38-39` | 中：引入新代码路径，需重跑 host/trust 域 | 最低 | 0.5–1 天 |
| **C 单行可配**（默认关，env 开） | 1 行 + 1 条测试 + 3 份 i18n 文案 | 低：1 行 diff + 针对性测试 | 低 | 1–2 小时 |

- 推荐：**合并提交用 A（零代码 diff），随后独立 commit 补 C**。FF 合并不该夹带行为变更——否则「合并出问题」和「开关出问题」无法归因。
- **决议（2026-10-27，用户裁定）：远端能力只在 dev 通道提供，正式包不启用也不提及。** 落地形态取 B/C 的语义但复用已有判据，不新写纯函数：`src/main/index.ts` 的开关改为

```ts
const remoteExperimentEnabled = isDevChannelBuild();   // 未打包运行 / dev 通道包为 true，release 产物为 false
```

  即「未打包运行（npm run dev / E2E）与 dev 通道安装包开，stable 通道安装包关」；渲染层按同一判据（`app:get-channel` 的 `devBuild`，见 `hooks/useRemoteFeatureAvailable.ts`）连入口都不渲染（侧栏「+ → 远端（SSH）…」与设置「连接」tab）。`docs/remote-merge-to-dev-plan.md` 原表列的 A「恒开」因此作废。
- 关掉不会白屏：未启用时所有 host IPC 统一返回 `REMOTE_FEATURE_DISABLED`，renderer 每处都有文案（`ConnectionsTab.tsx:50-51`、`AddHostDialog.tsx:53`、`RemoteProjectTrustPanel.tsx:43`、`RemoteProjectEnrollDialog.tsx:46`、`RemoteGitPanel.tsx:80`）。
- 两个约束：`tests/remoteHostIpc.test.mjs:39` 显式禁止把开关重新耦合到 `app.isPackaged` / `PIDECK_REMOTE_EXPERIMENTAL`（2026-10-27 已按「策略变更」改写为断言 `isDevChannelBuild()` 接线，不是放宽断言）；`e2e/remote-fixtures.ts:158` 仍在给子进程注入 `PIDECK_REMOTE_EXPERIMENTAL=1`（现为无害 no-op）。
- `sidebar.remoteEnroll.featureDisabled` 文案已改成新口径（不再让用户去设一个没人读的变量），zh-TW 为生成物（`node scripts/genZhTwCopy.mjs`）。

### 1.3 门禁台账与代码不一致（6 份文档 10 处）

| 文件:行 | 现文 | 事实 / 处置 |
|---|---|---|
| `docs/remote-release-gate-status.md:20` | 「packaged 仍被 `!app.isPackaged && PIDECK_REMOTE_EXPERIMENTAL=1` 挡住，待产品决定」 | 已是恒开 → **改** |
| `docs/remote-night-summary.md:34,47` | 同上 | 同上 → **改**（或整篇标「2026-10-18 快照」） |
| `docs/remote-development-handoff.md:29,328,331,811` | 同上 | 同上 → **改** |
| `docs/remote-development-plan.md:776`、`docs/remote-file-management-plan.md:67` | 计划期口径 | 计划文档 → **加一行 banner**，不改正文 |
| `docs/remote-security-review.md:439`、`docs/remote-security-review-round2.md:361` | 审查时的门禁描述 | 审查证据 → **不改**，加 banner「写于门禁变更前」 |

原则：账本 / 交接（描述当前状态）必须改；计划 / 审查（历史证据）加 banner 不改正文。

## 2. 执行顺序

```bash
# 0) 前置：工作树干净、无并行 writer
git status -sb

# 1) fast-forward（不产生 merge commit）
git checkout dev
git merge --ff-only origin/integration/dev-sync

# 2) AGENTS.md 去重（首个 commit）
git checkout 3bf7b0ff8 -- AGENTS.md && git diff --stat 3bf7b0ff8 -- AGENTS.md

# 3) 门禁（全绿才 push）
npm run typecheck
npm run check:format
npm run check:ipc-wiring
npm run check:test-shape
npm run test:serial          # 14,164 例；预期 20 红 / 12 个既有红灯文件，先冻结名单
npx playwright test e2e/remoteHostAcceptance.spec.ts e2e/remoteSessionAcceptance.spec.ts
```

真机 e2e 需要：已授权 Linux 主机 + 独立核验的 ED25519 指纹（`PIDECK_E2E_REMOTE_HOST/USER/FINGERPRINT`）。历史用 10.81.2.15；macOS 无机器跑不了。

## 3. 合并后

- 归档 `integration/dev-sync`（FF 后与 dev 同 commit），避免再长出第二条线。
- 处理 `spikes/remote-phase0`（3 文件）与 `docs/remote-integration-notes.md`（文件头自称「收尾后删除」）。
- 若采纳 §1.2 的 C，紧接一个独立 commit。
- 发布门禁仍缺：macOS 客户端证据、独立人工 reviewer 签字、打包版人工 smoke、Linux 长稳 soak。

## 4. 回退

FF 之后回退 = revert commit 或 reset。10-19 已经做过一次「FF 到集成分支再回退」，所以开关口径（§1.2）要在合并前定，不要指望合并后再收。

## 5. 执行记录（2026-10-26）

| 项 | 结果 |
|---|---|
| FF 合并 | `git merge --ff-only origin/integration/dev-sync` → exit 0；dev `3bf7b0ff8` → `fc377eaff`，领先 `origin/dev` **225** 提交；0 冲突 |
| `AGENTS.md` 去重 | `git restore --source=3bf7b0ff8 --worktree -- AGENTS.md` → `-61` 行，与 `3bf7b0ff8` 字节一致；**仅工作树改动，未 stage** |
| `npm run typecheck` | **0** |
| `npm run check:format` | **0**（3,895 文件） |
| `npm run check:ipc-wiring` | **ok**：769 通道 / 8 agentEventTags，无重复 |
| `npm run check:test-shape` | **ok**：390 / 1,645 文件，新增 0 |
| `npm run test:serial` | 14,140 例 / **13,810 pass / 44 fail** / 286 skip（1,350 s）。44 条 = 台账既有红灯 **23** 条（11 个文件）+ **21** 条本机环境（`EPERM: symlink`，无符号链接权限：`remoteHelperEntry` 14、`remoteWorkspaceEndToEnd` 6、`remoteSearchIsolation` 1）。**零合并引入** |
| 提交 | `AGENTS.md` 去重 + 本文件，同一 commit |
| 推送 | `git push origin dev`（226 提交） |

注：本机跑门禁需先清 `NODE_OPTIONS`（agent 运行时注入了指向 `D:\\project\\pideck\\resources\\app.asar\\out\\main\\runnerConsolePreload.js` 的 preload，会以 MODULE_NOT_FOUND 让所有 node 命令失败）：

```powershell
$env:NODE_OPTIONS=""; $env:ELECTRON_RUN_AS_NODE=""
```

## 6. 测试清账（2026-10-26 晚）

合并后第一轮全量串行：**13,810 pass / 44 fail / 286 skip**。44 条全部归因并修完，第二轮：**13,848 pass / 0 fail / 316 skip**（14,164 例，21.3 min，exit 0）。skip +30 是新增的平台能力守卫（POSIX / 开发者模式 Windows 上仍会跑）。

| 类别 | 条数 | 修法 | 文件 |
|---|---:|---|---|
| 测试初始化缺口 | 8 | `SessionCatalog` 新增 `shared/projectLocation` 导入，vm 沙箱未放行 → 在同款沙箱里转译加载**真实**契约模块 | sessionCatalogCommand |
| 平台能力（文件符号链接需管理员/开发者模式） | 21 | 新增 `tests/helpers/symlinkSupport.mjs` 探针；夹具用例改 `link*` 包装器带 skip 理由 | remoteHelperEntry(13)、remoteWorkspaceEndToEnd(6)、remoteSearchIsolation(1)、remoteHelperSearchNames(4) |
| 源码重构跟随 | 2 | porcelain 解析迁到 `gitStatusParser.ts` → 断言目标跟随（正则不变） | fileIcons |
| 夹具形状 | 2 | 真实子进程不能复用 cmd-shim 的 `windowsVerbatimArguments: true`；`mkdir` 二进制换 `mkdirSync` | piRuntimeLauncher、remoteBrowseRoot |
| 平台门禁缺失 | 6 | 补齐同文件既有守卫：POSIX-only 探针/runner、Linux-only 远端命令、win32 下 POSIX deployRoot | sshClientRuntime、remoteRunnerEntry、remoteProjectFileService、remoteGitRecovery、remoteBootstrapSessionIntegration、remoteBrowseRoot |
| 协议 pin 过期 | 2 | helper 1.6.0 → 1.21.2：SHA、版本、builtins(3)、能力表(30) 同步；digest 仍双重校验 | remoteSessionRootIsolation |
| 契约快照过期 | 1 | 能力表改「契约 == 冻结 body 自声明」双向精确 parity（字面量 pin 保留在上一行文件） | remoteHelperSearchNames |

纪律：**未改任何 `src/` 生产代码**，未放宽断言、未删用例；无法在本机复现能力的用例显式 skip 并写明理由。

