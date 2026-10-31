# 会话交接：root 池化生产实现（B0–B4）

> **Status: Active plan（2026-10-31 核对；执行前以当前代码与 HEAD 为准）**


> 用途：把「同主机多项目 root 池化」的生产实现交给新会话。设计权威是
> `docs/remote-host-root-pooling-adr.md`（已含现状 file:line、方案对比、B0–B5 迁移、回滚、验证矩阵、真机测量）。
> 本文件只补“开工须知”，不重复 ADR 内容。

## 0. 状态

- 仓库：`F:\PiDeck`，主工作树在 `dev`。
- 本任务起点：`dev` = `f6f4eeaf6`（已合入 origin/dev 商业化 UI Wave 1–7、ACP/DSH/EasyTier 与工作区面板服务缝 Phase A）。
- 远端：`origin` = github.com/ayuayue/PiDeck。origin/dev 已合入；若开工时 HEAD 已变化，以实际 `git log` 为准。
- 本轮只交付了 ADR + 探针（`docs/remote-host-root-pooling-adr.md`、`tests/remoteRootSwitchProbe.mjs`），**生产代码零改动**。
- 历史工作 worktree（w1–w4/v/ws1–ws4）已清理；只剩 `F:\PiDeck`、`F:\PiDeck-cloud-sync`、`F:\PiDeck-remote`（后两个属其他工作流，勿动）。

## 1. 先读（按顺序）

1. `AGENTS.md`
2. `docs/remote-host-root-pooling-adr.md`（§2 现状、§3 容量/失败、§4 测量、§5 B0–B5、§6 验证矩阵、§7 决定）
3. `docs/architecture.md`、`docs/engineering-standards.md`、`docs/host-boundaries.md`
4. `docs/remote-wsl-verification-log.md` 的 §9/§11/§14（既有全量/E2E 口径与远端基础设施）

## 2. 任务

按 ADR §5.3 实现 **B0–B4**（B5 可选，不在本任务内）：

- **B0 测量基线**：补 ADR §4.4 的未测量项（service 级耗时、换代后 N 目录重读/4×32 rewatch、真实 drift/断链/rebind 失败注入、N>2 内存、渲染层感知；WSL/macOS 不测），把探针纳入文档流程并定门槛：**热命中 < 50 ms、N=2 远端常驻 ≤ ~120 MiB、无跨 root 串读**。
- **B1 影子池（默认关闭）**：新增 main 私有 `RemoteRootSessionPool`（feature flag/构造参数），旧单会话路径保留为默认；指标：acquire hit/miss、创建/淘汰次数、每 root operation 等待、SSH/节点发现次数。**不改协议、不改持久化**。
- **B2 路由与锁**：`withProjectSession` 改为 pool-backed；per-(host,root) 锁；同 root 合并；**flag=off 时旧行为逐字节保持**。
- **B3 watcher/facts**：`RemoteDirWatchRegistry` 键升级为 host + sessionKey；facts 仍按 `connectionId` 换代；`lazyDirTree` 不因兄弟项目换 root 清树。
- **B4 默认开启**：设置项/诊断（池条目、命中率、内存/连接数）+ 真机 A/B 交替验收；不达标回退 flag。

**第一步只做计划**：复述 §5.2 池形状与 B0–B4，列出每步改动文件、测试、回滚点、门槛，交用户审核后再写代码。

## 3. 硬约束

- 不 push / 不 merge 到远端 / 不发布（除非用户明确要求）；不跑 `npm run build` / `preflight` / `pack`；不装依赖；不升级 Electron/pi；不改 pi 活着的会话 JSONL。
- 不清理/暂存/重置他人未提交工作；跨目录写用 `git worktree`。
- TDD 红→绿；**不改/放宽既有断言**（存量写法过时单独开任务）；每条通道改动的测试先红后绿。
- 门禁：`npm run typecheck` + 针对性 `node --test` + `check:ipc-wiring` + `check:test-shape` + `check:format`；全量 `npm test` 只在阶段集成时跑（约 7–13 分钟，交叉安装可能更慢）。
- 生成物：改 zh-CN 文案后跑 `node scripts/genZhTwCopy.mjs`，`*.zh-TW.ts` 不手改；Lead 统一重生成。
- 团队上限 8；每个写任务用独立 worktree；公共汇聚文件（`main/index.ts`、i18n copy、`package.json`）同一时刻只许一个写者。

## 4. 环境与工具

- 远端主机：`ssh` 别名 `serve`（已免密）；E2E 凭据只经 `PIDECK_E2E_REMOTE_*` 进程内注入，不打印、不落库。
- 跑 Electron E2E 前：`Remove-Item Env:ELECTRON_RUN_AS_NODE`；窗口默认屏幕外。
- 现有探针：`node tests/remoteRootSwitchProbe.mjs`（无凭据时输出 `not-measured`，不编数据）。
- 既有远端 E2E：`e2e/remoteSessionAcceptance.spec.ts`（16 条）、`e2e/remoteHostAcceptance.spec.ts`、`e2e/remoteFunctionalAcceptance.spec.ts`；同一时刻只跑一条 Electron 用例。

## 5. 已知数据（ADR §4，可直接引用）

真机（node v24.11.0、helper 1.25.0、5 cycles/0 helper 失败）：SSH 342ms、node 发现 703ms、root 复核 354ms、bundle verify 342ms、helper 启动→hello 405ms、完整 helper cycle 中位 874ms、**产品切换下界代理 1813ms**；单 helper 52.4MiB RSS / 7 线程；双 helper 共存 104.9MiB、各自 SSH 连接。

## 6. 与远端分叉的处理

`origin/dev` 已有 48 个新提交（含 `package.json`、`src/main/index.ts`、`src/main/config/ConfigManager.ts`、`scripts/testShapeBaseline.json` 等）。**开新会话前先决定**：先把 `origin/dev` 合入 `dev`（冲突可能集中在 `main/index.ts`、`ConfigManager`、i18n、testShapeBaseline），还是从最新 `origin/dev` 起新分支做池化。不要直接 force-push `dev`。
