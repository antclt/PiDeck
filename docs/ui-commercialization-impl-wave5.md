# 商业化 UI/UX 统一 — Wave 5 实施记录（文件 / Git / 终端 / 浏览器工作台）

> 规划来源：`docs/ui-commercialization-plan.md` §Wave 5（第 318 行起）。
> 前序：Wave 1 `feec43b90`、Wave 2 `6fe435141`、Wave 3 `90b4dedcb`、Wave 4 `0956902bf`。

## 总览

| # | 域 | 改动 | 层级 |
|---|---|---|---|
| 1 | 文件 | Dirty tab 关闭保护（三条路径全 gate + 确认框） | P0 修缺 |
| 2 | 文件 | 保存失败可见化（role=alert 横幅 + 重试钮，与加载错误分离） | P0 修缺 |
| 3 | Git | 面板错误态补 alert 语义（对齐 RemoteGitPanel 基准） | P1 统一 |
| 4 | Git | 脏工作区切分支确认（git checkout carry 行为显式化） | P0 修缺 |
| 5 | 终端 | Tab 标题带 cwd 目录名（多 tab 区分第一诉求） | P1 统一 |
| 6 | 终端 | 退出态一键重开（同 shell/同 cwd 新建 + 关旧壳） | P1 统一 |
| 7 | 浏览器 | 设备菜单（自绘 absolute div）迁 Radix DropdownMenu | P1 统一 |

显式不做（与规划核对后判定，非遗漏）：

- **Panel Header/工具行硬抽**：GitPanel 工具行用 `--git-panel-*` CSS 变量主题化、Terminal 无 border-b——四域工具行结构差异大，硬抽会丢各域主题变量。保持各域自有，仅收敛行为语义（本轮已完成错误反馈/确认/退出态三项行为统一）。
- **空目录/无结果/错误三分**：文件树侧已在 Wave 1.8 落地（`FileTreeNode.loadError` + 重试钮）；Git/终端无「目录列表」语义，不适用。
- **浏览器 did-fail-load 非 -3 错误页**：Wave 1.9 已落地（`browser.loadFailedTitle` + 重试）。

## 逐项说明

### 1. 文件域 A：Dirty tab 关闭保护

**问题**（规划施工 2）：关闭路径（Tab X / 内容区关闭钮 / simpleMode 关闭）直通 `closeEditorTab`，有未保存改动时静默丢失，无确认。

**实现**：
- `FileDiffViewer.tsx`：props 加 `onDirtyChange?: (dirty: boolean) => void`；内部 `reportDirty(next)`（dirty 翻转时才上报，不随击键）挂在全部 4 个 `setDirty` 点。
- `WorkbenchContent.tsx`：透传 `onDirtyChange(tab.id, dirty)` 到宿主。
- `hooks/useFileEditor.ts`：维护 `dirtyEditorTabIds`（ReadonlySet）+ ref 真值镜像；`markEditorTabDirty` / `isEditorTabDirty` 对外；`closeEditorTab` 关闭时摘除。
- `App.tsx`：`requestCloseEditorTab(id)` gate——非 dirty 直通；dirty 弹 `overlays.showConfirm`（danger，`editor.dirtyCloseTitle` / `editor.dirtyCloseMessage` 带 {file}）。`closeWorkbenchTab` / `onCloseEditorTab` / `onCloseEditor` 三条路径全部过 gate。

### 2. 文件域 B：保存失败可见化

**问题**（规划施工 2）：保存失败复用加载 `error`（占满正文），无 alert 语义、无重试入口。

**实现**：`FileDiffViewer.tsx` 新增独立 `saveError` state；`saveNow` catch 写 `saveError`（不再占正文），成功清空；编辑器顶渲染 `role=alert` 横幅（TriangleAlert + `editor.saveFailedBanner` {error} + 重试钮调 `saveNow()`——重试取 `contentRef` 最新内容，不重新加载覆盖草稿）。

### 3. Git 域：错误态 alert 语义

**问题**：本地 GitPanel 错误是一行变色小字（`text-[var(--git-conflict)]`），无读屏语义无截断 title；RemoteGitPanel 已有全套 `role=alert` 基准。

**实现**：`GitPanel.tsx` error 行升格 `role=alert` + TriangleAlert + truncate/title。

### 4. Git 域：脏工作区切分支确认

**问题**（规划施工 3）：下拉点分支直接 checkout。git 默认把未提交改动 carry 到目标分支——用户常不预期；失败路径有 toast 但成功路径的隐式携带完全静默。

**实现**：分支 click 先关下拉；`total > 0`（工作区未提交计数）时 `setPendingBranchSwitch` 弹 ConfirmDialog（danger，`git.branchSwitchConfirmTitle/Message{count}{branch}/Label`——文案明说 carry 行为与「先提交或回滚」出口）；干净区直接切。失败路径沿用既有 onSwitchError toast。

### 5. 终端域：Tab 标题带 cwd

**问题**（规划施工 4）：同 shell 多 tab 标题只有序号（`pwsh 2`），区分靠 buffer 内容。

**实现**：`TerminalSessionManager.create` 的 title 改 `` `${displayShell} ${seq} · ${cwdName}` ``（resolvedCwd 按路径分隔符取尾段）。

### 6. 终端域：退出态一键重开

**问题**：退出的 tab 只显示「· 已退出」，要重开得手选 shell 新建再手动关旧壳。

**实现**：`TerminalDock.tsx` exited tab 标签内嵌重开钮（span role=button tabIndex=0，button 内不能嵌 button；`addTab(tab.shell).then(() => closeTab(tab))`——同归属/同 cwd/同 shell；Enter/Space 键盘支持）。`terminal.reopen` / `terminal.reopenTitle`。

### 7. 浏览器域：设备菜单迁 Radix

**问题**（规划施工 1）：UA/设备菜单是手绘 absolute div + 手写 pointerdown 外点关闭——无 Esc、无焦点圈定、无 menu 语义。

**实现**：`BrowserPanel.tsx` 迁 `DropdownMenu/Trigger/Content/Item`（ui-shadcn 原语）；删 `deviceMenuOpen` state、`deviceMenuRef`、手写外点 effect（364 字节）。选中项 `bg-bg-active` 标记、触发钮 `data-[state=open]` 高亮保持。

## 测试

新增：

- `tests/fileEditorDirtyClose.test.mjs`（6）：dirty 上报/关闭 gate 三路径/保存失败横幅/关闭摘除/词典。
- `tests/browserDeviceMenu.test.mjs`（3）：Radix 原语/自绘痕迹清除/selectDevice 保留。

更新（同意图跟进实现，非放宽）：

- `tests/terminalTabTitleSeq.test.mjs`（4）：title 断言补 `· p1/proj` cwd 后缀。
- `tests/helpers/terminalDockHarness.mjs`：`isExited` 探测适应 exited children 从字符串改条件 JSX。
- `tests/browserPanelReadiness.test.mjs`：stub 表补 dropdown-menu 与 `@/lib/utils`（新 import 链）。

回归：terminalTabTitleSeq 4 / terminalDockLifecycle 26 / terminalDockState+CloseConfirm+Animation+EventScope 33 / gitPanel 全家 46 / browser 全家 18 / fileEditorDirtyClose 6 / browserDeviceMenu 3 / fileDiff 相关 27 / sessionFileEditor+workbench+editorTabs 64 —— **0 fail**。`tsc --noEmit` 全量 0 错。`git diff --check` 干净。

## 并行改动（他人，未动未提交）

`src/renderer/src/hooks/useSessionTimelineController.ts`（send-scroll 锚点 hunk）、`tests/sessionSendScroll.test.mjs`、`e2e/session-scroll-anchor.spec.ts`。

## 移交

- Wave 6（设置 22 Tab 语义统一）：本轮无涉及，全量待做。
- Wave 7（弹窗收尾）：WebPromptPicker 共享数据源（规划 §361）待做。
- 终端搜索栏 UI（SearchAddon 已装配未持引用，`TerminalDock.tsx:377` 注释标记）：规划施工 4 的「搜索」项，UI 层待做。
