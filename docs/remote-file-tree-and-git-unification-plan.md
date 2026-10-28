# 文件树与 Git 面板：本地/远端统一改造计划（v5，根子级）

> 状态：**方向已定；W0 已落地（2026-11）**。本文取代 v4.1 作为唯一治理文档；v3/v4/v4.1 的论证结论保留在 §1.1，不再单独维护。
>
> 基线 `dev` / `41a65cfa8`（复核时工作区含未提交的 S0 行组件改动）。
> 相关：[架构](architecture.md)、[位置模型 ADR](project-location-architecture.md)、[远端 Git 计划](remote-git-plan.md)、[远端文件管理计划](remote-file-management-plan.md)、[远端协作交接](remote-development-handoff.md)、[工程标准](engineering-standards.md)。
>
> **本文只治理"统一层"。** helper 线协议、bootstrap/pin/trust、令牌语义、远端终端与会话链路不属于本次改造对象（§5 说明为什么）。远端能力与令牌的原始账本仍以 `remote-git-plan.md`(G1–G6c) 与 `remote-file-management-plan.md`(§3/§5/§9) 为准。

## 1. 根子问题（四条，互相咬合）

不是"文件树和 Git 各写了一份"，而是四件事叠在一起：

| # | 根问题 | 证据 |
|---|---|---|
| **A** | **远端事实没有唯一拥有者**：谁缓存、谁失效、谁合并、谁决定这次刷新花多少钱，每个界面自己定 | `useFileTreeGitStatus` 自己 listRepos + 每仓 status；`useGitRepoScope` 再读一遍 listRepos；面板再算一遍 status。刷新策略散在 4 个 hook（400ms 防抖 / 5s 轮询 / 15s refs / 手动） |
| **B** | **两套通道族 + 三套结果词汇** | `git:*`（33 handler，抛异常）vs `git:remote-*`（`{ok,code}` 信封）；`files:*`（抛）vs `remote:project-entry-*`（信封 + trashId）；`GitGenerateCommitMessageResult` 又是第三种 `{ok,code,message}` |
| **C** | **渲染层有两套数据层** | 本机 `GitPanel` 纯 props；远端 `remoteGitViewState`(674) + `RemoteGitPanel`(631) + `useRemoteGitView`(127) + compare/refs/repos ≈1600 行专用管线 |
| **D** | **身份与授权是"事故性"的**，不是写下来的策略 | `FileTreeNode.path` 既当本机绝对路径又当目录键；令牌按 (sender, project) 而非 (sender, project, repo, kind, revision)；`entry.stat` 是签发令牌的读。多仓互斥、热路径签令牌都由此"碰巧"发生 |

只修 A（加事实层）会把 B/C/D 留成永久债：合并后的通道里仍有三套词汇，渲染层仍有两套数据层，身份仍在两个语义之间反复。

### 1.1 已定结论（不再重复论证，需要时看证据）

- **文件域**：按 ISP 拆 `ProjectFileReader` / `ProjectFileWriter`；`list` 返回 `{entries, revision}`；`hasChildren: true|false|"unknown"`（本机精确探测 N+1 次、远端一律乐观，必须声明）；`expected?` 收据进契约。
- **`stat`/`pathsExist` 不得路由到 `entry.stat`**：它是签发令牌的读，令牌表全局 FIFO 128 → 128 目标的批量会挤掉用户写授权。证据 `tests/remoteFileStatTokenPressure.test.mjs`。
  **但不需要新 helper 方法**：只读批量早就有——`RemoteWorkspaceReader` 的 `stat` / `statMany`（≤64 路径/帧、全有或全无）/ `list` / `readFile` / `search`，helper 1.22.0 已上线（`fs.*` 批次）。v5 初稿写的“新增 `entry.statMany`”是重复发明，已作废；`files:stat`/`pathsExist` 的 128 目标 = **2 帧**。
- **远端只读文件面已经实现且已逐字段校验**：`createRemoteWorkspaceReader({ port: sessionPort(session, hostId) })`，`remoteProjectIpc` 的 list/read/search 已经全部走它（`:255/:284/:315`）。所以重复不在 helper 层，而在**通道层**（`remote:project-*` vs `files:*`）——W3 直接建在这上面，不重写读实现。
- **列表上限不一致必须先对齐**：远端 `fs.list` 每目录 ≤4096 条（按名字 code-unit 排序）；本机 `listTree` 上限 **2000**。统一契约要选一个（推荐取 2000，向抽屉已有的批处理对齐），并在 `revision` 里把“被截断”如实暴露。
- **写面收缩**：先只合并 `create`/`rename`；`delete`/`move` 等契约能表达 revision + 回收站 + 三态结果再合。
- **忽略语义**：`.gitignore` 由 git 权威判定（`check-ignore`），条目带 `ignored` 修饰降级显示而非隐藏；非仓库退到内置规则并声明。不自己重写 gitignore 语义。
- **远端不堆叠**：令牌是"一窗口×一项目×一动作一份"，`GitDrawerHost` 的多仓并排与之物理冲突。证据 `tests/remoteGitMultiRepoTokenScope.test.mjs`。
- **远端门禁**：`enabled: remoteExperimentEnabled` 现为字面量 `true`，有守卫测试禁止重新耦合 env；统一 dispatch 必须继续尊重它。
- **不做**：抄 ZCode 的绝对路径节点模型、抄它的常驻 host 部署形态、抄 60s 自动刷新补偿。

### 1.2 全生命周期盘点：同样的根病还有三处（R1–R3）

按**不变量**（而不是按界面）把远端链路走了一遍：主机接入 → 会话 → 终端 → 文件/Git → 会话历史 → 上传。结论是三处同类，其中一处**只能显式化、不能在本轮修**。

| 编号 | 根问题 | 证据 | 与 A–D 的关系 | 归属 |
|---|---|---|---|---|
| **R1** | **一个 host 同时只有一个活动 root**：helper 启动时 `--root` 固定，切 root 就 `discard` 整个会话重建；整台 host 一把 `operationLock` | `RemoteHostConnectionService.ts:618-623`（不同 root ⇒ discard）、`:1180-1206`（`operationLock.run`）、`RemoteSessionScanner` 借 `withProjectSession(hostId, 会话根)` | A 的物理版本：不是“谁缓存”，是“根本没有并行容量” | **本轮不改**（要动 helper 协议）；本轮只把它显式化 + 可测 |
| **R2** | **信封在每个 IPC 边界被拆开重建**：`withProjectSession` 返回 `{ok,code}` → handler `throw new Error(result.code)` → 自己再 `catch` 成 `{ok:false, code}`；`codeOf` 有 8 份独立实现，fallback 各不同 | 6 处 `if (!result.ok) throw new Error(result.code)`（`remoteGitReadIpc:72`、`remoteProjectEntryIpc:30`、`remoteProjectFileIpc:17`、`RemoteHostConnectionService:800,1118`、`createRemoteTerminalManager:35`）；`codeOf` 独立实现 8 份；`remoteProjectIpc.ts:10` 明写“两个域刻意互不 import …`codeOf` 在本文件重新声明” | B 的放大版：不是三套词汇，是**七套**（files/git/hosts/entry/transfer/trust/session 各一套） | **并入本轮 W2/W4** |
| **R3** | **“主机可用”有两个定义**：`ready \|\| degraded` vs `ready` | `ConnectionsTab.tsx:310`、`remoteConnectionProgressState.ts:97` 用前者；`useRemoteGitView.ts:28` 用后者；renderer 共 4 处订阅 `onStateChange` 各算一套 | A 的渲染层版本 | **并入本轮 W3**（`capabilities` 快照的前置） |

R1 的后果（写下来以免当成 bug 反复查）：

- 同 host 两个远端项目交替访问 ⇒ 每次切换 `discard` + 重建会话（探针 + 边界复验），不是慢一点，是**结构性重建**；
- 打开会话列表 ⇒ `RemoteSessionScanner` 把 root 切到会话根，**用户的文件树/Git 会被踢下线再连回来**；
- Git 多仓并排：**不是** helper 做不到（`repo` 只是每帧参数），是令牌 revoke 作用域把多仓判死（证据 `tests/remoteGitMultiRepoTokenScope.test.mjs`）。
- 所以“远端不并排多仓”是对齐物理事实，不是偷懒。

**看过但不构成根问题（不改，只记一笔）**：连接状态机（`RemoteHostConnectionState` 是纯 reducer + generation 围栏）、`withProjectSession` 的会话钉定、会话文件写入（收敛在 `RemoteSessionHistoryWriter` + 一个 write guard）、远端模型目录（复用 live runtime，不重新探测 pi）、上传的 stdin 分块（argv 8 KiB 预算所致）、四个传输并存（helper NDJSON / 终端 PTY / stdin 分块 / 远端 pi rpc——**各有物理原因，统一它们才是错的**）。

### 1.2.1 R1a 任务卡：会话扫描不抢 root（可并行，不碰 helper）

**目标**：读会话列表 / 解析会话根时不再借 `withProjectSession`，因此不再把用户项目的活动 root 切走。

- 现状：`RemoteSessionScanner.ts:418` 走 `port.withProjectSession(hostId, <home>/.pi/agent, …)` → helper 换 root → `RemoteHostConnectionService.ts:618-623` 直接 `discard` 整个会话。用户每刷一次会话列表，文件树/Git 就要重连一次。
- 现成的对标先例：`RemoteSessionHistoryWriter.ts:755` 用**一次性命令** `ports.transport.runRemoteCommand({ hostId, remoteCommand })`，全程不碰 helper、不切 root。会话历史**写**已经是这条路，**扫描**却不是 → 这就是 R1a。
- 做法：
  1. `src/main/sessions/` 新增一次性命令版的「会话根解析 + 会话列表读取」（复用 `RemoteSessionHistoryWriter` 同款 transport 注入；stderr 不外传，失败折稳定码）。
  2. `RemoteSessionScanner` 改用它；`remoteSessionIpc` / `remoteRuntimePort` 的端口装配同步（`resolveSessionRoot` 也走同一路径）。
  3. 命令形态沿用既有判据：`BOUNDARY_SCRIPT` 同源的路径校验、输出上限、闭集稳定码。
- **不碰**：`RemoteHelperContract.ts`、`RemoteHelperEntry.ts`、`RemoteHostConnectionService.ts` 内部逻辑（只在装配处传新端口）。
- 门禁：`node --test tests/remoteSession*.test.mjs`；新增一例断言“扫描会话列表后不发生 root 切换”（用假 port 计数，断言 `withProjectSession` 零调用）；`npm run typecheck`。
- 冲突面：`src/main/index.ts`（公共汇聚文件，单写者）、`src/main/ipc/remoteSessionIpc.ts`；与 hosts 域的并行改动不重叠。

R1b（helper 多 root）不在本卡内：它要改 helper 协议（帧带 root，或每 root 一进程 + LRU），必须与 W6 的 helper 升版同批，且先回答“同 host 并行多项目要不要支持”。

### 1.3 审计口径：为什么以前会漏，以后怎么不再漏

以前的盘点按**界面**分组（文件树 / Git 面板 / 侧栏圆点），所以只找到了“同一份界面里”的重复；跨界面、跨传输、跨域的同一种病看不见。改成按**不变量**逐域问 5 句：

1. 这个事实（列表/状态/能力/版本）**谁拥有**？有没有第二处也算同样的值？
2. 成功与失败**几个词汇**？边界处是否把 `{ok,code}` 换成异常又换回来？
3. 同一个动作**几条通道**？能不能在一条通道上表达？
4. 授权按什么**定作用域**？作用域单位与 UI 的用法一致吗？
5. **物理容量是几**（一个 root？一把锁？128 个令牌）？UI 的用法超过它了吗？

第 5 问是这次才补的：R1 与“远端不并排多仓”都是它问出来的。

**未来梯子（本轮不做，写下来免得重复讨论）**

- **V1 helper 多 root**：帧里带 root，或每 root 一个 helper 进程。是否做取决于产品要不要“同 host 并行多项目”（内置会话列表也在抢 root）。
- **V2 主机级事实视图**：“这台 host 上正在跑什么”（终端 tab / agent 进程 / 活跃会话）现在分属三个 manager，没有单一视图。
- **V3 传输层生命周期词汇**：只统一“开始中 / 已开始 / 失败 / 失去”四个词，**不统一传输本身**（PTY / rpc / NDJSON / stdin 分块各有物理原因）。

## 2. 目标架构：两个边界、单通道族、单信封、单授权

```
┌─ renderer ───────────────────────────────────────────────────────┐
│  useProjectFiles(projectId)          useProjectGit(projectId)     │  ← 只有两个域 hook，不知道"位置"
│     读 snapshot(revision, generation) / 发 refresh(scope) / subscribe(scope)
│  远端独有 UI 只剩三块：trust gate / recovery / init confirm        │
└──────────────────────────────────────────────────────────────────┘
        ▲  单一 IPC 面（通道名里没有 remote）+ 统一信封
┌─ main ───────────────────────────────────────────────────────────┐
│  RemoteWorkspaceView（每 project 一份）                            │
│    dirCache / repoCache / headFacts + revision/generation          │
│    在途合并 + 刷新预算 + 失效矩阵 + 计数器                          │
│  ProjectFileService / ProjectGitService（位置无关，含写面）          │
│    ├─ LocationBackend "local" → FileSystemService / GitService     │
│    └─ LocationBackend "ssh"   → helper 有界方法（W6 起 + 推送）      │
│  GrantStore（一套模型，多 purpose）                                 │
└──────────────────────────────────────────────────────────────────┘
        ▲  NDJSON 有界命令 + (W6) 事件帧（线协议不变，只加方法）
```

四条硬规定：

1. **只有 `LocationBackend` 的两个实现允许知道 local/ssh。** 出了这两处，任何 `if (isRemote)` 都是回归（门禁 3）。
2. **一个信封**：所有跨进程操作返回
   ```ts
   type Op<T> = { ok: true; value: T } | { ok: false; code: string; outcome: "rejected" | "unknown"; message?: string };
   ```
   本机也走（本机 envelope 恒 `rejected`，`unknown` 永远只来自远端写）。`code` 是稳定码闭集；`message` 只用于本机 git stderr 之类的可读补充，不参与判定。
3. **一份能力快照**：`capabilities(projectId) → { files, git, terminal, session }`，按 generation 缓存。UI 只读它决定渲染；禁止 `try { call } catch (UNSUPPORTED_*)` 决定 UI（门禁 8）。
4. **一套授权模型**：`GrantScope = { purpose, sender, project, repoPath?, revision? }`；`read 永不签发`；多仓互斥从"实现巧合"升级为显式策略 `POLICY_SINGLE_ACTIVE_SCOPE = true` + 断言 + UI 文案（门禁 10）。

## 3. 形状细则

### 3.1 `LocationBackend`

```ts
type LocationBackend = {
  readonly kind: "local" | "ssh";
  files: ProjectFileReader & Partial<ProjectFileWriter>;
  git: ProjectGitService;
  capabilities(): Promise<ProjectCapabilities>;
  dispose(): void;
};
```
- 参数校验的**严格性跟着 backend 走**：ssh 侧继续拒绝未知字段、限制长度、折叠非闭集码；描述表只做形状归一，不削弱校验（门禁 15）。
- `filesIpc` / `gitIpc` 变成描述表：`register(通道, (backend, args) => backend.git.status(...))`。33 条 git handler 收缩为表 + 4 条非服务型（refs watch / worktree / QuickGen / 可执行文件选择）。

### 3.2 `RemoteWorkspaceView`

```ts
type RemoteWorkspaceView = {
  listDir(dir): Promise<{ entries, revision, hasChildren: "exact"|"unknown", ignored: string[] }>;
  statPaths(paths): Promise<Array<{ exists, isDirectory }>>;
  repoList(): Promise<{ repos, truncated, revision }>;
  status(repoPath): Promise<{ groups, revision }>;
  headFacts(repoPath): Promise<{ branch, ahead, behind }>;
  checkIgnore(paths, repoPath?): Promise<boolean[]>;
  refresh(scope): Promise<{ served: "cache"|"coalesced"|"remote"; calls: number }>;
  invalidate(scope, reason): void;
  watch(scope, onChanged): () => void;
};
```
- `revision` 由 main 从 backend 输出派生（成员 `relativePath+type+ignored` 排序哈希），**不传输**，因此本机/远端/第三个位置同一语义。
- `generation` 在 host 断连/重连、locator 变更时 `++`；渲染层跨代数一律丢弃缓存。
- **与编辑器版本令牌划清边界**：`remote:project-text-open|save` 的 `version` 是"写授权收据"（一次编辑会话），`revision` 是"列表/状态新鲜度"（一次读取）。不合并、不互相替代。
- 失效矩阵（写 → 父目录；create/rename/delete → 源+目标；stage/commit → repo+head+受影响目录；checkout/fetch/push → 全目录惰性失效；断连 → generation++）。**失效只标记，不预读**。
- 合并与预算：同 `(project, scope-key)` 在途请求共享 promise；`refresh` 每次最多 `1 + repos.length` 次远端调用，超出退化为所请求的 scope 并如实报告 `served`/`calls`。

### 3.3 `GrantStore`

```ts
type GrantScope = { purpose: "git-write"|"file-entry"|"file-text"; sender: number; project: string; repoPath?: string; revision?: string };
```
- 每个 purpose 一张表（互不驱逐），容量/TTL 各自声明，`read` 路径不签发。
- `take()` 只在 scope 完全匹配时消费；不匹配不烧令牌、报专用码。
- **策略常量**：`POLICY_SINGLE_ACTIVE_SCOPE`（当前 true）——为 true 时 `issue` 替换同 `(sender, project, purpose)` 的旧授权；改成 false 即支持并排多仓，需要同步改断言与 UI（独立决策，不随波）。
- 现状差异只在"粒度是否显式"：v4 里这些行为是 `issue` 循环的副作用，v5 里是常量 + 断言 + 文档。

## 4. 迁移波次（每波自带 parity 门禁与回滚点）

> **两个 agent 在同一工作区并行时的顺序纪律**：**W1 不可并行**——它是跨文件改名（`FileTreeNode` / 拖拽负载 / 活跃键 / 展开态键），中间态 typecheck 必红，会把另一个 agent 卡死；必须等 `FileTreeRows.tsx` / `RemoteProjectPanel.tsx` / `useRemoteFileTree.ts` 空出来再单干。
>
> 可并行的只有两类切片：① 新增文件 + 逐域迁移、**每步都绿**（`shared/op.ts` 底座、`RemoteWorkspaceView`）；② 边界在别的目录且不溢到 renderer（R1a，见 §1.2.1）。所以并行窗口里先做 R1a + W2 底座，W1 放最后。

| 波 | 内容 | 门禁（必须同时满足） | 回滚 |
|---|---|---|---|
| **W0** | 计数器：helper 每次 `request` 按 `(hostId, method)` 计数 + 快照/格式化 + `PIDECK_REMOTE_METER=1` 时低频日志——**已交付**：`src/main/remote/RemoteCallMeter.ts` 挂在 `RemoteControlClient` 的发帧路径上，`tests/remoteCallMeter.test.mjs` 5 例绿 | 单测覆盖计数/排序/上限/复位/只计发帧请求；typecheck 绿；不改任何行为 | 纯新增，删文件即回滚 |
| **W1** | 身份去双语义：`FileTreeNode` / `FileSearchResult` / `GitResource` 的 `path` 退役，一律 `relativePath + target`；拖拽负载改 target | typecheck 枚举全部调用点；树/编辑器/拖拽/搜索全绿 | 逐文件 |
| **W2** | 统一信封：**全 remote 域**（files/git/hosts/entry/transfer/trust/session）一律 `Op<T>`；本机也走；`codeOf` 下沉 `shared/` 且 fallback 收成闭集；删掉 6 处 `!result.ok → throw` 适配器与 8 份 `codeOf` 副本 | 既有错误码断言不变；`unknown` 只由两个既有专用码产生；每个面板的失败文案不回退 | 按域切换（files 先、git 后、hosts/session 最后） |
| **W3** | `RemoteWorkspaceView` + `watch` 形状（实现＝写后失效，不轮询）+ 两份 conformance 首版 + `capabilities(projectId)` 快照（“主机可用”只留一个定义，替掉 renderer 的 4 处各自判定）+ 预算计数器接线；文件读直接落在既有 `RemoteWorkspaceReader`（`statMany` 分批 64） | 一次内容变化 `listRepos ≤1`、每仓 `status ≤1`；树与面板读同一 `revision`；W0 基线数字下降 | 整层可旁路（通道临时直连 backend） |
| **W4** | `LocationBackend` + 单通道族：删 `remoteGitReadIpc` 的通道注册，ssh 作为 backend 注册在同一批通道名上；`filesIpc`/`gitIpc` 描述表 | 通道数减半；ssh 严格校验负例仍拒绝（未知字段/超长/非闭集码）；`enabled` 门禁生效 | 双注册期（两族并存一版） |
| **W5** | 渲染层收口：删 ≈1600 行远端管线，落 `useProjectFiles`/`useProjectGit` + 三块远端 UI；远端单仓 | 两套视觉一致；远端独有区块未丢；远端渲染总量下降；parity 表逐项勾销 | 面板级 |
| **W6** | helper 同批升版：`git.checkIgnore`（现在没有）、`fs.watch/unwatch` + 事件帧；`capabilities.watch` 协商 | 事件只触发失效；watcher/帧预算内；断连/销毁全清；不支持时显式降级到轮询 | 能力协商关闭即回轮询 |

**顺序的理由**：W0 给基线，W1 修身份（否则 W3 的 `revision` 无法稳定），W2 修词汇（否则 W4 只是把两套词汇塞进一个文件），W3 立事实层，W4 才合并通道，W5 才敢删渲染层，W6 才加传输。

## 5. 明确不重写（重写零收益，只有风险）

| 不重写 | 为什么 |
|---|---|
| helper 线协议（NDJSON 帧、冻结 SHA、四 bundle） | 是传输格式不是架构问题；已有一小时 soak 与逐方法契约测试。只加方法 |
| bootstrap / pin / 指纹 / trust / 会话恢复 | 安全面最贵的部分，与本主题正交 |
| 令牌**语义**（读不签、单次消费、CAS、unknown 不重放） | 是资产；只把"作用域粒度"从副作用改成显式策略 |
| 远端终端 / 会话 / 模型与配置链路 | 已是同一种"帧 + 推送"形态，W6 反而拿它当模板 |

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 合并通道弱化 ssh 校验 | 校验跟着 `LocationBackend` 走，不进描述表；W4 加"仍拒绝未知字段/超长/非闭集码"的负例门禁 |
| 统一信封把 `unknown` 拍成 `rejected` | `outcome` 为必填；`unknown` 仅由 `GIT_WRITE_RESULT_UNCONFIRMED`/`REMOTE_FILE_RESULT_UNCONFIRMED` 产生，门禁扫源码断言 |
| 事实层退化成"更大的陈旧缓存" | `revision` 必须可证伪：写后定向失效 + 显式 refresh + 计数器；禁止用 TTL 当正确性依据 |
| W5 删太快丢行为 | 先写 parity 表（远端每个可见行为 × 归属 × 证据），逐项勾销，不靠"看起来一样" |
| W2 面积大（本机也改信封） | files 域先切、git 域后切，各自独立回滚；`unwrap()` 统一收口，调用点改动机械 |

## 7. 质量门槛

| # | 判据 | 检查 |
|---|---|---|
| 1 | 文件树加载实现 = 1 | `childrenByDir` 只出现在 controller/`fileTreeLazy` |
| 2 | 忽略规则来源 = 1 | 名字表只在 `shared/fileTree`；渲染层无第二份 |
| 3 | 位置感知只有一个地方 | `ffgrep "locator.kind\|isRemoteProject" src/renderer` 为 0；main 侧只在 `LocationBackend` 两实现内 |
| 4 | Git 面板位置无关 | `GitPanel.tsx` 中 `remoteGit` 出现 0 次 |
| 5 | 不复用"搬家"冒充收敛 | 远端专用代码总量单调下降；适配器/backend 各自 ≤ 核定行数 |
| 6 | 契约测试覆盖两实现 | 两个 conformance 文件 + 分歧账本被断言 |
| 7 | 安全断言未改 | `remoteGitMutationTokens`/`trust*`/`remoteProjectRequestState`/`remoteFileStatTokenPressure` 保持 |
| 8 | 能力显式缺席 | 能力关闭时 DOM 无对应按钮（快照断言） |
| 9 | 令牌红线 | 远端 `list/stat/pathsExist/checkIgnore` 前后令牌数不变；树着色只走 `git:status` |
| 10 | 单活动 scope 是策略 | `POLICY_SINGLE_ACTIVE_SCOPE` 常量存在且被断言；远端宿主渲染面板数恒为 1 |
| 11 | 事实同源 + 预算 | 计数器断言：一次内容变化 `listRepos ≤1`、每仓 `status ≤1` |
| 12 | 订阅形状就位 | `watch/unwatch/onChanged` 被树与面板使用；渲染层无 `setInterval` 刷新 |
| 13 | ignore 权威 | 无自写 gitignore 匹配逻辑；`ignored` 是修饰不是过滤 |
| 14 | **信封唯一** | 渲染层无 `{ok: false, code}` 以外的失败形状；`outcome` 必填 |
| 15 | **ssh 严格性未降** | 未知字段/超长/非闭集码的负例测试仍全绿 |
| 16 | **测量可用** | `RemoteCallMeter` 有单测；W3 起把它接进预算断言（数字来自代码，不来自人工统计） |

## 8. 待拍板

已定：根子级改造方向（两边界/单通道/单信封/单授权）、事实层前置、ignore 用正解、推送进 W6 且先立形状。

仍开放：

1. **W2 的切换顺序**：files 先（小）还是 git 先（影响面大但收益直观）。推荐 files 先。
2. **`hasChildren` 本机策略**：保留 `exact`（N+1 次 readdir）还是降 `unknown`。推荐保留 exact。
3. **`POLICY_SINGLE_ACTIVE_SCOPE`**：维持 true（远端单仓）还是改 false（支持并排多仓，需改既有断言与 UI）。
4. **`delete`/`move` 合并时点**：等契约长出 revision + 三态（推荐，另立小波 W4b）。
5. **W6 是否与本轮同批交付**：推荐是；若分两期，W3 的 `watch` 形状必须先在。

## 9. 证据与入口

| 用途 | 命令 / 路径 |
|---|---|
| 远端调用计数（W0） | `node --test tests/remoteCallMeter.test.mjs` |
| 文件 stat 令牌压力 | `node --test tests/remoteFileStatTokenPressure.test.mjs`（4 例） |
| Git 多仓令牌冲突 | `node --test tests/remoteGitMultiRepoTokenScope.test.mjs`（3 例） |
| 既有令牌/文案语义 | `node --test tests/remoteGitMutationTokens.test.mjs tests/remoteProjectEntryState.test.mjs` |
| 远端门禁现状 | `tests/remoteHostIpc.test.mjs`（断言 `remoteExperimentEnabled = true` 字面量） |
| 参考实现（只读对照） | `F:/ZCode`：`desktop/src/host/index.ts`、`services/src/fileWatcher/*`、`services/src/git/git.ts`、`ui/src/workspace-file-tree/*` |
| 本仓推送先例 | `src/main/terminal/RemoteTerminalSessionManager.ts`（`emit(senderId, channel, payload)`）、`git:watch-refs` |
