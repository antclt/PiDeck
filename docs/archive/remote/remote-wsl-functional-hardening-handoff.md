# SSH/WSL 功能收敛交接与执行计划

> **Status: Historical（归档于 2026-10-31；内容按归档时代码，不代表现状；现行见 docs/README.md）**


> 交接对象：接手 PiDeck SSH/WSL 功能收敛的 Tech Lead 及其并行工作流。
> 本文是执行文档，不是发布说明。当前阶段不打包、不写发布材料、不 push。
> 本文中的行号/计数是交接时快照；开工必须以 `git status`、`git log` 和实际测试为准。

## 1. 任务定位

目标不是继续扩功能，而是把已有 SSH/WSL 能力做到“行为一致、状态及时、边界清楚”：

- 修掉用户能直接感知的状态不同步和配置错位。
- 保持现有 SSH/WSL 主路径可用，不重写 helper，不扩大功能面。
- 为后续人工实测提供稳定基线。
- 不执行打包、不写发布材料、不推送远端。

当前重点：

1. 远端写操作后的跨域事实失效。
2. 远端实时性：Git status 轮询、深层目录 watch。
3. WSL 配置作用域。
4. 不支持能力在 UI 上的明确表达。
5. 验证证据，而不是继续堆功能。

## 2. 开工前基线

交接时核对：

- 仓库：`F:\PiDeck`
- 分支：`dev`
- 工作树：干净
- HEAD：`8d5add152`（docs: 登记 test-shape 例外并同步 67 域统一接口表）
- 相对 `origin/dev`：**5 behind / 105 ahead**
- 未 push

上次验证结果（不是本轮开工后的保证）：

- `npm test`：14928 tests / 14643 pass / 0 fail / 285 skipped
- `npm run typecheck`：0
- `npm run check:format`：0
- `npm run check:test-shape`：0
- `npm run check:ipc-wiring`：795 通道通过
- 合并后全量远端真机 E2E **没有跑完**；历史通过项不能当作当前通过

开工先执行并记录：

```bash
git status --short
git log --oneline -5
git rev-list --left-right --count origin/dev...HEAD
```

如果工作树不干净，先确认是谁的改动，不要清理、暂存或覆盖。若 `origin/dev` 已前进，先报告，不要自行 merge/rebase。

## 3. 硬约束

- 不 push，不 merge 到远端，不发布。
- 不执行 `npm run build`、`npm run preflight`、`npm run pack`。
- 不安装依赖，不升级 Electron/pi，不改 helper 协议，除非单独立项。
- 不修改 pi 正在使用的会话 JSONL；会话编辑走 `context_edit`。
- 不删除或放宽现有测试断言。
- 不把跳过项算成通过。
- 不清理、不 stash、不 reset 别人的改动。
- 不输出远端密码、密钥、fingerprint 或会话标识。
- 同一文件同一时刻只允许一个写者；公共汇聚文件由 Tech Lead 统一修改。
- 两个以上 agent 同时改 `src/` 时必须用 `git worktree`，不要共享工作树。
- 不顺手重构、不修无关缺陷；发现的问题记录到交接清单，不混入当前提交。

当前环境注意：

- Windows + Node；`/tmp` 实际是 Windows Temp。
- WSL 当前只有 `Ubuntu-26.04`，且处于 Stopped；没有第二个发行版，不要自行安装。
- macOS 没有本机证据；不要声称 macOS 已验证。
- 远端真机凭据由现有本地环境提供，不写入仓库、不打印。

## 4. 已确认的功能缺口

### P0：远端状态不同步

#### P0-1 Git 写成功后文件树不失效

现状：

- `src/main/ipc/remoteGitReadIpc.ts` 的写路径只失效 Git 快照事实，并发布 `{ kind: "status" }`。
- 文件树只消费目录通知；`src/renderer/src/utils/lazyDirTree.ts` 的 `applyFactsChange` 不处理 status。
- `src/main/ipc/remoteProjectIpc.ts` 的目录缓存不会因 Git 写而失效。

用户可见结果：

- 切分支、discard、恢复快照、初始化仓库后，文件树仍显示旧文件。
- 即使关闭再打开文件抽屉，也可能命中旧目录事实缓存。

验收：

- 远端 Git 写成功后，已加载目录自动重读。
- 根目录和深层目录都能刷新。
- 不因一次 Git 写把整棵树重置展开状态。
- 现有 Git/目录事实测试不回归。

#### P0-2 文件写成功后 Git 面板不刷新

现状：

- `remoteProjectIpc.afterWrite` 只失效目录事实并发目录通知。
- `src/main/git/RemoteGitSnapshotFacts.ts` 的缓存没有因文件写失效。
- 远端 Git 面板没有本地那种 5 秒 status 轮询。

用户可见结果：

- 在文件面板新建、改名、移动、删除、还原文件后，Git 面板继续显示旧状态。
- 用户必须点一次强制刷新才正确。

验收：

- 远端文件写成功后，当前项目所有已缓存 Git status scope 失效。
- 活跃 Git 面板收到通知并重读，不显示成功假象。
- 未知结果/失败路径也要有明确状态，不重放写。

#### P0-3 远端 Git 没有外部变更轮询

现状：

- `src/renderer/src/hooks/useRemoteGitView.ts` 挂载时读取一次；之后主要依赖写面通知。
- `RemoteGitPanel` 只有 refs 展开时的 15 秒轮询，没有 status 轮询。
- 本地 Git 有 5 秒 status 轮询。

用户可见结果：

- 远程终端或 Agent 里 commit/checkout 后，Git 面板不自动更新。
- 远端文件被其它进程修改后，状态也可能长期旧。

验收：

- 面板可见、host ready、非变更中时，每 5 秒静默刷新 status。
- 面板隐藏、host 非 ready、变更中、diff/history 打开时按策略暂停或只更新状态。
- 不自动 fetch，不重置用户打开的 diff/history/选中行。
- 同一时刻最多一个 status 请求。

#### P0-4 远端目录只监听根层

现状：

- `remoteProjectIpc.ts` 的 `ensureRootWatch` 固定 `paths: [""]`。
- helper 的 `fs.watch` 是 `recursive: false`。
- 目录事件只标脏根目录，已加载的深层目录不会重读。

用户可见结果：

- Agent 修改 `src/foo/bar.ts` 时，根目录 mtime 不一定变，文件树不刷新。
- 即使根层有事件，深层目录仍可能是旧内容。

验收：

- 根目录和已加载目录都建立订阅。
- 事件只重读已加载且受影响的目录。
- 4 个 watcher × 32 路径的真实上限必须处理；超出时明确降级，不静默假装覆盖。
- 断连、项目关闭、root 切换时成对退订/换代。
- 迟到 watchId 不得登记到新会话。

### P1：WSL 配置作用域错误

#### P1-1 WSL 配置页编辑的是 Windows HOME

现状：

- `src/main/index.ts` 的 `syncWslConfig` 清空 WSL 配置/技能/提示词/扩展管理器，并注明“暂按本机 HOME 展示，后续单独做”。
- `src/shared/piConfig.ts` 的 `PiConfigTarget` 只有 `{ kind: "local" } | { kind: "ssh", hostId }`，没有 WSL 目标。
- `src/main/config/ConfigManager.ts` 有全局 `configureWsl`，但当前装配不使用它。
- WSL 会话里的 pi 读取发行版 HOME，设置页读取 Windows HOME。

用户可见结果：

- 用户在设置页改模型/设置，WSL 会话实际不生效。
- 多 WSL 档案之间无法区分配置。

验收：

- 新增 WSL 配置目标，按 hostId 解析发行版 HOME。
- 读取/写入 `models.json`、`settings.json` 走正确的 UNC 路径。
- 不通过全局 `configureWsl` 改变所有窗口的配置目录；并发目标不能互相污染。
- 本机和 SSH 配置行为不变。
- 没有 WSL 档案、发行版停止、路径不可访问时给稳定错误码。

#### P1-2 WSL 技能/提示词/扩展页仍然错位

现状：

- 与配置页同一原因；当前没有按 WSL 档案路由。
- 直接把 Windows 内容展示成 WSL 内容，比不展示更危险。

验收：

- 第一阶段明确标注“仅编辑 Windows 配置”，禁止静默错配。
- 技能/提示词/扩展的完整 WSL 作用域另立工作流，不混在配置目标卡里。
- UI 文案要能明确告诉用户当前编辑的是哪里。

### P1：内容搜索静默缺失

现状：

- 远端 helper 只有 `fs.searchNames`，没有内容搜索。
- `src/main/ipc/filesIpc.ts` 的 `filesSearchContent` 只走本机项目。
- WSL 的 `indexRootsFor` 直接返回空数组。
- `useFileSearch` 仍会发起内容搜索；远端会失败，WSL 返回 null；`FileSearchResults` 在没有命中时不渲染内容分区。

用户可见结果：

- 用户以为“没有匹配”，实际是“这个位置不支持内容搜索”。

验收：

- 远端和 WSL 明确显示“仅文件名搜索”或等价提示。
- 不显示内容搜索 spinner 和空分区。
- 不在不支持的位置发起无效 IPC。
- 远端内容搜索如后续实现，必须有扫描上限、取消、二进制/UTF-8 拒绝和截断提示。

### P1：同主机多项目单 root

现状：

- `RemoteHostConnectionService` 每个 host 只有一个 held helper；helper 的 `--root` 生命周期固定。
- 切项目会丢弃当前 manager/session，目录 watch 也会换代。
- 两个远端项目不能同时保持实时树、Git 和 watcher。

用户可见结果：

- 两个远端项目来回切时出现延迟、首读瞬态、监听丢失。
- 高频切换会反复重建 root 会话。

验收：

- 先测量：单次 root 切换耗时、失败率、watcher 重建次数。
- 设计按 root 复用的 helper/session 池，或给出明确不做的理由。
- 未完成压测前不改生产架构。
- 若实现，必须有容量上限、淘汰策略、断连清理、两项目并行读测试。

### P2：能力边界未统一表达

远端当前明确没有：

- Git history 的 ref/path/allBranches 过滤和 totalCount。
- 任意 commit 图、commit count。
- cherry-pick/revert/reset/drop/worktree。
- 批量 stage、smart commit、AI commit message。
- 多仓并排。
- 远端 DSH/ACP；远端会话固定 pi。
- 远端技能/提示词/扩展管理。
- 超过 16 MiB 的上传。
- 文件夹上传。

要求：

- UI 不显示不可用动作的“成功”分支。
- 缺失能力要禁用或明确说明，不静默吞参数。
- 能力边界测试覆盖“缺回调不显示成功、缺 count 不发请求”。
- 不把“能力边界”写成“已支持”。

### P2：其它已知限制

- 远端文件编辑器没有外部变更订阅；只有保存冲突或手动 reload 才发现文件被改。
- 本机/WSL 文件树没有通用文件系统监听；Agent 直接写文件后可能滞后。
- WSL 文件 IO 走 UNC，内容索引关闭；`/mnt` 权限、性能、回收站语义没有完整验收。
- WSL 档案创建后不能编辑 label/distro/user，只能移除重建。
- 远端名称搜索有深度/扫描上限，深层文件可能搜不到；有截断提示但不是完整搜索。

## 5. 团队分工

### Tech Lead

职责：

- 维护总计划和依赖顺序。
- 唯一修改公共汇聚文件的人：`src/main/index.ts`、`src/shared/ipc.ts`、`src/preload/index.ts`、`src/shared/types/remoteHost.ts` 等。
- 负责分支合并、冲突解决、最终门禁。
- 不把 root 池化等大改放在 P0 之前。

### WS1：远端事实与刷新（关键路径）

负责：

- P0-1 Git 写 → 文件树失效
- P0-2 文件写 → Git status 失效
- P0-3 Git status 轮询
- P0-4 深层目录订阅
- P2 远端编辑器外部变更提示（可与 P0 分开提交）

主要文件：

- `src/main/ipc/remoteProjectIpc.ts`（**唯一写者**）
- `src/main/ipc/remoteGitReadIpc.ts`
- `src/main/remote/RemoteDirWatchRegistry.ts`
- `src/main/remote/RemoteFactsNotifications.ts`
- `src/main/git/RemoteGitSnapshotFacts.ts`
- `src/renderer/src/hooks/useRemoteGitView.ts`
- `src/renderer/src/utils/remoteGitFactsSubscription.ts`
- `src/renderer/src/utils/lazyDirTree.ts`
- `src/renderer/src/components/workspace/RemoteGitPanel.tsx`
- `src/renderer/src/hooks/useRemoteFileDraft.ts`

注意：

- `remoteProjectIpc.ts` 当前约 348 行，红线 400；加逻辑前先设计拆分。
- 该文件含字面 NUL，grep 需要 `-a`。
- 不要用“每次根事件重读整棵树”掩盖问题；必须区分根事件、目录 scope、Git 写 scope。
- 现有 `tests/remoteFactInvalidationRace.test.mjs`、`remoteFactsNotificationLoop.test.mjs`、`remoteDirWatchLifecycle.test.mjs` 必须保持绿。

### WS2：WSL 配置作用域

负责：

- `PiConfigTarget` 增加 WSL 目标。
- 主进程目标解析、路径解析、读取/写入路由。
- 设置页目标选择器和来源提示。
- 技能/提示词/扩展页第一阶段明确标注。

主要文件：

- `src/shared/piConfig.ts`
- `src/main/config/piConfigTarget.ts`
- `src/main/config/PiConfigRouter.ts`
- `src/main/config/ConfigManager.ts`
- `src/main/ipc/systemIpc.ts`
- `src/main/wsl/WslHostStore.ts`
- `src/main/wsl/WslProjectEnvironment.ts`
- `src/renderer/src/ConfigModal.tsx`（**唯一写者**）
- `src/renderer/src/config/PiConfigTargetSelector.tsx`

注意：

- 不要让 `configureWsl` 的全局副作用复活；并发窗口会互相污染。
- 只先做 `models.json` / `settings.json`；技能/提示词/扩展完整作用域另立卡。
- 没有 WSL 档案或发行版停止时要给稳定码，不要回退到 Windows 配置。

### WS3：搜索与能力边界 UI

负责：

- 远端/WSL 内容搜索“仅文件名”提示。
- 远端 Git/pi-only/上传限制的能力提示。
- 相关 i18n 和 UI 测试。

主要文件：

- `src/renderer/src/hooks/useFileSearch.ts`
- `src/renderer/src/components/session/FileSearchResults.tsx`
- `src/renderer/src/components/workspace/RemoteGitPanel.tsx`（与 WS1 协调，同一时刻只一个写者）
- `src/renderer/src/i18n/rendererCopy.zh-CN.ts`
- `src/renderer/src/i18n/rendererCopy.en-US.ts`
- 生成物 `*.zh-TW.ts` 由脚本生成

注意：

- 改 zh-CN 后必须运行 `node scripts/genZhTwCopy.mjs`。
- 不在 JSX 硬编码中英文。
- 不把“缺失能力”显示成普通空状态。

### WS4：验证与真机证据

负责：

- 维护验证矩阵。
- 跑定向测试、集成门禁、真机 smoke。
- 记录通过/失败/跳过，不修改产品代码。
- 需要时写独立测试文件，不修改别人测试断言。

主要入口：

- `tests/`
- `e2e/remoteSessionAcceptance.spec.ts`
- `e2e/*` 相关 spec
- 验证记录放临时交接日志或最终汇报，不写发布材料

### WS5：同主机 root 池化设计

负责：

- 只做设计、测量和 ADR，不先改生产代码。
- 统计 root 切换耗时、失败、watcher 重建、并发场景。
- 给出“做/不做”的明确结论和迁移步骤。

## 6. 执行顺序与依赖

推荐并行：

1. Tech Lead 先固定基线、建立缺口矩阵和失败回归。
2. WS1 先做 P0-1/P0-2/P0-3，这是用户最容易看到的状态错误。
3. WS1 再做 P0-4 深层目录订阅，必须单独提交。
4. WS2 可立即并行做 WSL 配置目标，不依赖 WS1。
5. WS3 可并行做搜索/能力提示，但与 WS1 共享 `RemoteGitPanel.tsx` 时只能一个写者。
6. WS5 只做测量和设计，不阻塞 P0。
7. WS4 在各 workstream 完成后跑定向验证，最后做集成门禁。
8. 全部 P0/P1 稳定后，再由用户人工实测；不进入打包。

不建议的顺序：

- 先做 root 池化大重构。
- 先做远端内容搜索 helper 协议扩展。
- 为了“统一”重写 `RemoteGitPanel` 或 `GitPanel`。
- 用全量刷新掩盖 scope 设计问题。

## 7. 建议的实现方向

### 7.1 跨域事实失效

建议新增一个明确的整树失效 scope，例如：

```ts
{ kind: "tree" }
```

而不是把根目录 `dir` scope 当成“全树重载”，否则每次根文件变化都会重读所有已加载目录。

行为：

- 远端 Git 写成功/unknown：发布 status + tree。
- 远端文件写成功：失效项目 Git status 缓存，并发布 status。
- `lazyDirTree` 收到 tree scope：重读根和所有已加载目录，保留展开集和 currentDir。
- connection generation 变化：仍按现有逻辑整树重置。
- 目录 scope：只重读对应已加载目录。
- 根目录事件：只重读根，不自动重读全部深层目录。

缓存失效必须覆盖：

- 已完成缓存。
- 只有在途请求、没有缓存值的键。
- invalidate 后旧 flight 迟到写回。
- 写成功和 unknown 两条路径。

### 7.2 远端 Git status 轮询

在 `useRemoteGitView` 内新增低频静默刷新：

- 5 秒一次。
- 仅在 document visible、hostReady、无变更中时运行。
- 不自动 fetch。
- 单飞：上一次未完成不叠加。
- 面板卸载/隐藏立即停止。
- 不重置用户打开的 diff/history；如果现有 controller 会重置，先实现 `refreshStatus` 或加暂停条件。

测试至少覆盖：

- 可见且 ready 时触发。
- 隐藏/离线/变更中不触发。
- 一次只发一个请求。
- 卸载后不再触发。
- 不调用 fetch。

### 7.3 深层目录订阅

在每个目录页成功读取后，把该相对路径登记到 `RemoteDirWatchRegistry`：

- 根目录已有。
- 已加载目录按需增加。
- 使用稳定的 `session.connectionId`，不要用每次新建的 session 包装对象。
- 目录路径去重；重复读取不重复建 watcher。
- 4 个 watcher × 32 路径上限在发请求前判断。
- 超限时给明确降级状态，不静默假装覆盖。
- root 切换、断连、项目关闭、窗口销毁时成对退订或换代。
- 旧 watchId 事件不得命中新会话。

测试至少覆盖：

- 33 个路径分到两个 watcher。
- 第 5 个 watcher 被拒绝。
- 换会话后旧事件被忽略。
- 项目关闭只退订该项目。
- 断连后不再发读。

### 7.4 WSL 配置目标

建议形状：

```ts
type PiConfigTarget =
  | { kind: "local" }
  | { kind: "ssh"; hostId: string }
  | { kind: "wsl"; hostId: string };
```

主进程：

- 校验 hostId。
- 从 `WslHostStore` 找到档案。
- 解析 `WslEnvironment.windowsHome`。
- 配置目录为发行版 HOME 下的 `.pi/agent`。
- 读取/写入使用现有 ConfigManager 的文件逻辑，但按目标实例化或显式传 configDir。
- 不使用全局 `configureWsl` 修改单例。
- 发行版停止/路径不可读时返回稳定码。

UI：

- Windows 才显示 WSL 选项。
- 目标选择器展示档案 label、distro、user。
- 明确显示当前编辑的是哪个 HOME。
- 读取/写入冲突保留草稿和重载入口。

### 7.5 内容搜索边界

第一阶段：

- `useFileSearch` 增加 `contentSearchSupported` 或从项目位置推导。
- 远端/WSL 为 false。
- 不调用 `files.searchContent`。
- 文件搜索 UI 显示“仅文件名”提示。
- 不渲染内容分区和 spinner。

第二阶段（可选，单独卡）：

- 远端 helper 增加有界 `fs.searchContent`。
- 必须处理：最大扫描文件数、最大字节数、二进制拒绝、UTF-8 校验、取消、超时、截断。
- 完成前不放开内容分区。

### 7.6 root 池化

只做设计，不先写生产代码：

- 统计两个远端项目交替读取时的 root 切换次数、耗时、失败码。
- 统计 watcher 重建次数。
- 评估按 `${hostId}:${root}` 复用 helper 的容量、内存和清理成本。
- 给出阶段化迁移方案；未获批准不替换现有单 root。

## 8. 验证矩阵

每个工作流至少跑：

```bash
npm run typecheck
node --test tests/<相关>.test.mjs
```

涉及 IPC/共享契约：

```bash
npm run check:ipc-wiring
```

涉及格式/UI：

```bash
npm run check:format
```

涉及测试形状：

```bash
npm run check:test-shape
```

集成阶段：

```bash
npm test
```

规则：

- 命令不要用管道吞退出码。
- 定向测试优先，不要每个小改动跑全量。
- 全量 `npm test` 只在集成/合并前跑一次。
- 已知基线是 0 fail；出现失败必须查根因，不能直接归为“基线问题”。
- 不为了让新代码通过而修改现有测试断言。
- 新增行为优先补运行时/行为测试，不新增纯源码形状测试；已有例外账本 `docs/release-test-shape-exceptions.md` 不继续扩大。

远端真机：

- 凭据通过 `PIDECK_E2E_REMOTE_HOST/USER/PORT/FINGERPRINT` 提供。
- 不把值写入仓库或日志。
- 使用 `npx playwright test e2e/remoteSessionAcceptance.spec.ts --grep "<场景>"` 分段跑。
- 15 处 `test.skip` 是凭据门控；没有凭据就是未验证，不能算通过。
- 合并后全量远端 E2E 未完成，接手团队必须重新跑相关场景。

WSL：

- 当前只有 `Ubuntu-26.04`（Stopped）。
- 没有用户授权不要安装第二个发行版。
- 双发行版、停发行版、档案移除属于待补 smoke，不是已通过项。

macOS：

- 没有本机证据；不要让 agent 声称已验证。

E2E 若需要最新 `out`，由验证 owner 运行 `npx electron-vite build`，仅作为测试准备；不要运行 `npm run build`、`preflight`、`pack`。

## 9. 风险与回滚

| 风险 | 处理 |
|---|---|
| 跨域失效导致读放大 | 用 tree scope 只对 Git 写触发，不用根事件触发全树 |
| 5 秒轮询增加 SSH 压力 | 可见/ready/非变更中才跑，单飞，不 fetch |
| 深层 watch 超过 4×32 | 发请求前判上限，明确降级 |
| WSL 配置并发污染 | 不复活全局 `configureWsl`，按目标隔离 |
| `remoteProjectIpc.ts` 超 400 行 | 先拆纯函数/读取模块，保持行为不变 |
| 新 scope 破坏旧消费者 | 更新 shared contract、preload、所有订阅者、测试 |
| 自动刷新重置 diff | 刷新 status 不重置 history/diff/selection |
| 真机凭据泄露 | 只从环境读取，不打印，不写文档 |
| 并行 agent 冲突 | worktree；公共文件单写者；按目录划 ownership |

回滚原则：

- 每个 workstream 独立提交，便于单独 revert。
- 不把 P0 和 root 池化混在一个提交。
- 不用 `git reset --hard` / `git clean` / `stash` 清理现场。
- 不改无关文件来“顺手修复”。

## 10. 交接与完成标准

每个 workstream 完成时必须提交：

- 修改文件清单。
- 失败回归用例和修复说明。
- 运行的命令与退出码。
- 通过项、失败项、跳过项。
- 已知风险和未覆盖场景。

Tech Lead 合并前检查：

- 工作树只包含本任务文件。
- 公共文件没有并行写者残留。
- 定向测试全绿。
- `typecheck`、`check:format`、`check:test-shape`、`check:ipc-wiring` 按改动范围通过。
- 全量 `npm test` 在集成阶段通过。
- 没有打包产物、没有 push、没有改发布材料。
- 真机未跑的场景明确写“未验证”，不写成通过。

最终交付给用户的不是发布包，而是：

- 功能缺口修复清单。
- 证据和未验证项。
- 可供用户人工实测的稳定构建/运行方式。
- 下一轮（如果需要）的具体剩余项。

## 11. 给接手 Agent 的启动提示词

你是 PiDeck SSH/WSL 功能收敛的 Tech Lead。先完整阅读本文件，再阅读仓库根 `AGENTS.md` 和 `docs/architecture.md`、`docs/host-boundaries.md`、`docs/engineering-standards.md`。

你的任务不是发布，而是修掉 P0/P1 状态与作用域缺口，保持现有测试绿，并给用户人工实测留下清晰证据。不要 push，不要打包，不要写发布材料。

先核对 `git status`、`git log`、`git rev-list --left-right --count origin/dev...HEAD`；如果工作树不干净或基线不同，先报告。按工作流拆分团队：WS1 远端事实与刷新，WS2 WSL 配置作用域，WS3 搜索与能力边界 UI，WS4 验证，WS5 root 池化设计。两个以上 agent 改 `src/` 必须用 worktree；`src/main/ipc/remoteProjectIpc.ts`、`src/main/index.ts`、`src/shared/ipc.ts`、preload、i18n 生成物等公共文件同一时刻只能有一个写者。

每个工作流先补失败回归，再实现；只跑定向测试与 `typecheck`，集成阶段再跑全量门禁。真机凭据只从环境读取，不打印；没有凭据的测试标记为未验证。WSL 当前只有一个发行版，不要自行安装第二个。完成后按 §10 汇报，不要自行 push 或打包。
