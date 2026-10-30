# SSH/WSL 功能收敛 — 远端验证记录（WS4）

> 分支 `feat/ws4-verify` · 本轮 smoke 运行在提交 `46523b525`（`dev` 合入 WS1 之前的基线）· 记录时间 2026-10-30 · 作者 WS4。
> 本文件只记录证据，不改产品代码；**跳过 / 未运行 = 未验证，绝不算通过**。
> 安全口径：主机名 / 用户名 / 指纹 / 私钥一律不写入本文件，也不打印到终端；凭据只在 PowerShell 进程内以 `$env:PIDECK_E2E_REMOTE_*` 形式存在。

## 0. 记录口径

- 门禁命令禁止用管道吞退出码，统一写成：`$o = & npm run xxx 2>&1; $rc = $LASTEXITCODE; $o | Select-Object -Last 20; "EXIT=$rc"`。
- 所有远端 E2E 都用同一个包装脚本 `%TEMP%\pideck-ws4-remote.ps1`（派生凭据 → 清环境变量 → 跑 Playwright → 输出脱敏日志），**脚本在 `%TEMP%`，不入库、不含任何凭据值**。
- 真实 Electron（`out/main/index.js`）+ 真实主机；跳过与未运行分开记，都不进通过统计。

## 1. 环境前提（跑 E2E 前必须做）

| # | 前提 | 说明 |
|---|------|------|
| 1 | **清除 `ELECTRON_RUN_AS_NODE`** | 在「Electron 宿主里的 agent 会话」中直接跑 Playwright 会失败：`electron.launch: Process failed to launch!` + `electron.exe: bad option: --remote-debugging-port=0`。根因是宿主进程环境带 `ELECTRON_RUN_AS_NODE=1`，`electron.exe` 退化成纯 Node，拒绝 Chromium 开关。**跑前必须同一进程 `Remove-Item Env:ELECTRON_RUN_AS_NODE`**（本记录的统一包装脚本已处理）。这是宿主环境特性，不是产品缺陷；普通终端 / CI 无此变量。 |
| 2 | 先把 `out/main/index.js` 构建出来 | E2E 直接启动未打包产物；本轮用 `npx electron-vite build`（**仅测试准备**，不是 `npm run build`，不打包、不发布）。 |
| 3 | 凭据只走进程环境变量 | `PIDECK_E2E_REMOTE_HOST/USER/PORT/FINGERPRINT`；缺任意一个，spec 在 fixture setup 前整体 skip（不会启动 Electron），此时结论必须记「未验证」而不是「通过」。 |

## 2. 远端环境事实（不含主机名 / 用户 / 指纹）

| 项 | 事实 |
|----|------|
| 连通方式 | 本机 SSH 配置别名 `serve` 可免密（BatchMode）登录；该别名配了 ProxyJump，故**本机直接 `ssh-keyscan` 不可用**，指纹从 `~/.ssh/known_hosts` 取并与「经跳板在远端本机 `ssh-keyscan 127.0.0.1`」交叉核对一致 |
| 系统 | Linux |
| 远端 `git` | ✅ 存在 |
| 远端 `node` | PATH 上默认是 **v12.22.9**（旧），nvm 另有 **v24.11.0** |
| 远端 `pi` | **不在默认 PATH**，只存在于 nvm 目录（`~/.nvm/versions/node/v24.11.0/bin/pi`）；`~/.pi` 存在 |
| 产品侧解析 | ✅ 产品自动解析到 nvm 里的 pi（第 5 节 smoke 的主进程日志 `Pi process exit` 显示启动的是 nvm 路径的 pi），不需要人工改远端 PATH |
| 主机密钥算法 | 产品强制 `HostKeyAlgorithms=ssh-ed25519`；取到的 ED25519 指纹与产品落盘 pin 一致（smoke 断言通过即为证） |

派生命令（值不打印）：`ssh -G serve` → `ssh-keygen -F <host-key> -f ~/.ssh/known_hosts` → `ssh-keygen -lf -`（必要时经跳板 `ssh serve 'ssh-keyscan -t ed25519 -p 22 127.0.0.1'`）→ 直连连通性 `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -p <port> <user>@<host> 'echo DIRECT_OK'`（exit 0）。

## 3. 基线提交对应关系（区分"修复前 / 修复后"）

| 角色 | 提交 | 说明 |
|------|------|------|
| **本轮 smoke 实际运行的代码** | `46523b525` | `feat/ws4-verify` 的基点；`dev` 合入 WS1 之前，**不含任何 P0 修复** |
| Lead 通报的 dev（含 WS1 P0-1 + 装配） | `50b4f7dc3` | 仅记录，未在本分支运行 |
| 写本记录时只读查看的 dev HEAD | `a5b833b39` | `fix(remote): 装配文件写后 Git status 失效`（P0-2 已并入）；dev 仍在前进，集成以合并点为准 |
| 集成阶段（dev 合并 WS1/WS2/WS3 后） | 待补 | 同一批命令重跑，逐项对比"修复前 / 修复后" |

> 读法：第 5 节的 3 条 smoke 结论只代表 `46523b525`。WS1 的 P0-2/P0-3/P0-4 合并后再跑同一批 `--grep`，才能得出"修复后"结论；两轮记录放在一起即可对比。

## 4. 本地基线门禁（`feat/ws4-verify` @ `46523b525`）

| 命令 | 退出码 | 结论 | 备注 |
|------|--------|------|------|
| `npm run typecheck` | 0 | 通过 | 与 Lead 已跑结果一致 |
| `npm run check:ipc-wiring` | 0 | 通过 | 795 个 ipcChannels 齐备、agentEventTags 8、无重复 |
| `npm run check:test-shape` | 0 | 通过 | sourceOnly 407 / 1762 个测试文件（基线 407，新增 0） |
| `npm run check:format` | 0 | 通过 | 4116 文件、无差异 |
| `npx electron-vite build`（**仅 E2E 测试准备**） | 0 | 通过 | 59.44s，产物仅 `out/`（入库忽略）；未跑 `npm run build` / `preflight` / `pack` |

## 5. 远端 E2E 用例清单与状态（`e2e/remoteSessionAcceptance.spec.ts`）

`npx playwright test e2e/remoteSessionAcceptance.spec.ts --list` ⇒ **16 tests in 1 file**（exit 0）。
远端 E2E 合计 18 条：本 spec 16 条 + `remoteHostAcceptance.spec.ts` 1 条（基线补跑结果见 5.2）+ `remoteFunctionalAcceptance.spec.ts` 1 条（**未运行**）。

| # | 用例（行号） | 命令（除第 1 列外均经统一包装脚本） | 退出码 | 时长 | 结论 |
|---|--------------|--------------------------------------|--------|------|------|
| 1 | 远端会话产品路：新建 → 发 prompt 出正文 → 关闭 Agent → 重开历史仍在（324） | `npx playwright test e2e/remoteSessionAcceptance.spec.ts --grep "远端会话产品路"` | 1 | 6.1m | **baseline-fail / 待复跑区分**（失败点见 5.1；前 12 个 step 已通过） |
| 2 | 远端代码文件：UI 编辑保存 → 外部冲突保留草稿 → 双项目隔离 → Agent 真实运行测试（661） | 同形（`--grep`） | — | — | 未验证（未运行） |
| 3 | 远端 Git G1：只读 SCM 与差异 → 双项目隔离 → 断开不重连 → Git 字节不变（723） | `--grep "远端 Git G1"` | 0 | 1.3m | **通过** |
| 4 | 远端 Git G2a/G2b：精确暂存取消 → 提交已确认暂存区 → 拒绝面 → unborn 与工作区不变（751） | 同上 | — | — | 未验证（未运行） |
| 5 | 远端 Git G3a：只读历史分页与详情 → 引用 → 两版本差异 → 仓库字节不变（780） | 同上 | — | — | 未验证（未运行） |
| 6 | 远端 Git G3b：新建分支 → 切换 → 工作区冲突拒绝不丢文件 → 只多一个 ref（805） | 同上 | — | — | 未验证（未运行） |
| 7 | 远端 Git G4a：丢弃工作区改动 → 删除未跟踪文件 → 先备份后可恢复（830） | 同上 | — | — | 未验证（未运行） |
| 8 | 远端 Git G4b：丢弃留快照 → 恢复区列出 → 一键还原字节一致（855） | 同上 | — | — | 未验证（未运行） |
| 9 | 远端 Git G5a：获取更新远端跟踪引用 → 拉取快进 → 脏工作区拒绝 → 推送（880） | 同上 | — | — | 未验证（未运行） |
| 10 | 远端 Git G5b：引用对比与原生 diff 一致 → 逐文件两侧内容 → 轮询策略（905） | 同上 | — | — | 未验证（未运行） |
| 11 | 远端 Git G5c：非仓库根显式初始化 → 原生 .git 出现 → 初始化入口消失（932） | 同上 | — | — | 未验证（未运行） |
| 12 | 远端文件管理 v1：新建空项目 → 新建/改名/移动/删除+回收站还原/清空（959） | 同上 | — | — | 未验证（未运行） |
| 13 | 远端 Git G5d/G5e：仓库发现与 scope → 嵌套读取匹配原生 → 嵌套写控件（993） | 同上 | — | — | 未验证（未运行） |
| 14 | G6b opt-in real SSH soak：真实 SSH 长稳 → 连接中断恢复不重放（1023） | 需显式 opt-in 开关 | — | — | 未验证（opt-in，未运行） |
| 15 | 远端终端：项目隔离 → 已保存代码测试 → resize → 关闭/断开/退出清理（1050） | 同上 | — | — | 未验证（未运行） |
| 16 | 远端会话的 trust 提示（远端项目资源未加载）在 runtime 起来后可见（1096） | `--grep "远端会话的 trust 提示"` | 0 | 1.0m | **通过** |

**统计：2 通过 / 1 失败 / 13 未验证（跳过=未验证）。**

### 5.1 基线失败（baseline-fail / 待复跑区分）：#1 产品路

> 定性：该 run 在 `46523b525`（早于全部 P0 修复），**不归因于本轮任何改动**，也不在本轮修复。
> 处置：合并 `dev` 后重跑同一条 `--grep`；仍失败则由 Lead 作为**独立缺陷**写进最终汇报（handoff 规则：不顺手修无关缺陷，只记录）。

- **失败 step**：`远端并发冲突：上传期间外部追加必须保留，UI 提示重载且不自动覆盖`（`e2e/remote-history-mutations.ts:92`，由 spec:616 调用）。
- **失败摘要**：`expect(locator).toBeVisible() failed` → `getByText(/远端会话文件已被其他程序修改/)` 在 240s 内未出现（`element(s) not found`）。
- **同一步已通过的断言**：注入本身成功（`injected[0].stdout` 含 `REMOTE_WRITE_CONFLICT_INJECTED`），即「上传期间外部追加」确实发生了。
- **主进程日志（唯一相关一条，已脱敏）**：
  ```json
  {"level":"warn","scope":"session-command","message":"Session command failed (SESSION_COMMAND_FAILED)",
   "detail":{"code":"SESSION_COMMAND_FAILED","debugDetails":"SSH_HOST_COMMAND_TIMEOUT",
             "operation":"editCatalogMessage","messageId":"_viewer-history-7d32f397"}}
  ```
  ⇒ 该次保存走的是**远端命令超时**分支（`src/main/remote/SshClientRuntime.ts:121`），不是冲突分支；UI 文案 key `sessionCommand.remoteFileChanged` 本身存在。
- **失败前已通过的 step（同一条用例内，按 spec 顺序）**：项目目录前置 → 加主机 + 落盘 pin 命中 → 连接 ready → 登记远端项目 → 新建会话 → **发 prompt 出正文且回合结束** → 远端模型目录拉取 → 运行中拒绝归档 → 「关闭 Agent」回到可启动 → 关标签页重开历史仍在（含远端会话文件行数佐证）→ 「从磁盘重新加载消息」历史仍在 → 远端归档/恢复（文件 sha256 不变）→ Fork 换绑且原文件字节不变。
- **复现命令**：
  ```powershell
  & "$env:TEMP\pideck-ws4-remote.ps1" -Grep "远端会话产品路"
  ```
- **判定建议**：可能是「192KiB 大块改写 + CAS 校验」在这条链路上超过远端命令超时（超时后提示走 unknown 分支），也可能是冲突检测真的没命中。**本轮只记录、不修**；WS1 合并后重跑同一 `--grep` 可区分「修复前/修复后」，再由 Lead 决定是否单开缺陷。
- **证据留存**：Playwright `test-results/...`（含 trace / screenshot / error-context，均在本地、不入库）；主进程日志副本 `%TEMP%\p42-app-logs-<runId>\`。

### 5.2 另一条远端 spec 的基线补跑：`remoteHostAcceptance`（同为 baseline-fail，但成因是**既有 spec 过时**）

| 项 | 内容 |
|----|------|
| 命令 | `& "$env:TEMP\pideck-ws4-remote.ps1" -Spec "e2e/remoteHostAcceptance.spec.ts" -Grep "远端主机功能级验收"` |
| 退出码 / 时长 | 1 / 39.9s |
| 结论 | **失败（baseline-fail；既有 e2e 选择器过时，不是产品缺陷）** |
| 失败点 | 「设置页加主机：ssh config 候选中挑出目标 user@host…」——`e2e/remoteHostAcceptance.spec.ts:171` |
| 失败摘要 | `locator.click: Timeout 30000ms exceeded`，等不到 `.settings-modal` 内 `getByRole("button", { name: "添加", exact: true })` |
| 成因判定 | 设置页「连接」页签的入口按钮现在用的是 `settings.connections.new` =「新建连接」（`src/renderer/src/components/app/settings/ConnectionsTab.tsx:283`）；这条旧 spec 仍用精确名「添加」。较新的 `remoteSessionAcceptance.spec.ts:203` 已改成 `/^(添加|新建连接)$/` 兼容两种文案，所以同一操作在那边能通过。 |
| 处置 | 按 handoff 规则**不顺手修无关缺陷、不改既有断言**，只记录；该 spec 其余 12 步（连接 ready、双项目、会话列表/标题/导入、项目级 root 状态）**未验证**。 |

## 6. 未覆盖 / 风险

- 16 条远端会话用例只跑了 3 条；13 条**未验证**。另有 `remoteHostAcceptance`（已跑、失败，成因是旧 spec 选择器过时，见 5.2）与 `remoteFunctionalAcceptance`（未跑）。历史通过结论不适用于当前基线。
- `#1 产品路` 记为 **baseline-fail / 待复跑区分**：其中"新建→发送→出正文→关闭→重开历史"这条主链路已验证通过，失败只发生在后续的「并发冲突提示」子步骤；该结论属 `46523b525` 基线，不归因于 WS1/WS2/WS3 的改动。
- 本轮基线**不含** P0-1～P0-4 与 P1 任何修复，因此通过项只证明「存量主路径可用」，不证明缺口已修。
- WSL 侧（`Ubuntu-26.04`）无实机证据；macOS 无本机证据，不声称已验证。
- 全量远端 E2E 连续串跑未执行；全量 `npm test` 按分工留到集成阶段（Lead 统一跑）。

## 7. 复跑方法（不落凭据）

```powershell
# 只验证凭据派生链路（不打印任何值）
& "$env:TEMP\pideck-ws4-remote.ps1" -ProbeOnly     # 期望：ENV_READY host=True user=True port=True fp=True
# 跑单条用例
& "$env:TEMP\pideck-ws4-remote.ps1" -Grep "远端 Git G1"
```

包装脚本做的事：`ssh -G serve` 取 host/user/port → `ssh-keygen -F`（必要时经跳板 `ssh-keyscan`）取 ED25519 指纹 → 写入当前进程环境变量 → `Remove-Item Env:ELECTRON_RUN_AS_NODE` → `npx playwright test e2e/remoteSessionAcceptance.spec.ts --grep <pattern>` → 输出脱敏日志（脱敏后落到 `%TEMP%`，不入库）。

## 8. 更新记录

- 2026-10-30（`46523b525`）：建立本记录。本地 5 项基线门禁全绿；远端 smoke 3 条 → 2 通过（Git G1、trust 提示）/ 1 失败（产品路的并发冲突子步骤，定性 baseline-fail / 待复跑区分）/ 13 未验证；定位并规避 `ELECTRON_RUN_AS_NODE` 环境坑。
- 2026-10-30（`46523b525`，补跑）：`remoteHostAcceptance` 基线跑 → 失败，成因为旧 spec 选择器过时（`添加` vs 现行「新建连接」），非产品缺陷；已记入 5.2，未改任何断言。
