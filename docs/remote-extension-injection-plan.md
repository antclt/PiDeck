# 远端内置扩展注入（P4.4 扩展面）实施计划

> 状态：**S1 + S2 已实施，真机验收通过（2026-10-19）**。用户拍板：交付走 B=独立内容寻址快照；第一批 core8 + security-gate；远端 pi 版本门槛 1.x。
> 本文是「公共契约变化」的 Implementation Plan：runner 初始化帧新增可选 `env`、bootstrap entry argv 新增 target、`-e` 注入面新增 allowlist。
> 证据：`node scripts/verify-remote-extensions.mjs <host> <user> <fingerprint> [--with-prompt]` 对真机 `serve`（pi 1.3.0）全绿——
> `SNAPSHOT_DEPLOYED` / `SNAPSHOT_VERIFIED`（26 文件 + sha 抽查）/ `SECURITY_ARTIFACT_OK`（0600 + sha）/
> `PROBE_ENV_OK`（runner env 合并 + 9 条 `-e` 路径存在）/ `REMOTE_COMMANDS_OK`（todo/plan/goal）/ `PLAN_MARKER_STRIPPED`（真实模型一轮，标记未进会话文件）/ `EXTENSIONS_E2E_OK`。
> 未做（S3）：vision（vendored undici 子目录）、bridge/model-trace（需 SSH 反向隧道）、trash-guard（远端回收站语义待产品定）。
> 相关：`docs/remote-development-plan.md` §8.6、`docs/remote-phase4-plan.md` P4.4、`docs/remote-release-gate-status.md` 第 7 行「内置扩展」。

## 0. 结论摘要

- **交付**：PiDeck 把「本机当前生效的内置扩展快照」（overlay 优先，逐文件 sha256 校验）上传到远端
  `<deployRoot>/extensions/<bundleSha256>/`，与 helper/runner 的 `bundles/` 同根、不同目录、不同锁；
  复用已审计的 bootstrap entry/finalize 逻辑（新增一个封闭 target token），不新写第二套部署器。
- **注入**：按 `REMOTE_EXTENSION_MIRROR` 白名单逐文件 `--extension <绝对路径>` 注入；**不用** `-e <dir>`
  （pi 会递归把 `pi-deck-todo-state.ts`、`pi-deck-gui-bridge-*.ts` 当扩展加载），也不写聚合入口
  （会把多个扩展合并成同一个 extension 身份，语义变形）。
- **门槛**：仅当远端 `pi ≥ 1.0.0` 才注入；0.85–0.99 的主机行为**与本轮之前逐字一致**（无扩展），
  UI 明确显示不可用原因。
- **安全面**：security-gate 需要 `PIDECK_SECURITY_CONFIG` + `PIDECK_SESSION_ID`；ssh 的 `SetEnv/SendEnv`
  被 sshd `AcceptEnv` 挡掉，所以走 **runner 1.1.0 的 init 帧 `env`（仅允许 `PIDECK_` 前缀）**。
  策略快照写到 `<deployRoot>/security-policy.json`（0600，原子写），等级变更时对活跃远端会话热重推。
- **失败语义**：快照部署失败 / 扩展加载失败 / 版本不够 ⇒ 降级为「无扩展」并如实告知，**绝不阻塞会话**。

## 1. 目标与不变量

目标：远端 pi 会话里，PiDeck 内置扩展的**有效集合**与本机一致（除明确 local-only 的），从而让
plan/goal、todo、ask_question、自动标题、subagents、稳定性修复、安全等级在远端真正生效。

不变量（全部 fail-closed）：

1. 远端 plan 内**不出现任何本机路径**；扩展路径由 `<deployRoot>/extensions/<sha>/<basename>` 拼出，
   每个路径过 `assertRemoteAbsolutePath`。
2. 远端只执行**逐文件 sha256 与本地生效快照一致**的字节；快照目录 0700、文件 0600、内容寻址不可变，
   已存在的同名目录必须重新校验一致，否则拒绝激活。
3. `-e` 只来自 `REMOTE_EXTENSION_MIRROR` 的 `remote`/`remote-needs-env` 条目，顺序与
   `BUILT_IN_EXTENSIONS` 一致；hidden / 默认关闭 / 用户 removed / `piRpcNoExtensions` 一律不注入。
4. runner env 只接受 `PIDECK_` 前缀；`PATH`/`HOME`/`NODE_OPTIONS`/代理变量等一律拒绝。
5. argv 预算：`node + pi + pi 参数 ≤ 32`（pi 参数 ≤ 30）。core8+security = 9 条 `-e` = 18 参数，
   加基础/会话/trust 最坏 8 ⇒ 26，留 4 个余量；超限在 plan 构造点抛 `REMOTE_RUNTIME_ARGS_TOO_MANY`。
6. 快照上传/校验失败不改变会话可用性：不带 `-e` 起会话，原因进 agent state 与诊断日志。
7. 远端 pi < 1.0.0：不注入、不上传快照、不显示 plan/goal/安全等级。

## 2. 关键决策与理由

### D1 交付：独立内容寻址快照（B），复用 bootstrap entry 的 target 参数

| 备选 | 否掉的理由 |
| --- | --- |
| 并入 helper/runner 的 deploy bundle（扁平） | 扩展一改就改变**已审计的 helper bundle 身份**；bundle 校验要求目录文件集与声明完全一致且只能扁平，vendored `undici`（1.6MB/176 文件、需要子目录）装不下 |
| 新写一个 extensions-sync 冻结脚本 | 要把 staging/锁/逐文件 sha/强制 mode/原子 rename/幂等复验整套安全不变量抄一遍，重复代码比「给现有 entry 加一个封闭 target」风险更大 |
| 写进项目 `.pideck/` | 污染项目、信任与清理语义全错 |

因此：`REMOTE_BOOTSTRAP_INLINE_ENTRY` argv 增加第 5 个 token `target ∈ {"helper","extensions"}`。
`deployRoot` 不变（`HOME/.pideck/remote-host`），目录与锁按 target 派生：

| target | 内容目录 | staging 前缀 | 锁 |
| --- | --- | --- | --- |
| helper（现状） | `bundles/<sha>` | `.staging-` | `.deploy.lock` |
| extensions（新） | `extensions/<sha>` | `.staging-ext-` | `.deploy-ext.lock` |

`deployedRunnerPath` 继续只认 `./bundles/<sha>`；扩展路径只认 `./extensions/<sha>`，两者互不串。

### D2 注入：逐文件 `-e`，不进目录、不聚合

pi 的发现规则（1.3.0 源码核对）：`-e <dir>` 有 `index.ts`/`package.json` 时只加载入口，否则**递归加载目录内全部
`.ts/.js`**；无合法 default export 会记一条扩展加载错误。所以目录注入会把 `pi-deck-todo-state.ts`
等辅助模块当扩展加载。聚合入口（`index.ts` 里 import 各 factory 再依次调用）虽只占 1 个参数，但把所有扩展
合并进同一个 extension 身份（工具/命令/条目归属、错误隔离、`pi.on` 生命周期全变），为省 18 个参数不值得。

### D3 env：runner 1.1.0 init 帧可选 `env`（仅 `PIDECK_`）

- ssh `SetEnv`/`SendEnv` 受服务端 `AcceptEnv` 限制（默认只放 LANG/LC_*），不可用；
- 命令行塞 env 违反「remote command 不含用户文本/环境」；
- 让扩展改成读固定路径约定，要改共享的本地扩展代码，比协议加一个字段更贵。

字段形状：`env?: { [key]: string }`，键 `^PIDECK_[A-Z0-9_]{1,64}$`，≤32 项，值 ≤4096、无 NUL/CR/LF；
spawn 用 `env: { ...process.env, ...frame.env }`。runner 版本 1.0.0 → 1.1.0，冻结 sha 与契约测试同批更新。

### D4 版本门槛：远端 `pi ≥ 1.0.0` 才注入

0.85 是远端会话下限（D4 历史决策），但扩展按 1.x 事件面编写；在 0.85 上「加载成功但事件不触发」是最难查的
坏形态。门槛用现有 `piVersionAtLeast(version, "1.0.0")`，未知版本按不支持处理。真机验证目标 1.3.x；
1.0–1.2 标注「未核验」。

### D5 配置：布尔型设置用「注入与否」表达，不额外加 env

- `autoSessionTitle=false` ⇒ 不注入 `pi-deck-session-title.ts`（扩展缺省是开启，所以必须靠不注入表达）；
- 飞书绑定是本地专属（远端会话不会绑定），`PIDECK_FEISHU_LINKED` 不传；
- `PIDECK_TRASH_GUARD`/`PIDECK_VISION_CONFIG_DIR`/`PIDECK_PI_PROXY_SCOPE` 本期不涉及。

## 3. 数据流

```
本机：resources/extensions 或 userData/builtin-extensions(overlay)
  └─ readVerifiedArtifact() 整份校验 → 有效快照 { files: [{name,bytes,sha256}], dir }
       └─ deployExtensionSnapshot(target=extensions)              [pinned scp + NDJSON finalize]
            └─ 远端 <deployRoot>/extensions/<sha>/（0700/0600，内容寻址不可变）

会话 spawn：
  remotePiRuntimeFacts(hostId) → { nodePath, piPath, version, runnerPath }
  ensureExtensionSnapshot(hostId) → { sha, root }（按 held session 缓存，幂等）
  listRemoteInjectableNames(settings, version) → 9 个 basename
  buildRemotePiRuntimePlan({ ..., extensions, env })
    → args += ["--extension", root+"/"+name] * 9
    → env = { PIDECK_SECURITY_CONFIG, PIDECK_SESSION_ID, PIDECK_AUTO_SESSION_TITLE? }
  SshPiRuntimeLauncher 写 init 帧 {v:1,op:"start",nonce,cwd,argv,env}
    → runner 1.1.0 合并 env → spawn pi --mode rpc ...
```

## 4. 契约变更清单

| # | 契约 | 变化 |
| --- | --- | --- |
| C1 | bootstrap entry argv | `--pideck-bootstrap-inline-v1 <protocol> <sha> <nonce> <target>`；target 闭集，其他形状 `BOOTSTRAP_INPUT_INVALID` |
| C2 | bootstrap `finalized.active` | `./<dir>/<sha>`，dir ∈ {bundles, extensions}；main 侧按 target 校验 |
| C3 | bundle maintenance sweep | 增加 `extensions/` 与 `activeExtensionSha`；保留 active + 1 份 rollback，其余按既有 TTL |
| C4 | runner init frame | 新增可选 `env`；runner 1.1.0；旧帧（无 env）行为不变 |
| C5 | `RemoteSshPiRuntimeLaunchPlan` | 新增可选 `env`；`SshPiRuntimeLauncher` 写进 init 帧 |
| C6 | `RemoteRuntimePort.prepare()` 返回 | `{ plan, extensions: { applied: string[]; reason?: string } }`（plan 形状不污染 wire） |
| C7 | `RemoteRuntimePrepareInput` | 新增 `sessionId?: string`（PiDeck 会话 key，供 `PIDECK_SESSION_ID`） |
| C8 | agent state / renderer | 新增会话级 `remoteExtensions` 字段，供「+」菜单与安全等级选择器判断 |

## 5. 分片与文件级改动

### S1 快照交付 + core8 注入（不需要 env）

1. `src/main/extensions/remoteExtensionSnapshot.ts`（新）
   - `REMOTE_EXTENSION_MIRROR`：每个 `BUILT_IN_EXTENSIONS` 成员的分类（`remote` / `remote-needs-env` / `local-only` / `not-applicable`）+ 理由注释；契约测试保证每个成员都被分类。
   - `listRemoteInjectableExtensionNames(settings, options)`：复用 `listActiveBuiltInExtensionPaths` 的判定语义（hidden / 默认关闭 / removed / noExtensions），输出有序 basename。
   - `readEffectiveExtensionSnapshot(roots)`：overlay 优先 → `readVerifiedArtifact` → 逐文件读字节与 sha；返回 `{ dir, files, bundleSha256 }`。
2. `src/main/remote/RemoteBootstrapContract.ts` / `RemoteBootstrapUpload.ts` / `RemoteBootstrapDeployment.ts` / `RemoteBootstrapTransfer.ts`
   - C1/C2：target token、按 target 派生目录/前缀/锁、`active` 校验按 target。
   - `deployExtensionSnapshot({ files })`：把快照写进本地临时目录 → 走既有 `withPrivateBundleUploadPlan` + finalize。
3. `src/main/remote/RemoteBundleMaintenance.ts`：C3，扩展目录回收；结果计数与 skip 码保持闭集。
4. `src/main/remote/RemoteHostConnectionService.ts`
   - `ensureRemoteExtensionSnapshot(hostId)`：懒部署 + 按 `HeldBootstrap.revision/generation` 缓存；失败返回 `{ ok:false, code }`（不抛）。
5. `src/main/pi/piRpcArgs.ts` / `piRemoteRuntimePlan.ts`
   - `buildRemotePiArgs({ extensions })` 追加 `--extension`；校验每个路径形状；预算仍由 `MAX_REMOTE_ARGS` 兜底。
6. `src/main/pi/remoteRuntimePort.ts` / `AgentManager.ts`
   - 取版本 → 版本门槛 → 取快照 → 组装 names → plan；prepare 返回带 `extensions`；两处调用点（create/reattach）透传 `sessionId`。
   - 启动日志新增 `extensions: [...names]` 或 `extensions: none (reason)`。
7. renderer
   - `useComposerModeAvailability`：plan/goal 可用 = 本机扩展开启 ∧（本机会话 ∨ 远端 `applied` 含对应扩展）。
   - 会话内提示（可选）：`REMOTE_PI_EXTENSIONS_UNSUPPORTED` / `REMOTE_EXTENSIONS_UNAVAILABLE` 只显示一次、不打断。
   - i18n 三份词典（zh-CN/en-US + `node scripts/genZhTwCopy.mjs`）。

### S2 安全等级真正生效（env + 快照）

8. `src/main/remote/RemoteRunnerContract.ts` / `RemoteRunnerEntry.ts`：C4，env 校验与合并；`REMOTE_RUNNER_ENTRY_VERSION=1.1.0` + 冻结 sha。
9. `src/main/remote/SshPiRuntimeLauncher.ts`：C5，init 帧带 `env`；plan 侧校验（单一来源）。
10. `src/main/remote/RemoteSecurityPolicyArtifact.ts`（新）
    - 冻结 inline writer：`node -e <src> -- <entry> <marker> <sha256> <bytes>`，内容走 stdin，
      写 `<deployRoot>/security-policy.json.tmp` → fsync → rename，0600，写后自校验 sha256，输出标记。
    - `pushSecurityPolicySnapshot(hostId, bytes)`：通过同一 pinned client 执行；失败只记日志。
11. `src/main/security/*` + `src/main/index.ts`：等级/配置变更后对**有活跃远端 agent 的主机**重推（本机语义是 ≤2s 热读，远端必须等价）。
12. renderer：`SecurityLevelMenu` 在未应用 security-gate 的会话上禁用并说明；应用后恢复。

### 顺序与提交

- S1 一个提交（`feat(remote): 远端内置扩展快照交付与 -e 注入`）
- S2 一个提交（`feat(remote): 远端安全门 env 通道与策略快照`）
- 文档/门禁台账随各自提交更新；不混入无关改动。

## 6. 扩展清单

| 扩展 | 分类 | 说明 |
| --- | --- | --- |
| plan-mode / goal-mode | remote | 纯 `input` 钩子 + RPC UI；本轮直接修掉标记泄漏 |
| todo（+ todo-state 依赖） | remote | 相对 import 需同目录；`session_tree` 分支恢复在 1.x 真机验 |
| ask-question | remote | `ctx.ui.input` 走 RPC UI 子协议 |
| session-title | remote | 标题请求用远端模型/远端 auth；`autoSessionTitle=false` 时不注入 |
| request-size-recovery / retry-no-body | remote | 纯事件 + RPC UI |
| subagents | remote | 订阅第三方插件事件，远端未装插件即惰性；落 `subagents:record` 供历史投影 |
| security-gate | remote-needs-env（S2） | `PIDECK_SECURITY_CONFIG` + `PIDECK_SESSION_ID` |
| nul-redirect-fix | not-applicable | Windows-only |
| shell-proxy | not-applicable | 只在 PiDeck 注入本地代理 env 时有意义 |
| gui-bridge / ext-points / model-trace | local-only | 连本机 127.0.0.1 bridge；远端需反向隧道，另立项 |
| vision | local-only（本期） | 依赖 vendored `undici` 子目录，需 S3 |
| trash-guard | local-only（本期） | Linux 远端会写远端系统回收站，与项目内 `.pideck-trash` 不同语义，产品待定 |

合计注入 **9 条**（plan、goal、todo、ask、session-title、request-size、retry-no-body、subagents、security）= 18 参数。

## 7. 降级矩阵

| 条件 | 行为 | UI |
| --- | --- | --- |
| `pi < 1.0.0` | 不注入、不上传 | plan/goal/安全等级隐藏；`REMOTE_PI_EXTENSIONS_UNSUPPORTED` 诊断 |
| `piRpcNoExtensions` | 不注入 | 同上（诊断开关语义一致） |
| 快照部署/校验失败 | 不带 `-e` 起会话 | `REMOTE_EXTENSIONS_UNAVAILABLE` 提示一次 |
| 单个扩展在远端加载失败 | 其余扩展照常，pi 逐条报错 | 诊断日志可见；该功能按 `applied` 缺席处理 |
| 安全策略写入失败 | 不带 security env，其余扩展照常 | 安全等级禁用并说明 |
| 等级变更时无活跃远端 agent | 跳过重推 | 下次 spawn 生效（不宣称已生效） |

`applied` 必须来自**实际注入的名单**，不是「编译期常量」；UI 只认它。

## 8. 测试与门禁

单测 / 契约（`tests/*.test.mjs`）：

- `remoteExtensionSnapshot.test.mjs`：overlay 优先、逐文件 sha、26 文件快照、basename 顺序、镜像表覆盖全部内置扩展。
- `remoteBootstrapTarget.test.mjs`：target 闭集、目录/前缀/锁派生、`active` 校验按 target、错误 target 拒绝且不写盘。
- `remoteRunnerEnvContract.test.mjs`：`PIDECK_` 白名单、长度/控制字节、未知键拒绝、旧帧兼容。
- `piRemoteRuntimePlan.test.mjs`（扩展）：9 条 `-e` 的参数预算、路径形状、顺序、超限抛码。
- `remoteBundleMaintenance.test.mjs`（扩展）：extensions 目录保留 active+rollback、不动 bundles。
- `remoteSecurityArtifact.test.mjs`：原子写、0600、sha 自校验、失败不覆盖旧文件。
- `agentManagerRemoteRuntime.test.mjs`（扩展）：`extensions` 结果透传、版本门槛、失败降级不重试。

真机 e2e（真实 Electron + 真实 SSH，扩展 `e2e/remoteSessionAcceptance.spec.ts` 或新 spec）：

1. 计划模式：发送后远端会话 JSONL 中**不存在** `__PI_DECK_PLAN_MODE__`；只读工具集生效。
2. todo：`todo` 工具写入后侧栏出现待办条；刷新/重开仍在（条目落远端 JSONL）。
3. ask_question：卡片往返一次，答案回到模型。
4. 自动标题：首轮后远端 catalog 标题更新。
5. 安全等级：strict 下 `bash rm` 被拦；切到 off 后 ≤2s 生效（与本机语义一致）。
6. 降级：人为让快照部署失败 ⇒ 会话仍可起、提示出现、无标记泄漏（因为没注入时 UI 不再发标记，见 S0 兜底）。

前置：**测试主机需要 pi ≥ 1.0.0**。现测试主机是 0.85.1（登录 shell nvm）。验证时用 nvm 隔离安装 1.3.0 并临时切默认别名，跑完还原，命令与还原步骤写进交接文档；不做「远端 pi 自动升级」。

命令：`npm run typecheck`、上述定向测试、`node scripts/genZhTwCopy.mjs`、真机 e2e、`npm run pack` + app.asar 冻结串检查（bootstrap/runner/sweep 新 sha 标记）。

## 9. 安全立场

- 交付的是**应用自带源码的快照**（与本地执行的是同一份字节），内容寻址 + 逐文件 sha 校验；远端目录 0700、文件 0600。
- 不引入第二条通道：仍复用 pinned ssh client、bootstrap/scp、helper 协议；扩展配置只走 runner init 帧 env（`PIDECK_` 白名单）。
- 远端扩展在用户自己账号下运行，能读远端 `auth.json`（与本地一致）；本轮不新增读取凭据的代码路径。
- 独立安全评审需新增一节：bootstrap entry target 参数、runner env、security 策略写入（项目根之外唯一固定写入点）。
- 日志/错误不含 token/key、完整远端路径；`REMOTE_*` 稳定码继续是闭集。

## 10. 风险与回滚

| 风险 | 处置 |
| --- | --- |
| bootstrap entry 是首次部署的关键 artifact，改动波及全链路 | 只加封闭 target + 目录派生；所有校验逻辑零改动；契约测试 + WSL 真实 helper 子进程测试 + 真机首装验证 |
| argv 预算恰好贴线 | 契约测试断言 9 条 + 最坏会话形态 ≤ 30；新增扩展必须重算预算，超限抛码而不是静默截断 |
| 远端 1.x 各小版本事件差异 | 门槛 1.0.0 + 真机 1.3.x 验证；单扩展失败非致命；`applied` 如实反映 |
| 快照目录堆积 | sweep 保留 active + 1 rollback，其余按既有 TTL；结果计数进日志 |
| 等级热更新不生效 | 变更即重推；无活跃 agent 时明说「下次会话生效」 |

回滚：整体 revert S1/S2 两个提交即回到「远端无扩展」的今天形态；远端已部署的快照目录留在 `extensions/` 下由 sweep 自然回收，不影响 helper/runner。

## 11. 未做（与理由）

- **vision**：需要 vendored `undici`（子目录 + 176 文件），当前快照部署是扁平声明；等快照格式支持子目录或让 vision 改走 pi 内置 fetch 后再做。
- **gui-bridge / ext-points / model-trace**：需要 SSH 反向隧道把本机 127.0.0.1 桥接到远端 pi，是独立设计（端口、token、生命周期、评审面），不塞进本轮。
- **trash-guard**：远端删除的回收站语义与 PiDeck 项目内 `.pideck-trash` 不一致，需产品定义后再说。
- **用户扩展/skills 跨主机同步**：仍按 §13 随远端自己的 pi 配置，不复制。

## 12. 实施落地（2026-10-19）

落地位置（按数据流）：

| 环节 | 模块 |
| --- | --- |
| 镜像表 + 生效快照 | `src/main/extensions/remoteExtensionSnapshot.ts`（`REMOTE_EXTENSION_DISPOSITIONS` 全量分类、名单判定、`readEffectiveExtensionSnapshot`） |
| 快照部署 | `src/main/remote/RemoteExtensionDeployment.ts` + bootstrap entry 的 `target=extensions`（contract/upload/transfer/deployment/session 五处） |
| 保留/回收 | `RemoteBundleMaintenance.ts`：`extensions/` 与 `.deploy-ext.lock`、active + 1 rollback |
| 部署缓存 | `RemoteHostConnectionService.ensureRemoteExtensionSnapshot`（revision+generation 键，与 held bootstrap 同代） |
| 注入决策 | `RemoteRuntimePort.prepare`：版本门槛 `1.0.0` → 设置 → 部署 → 安全门只在快照写入成功后保留；返回 `{ plan, extensions }` |
| 发送边界兜底 | `AgentManager.resolveSendAgentMessage`：`applied` 里没有对应扩展就剥掉 plan/goal 标记（标记字面量统一到 `src/shared/composerModeMarkers.ts`） |
| runner env | `RemoteRunnerContract` / `RemoteRunnerEntry` 1.1.0（`PIDECK_` 白名单、32 项、4096 字符）/ `SshPiRuntimeLauncher` |
| 安全策略快照 | `RemoteSecurityPolicyArtifact.ts`（固定命令 + 行式 base64 + 原子写 0600）/ `SecurityStore.onSnapshotWritten` 热重推 / 端口 `pushSecurityPolicySnapshot` |
| UI 能力门 | `sessionRemoteExtensionsAtomFamily` + `useComposerModeAvailability` + `SecurityControl` |
| 真机验收 | `scripts/verify-remote-extensions.mjs`（默认不调用模型；`--with-prompt` 验计划标记不泄漏） |

与计划的偏差（都是有意收敛）：

1. 快照目录用 `<deployRoot>/extensions/<sha>` 而不是 §8.6 的 `~/.pideck/extensions/<sha>`：复用已审计部署器的 staging/锁/逐文件校验，并与 helper bundle 共用同一私有根与同一套 sweep。
2. 安全策略快照用**稳定路径** `<deployRoot>/security-policy.json`（原子替换），不用内容寻址：它随会话等级频繁变化，内容寻址会累积小块文件；热重推 + `securityFileName` 单一来源避免路径漂移。
3. `PIDECK_AUTO_SESSION_TITLE` 没有下发：关闭自动标题用「不注入 session-title 扩展」表达，少一个 env。
4. 远端 pi 版本门槛取 `1.0.0`（不是 1.3.0）：1.3.0 是本次真机核验版本，更高的 1.x 放行；1.0–1.2 未核验，事件缺失只会让单个扩展降级（非致命）。

未自动化的验收（需人工/后续）：安全门在真实模型回合里的**拦截行为**（本轮已证：扩展加载、命令注册、`PIDECK_SECURITY_CONFIG` 到达且文件存在；未证：模型真的调用 bash 时的 deny/confirm 交互）；todo 条的 UI 呈现与自动标题的端到端呈现同理。
