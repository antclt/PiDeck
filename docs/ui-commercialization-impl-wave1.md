# UI 商业化统一——第一轮实施结果（Wave 1 全量 + Wave 2 子集）

> 对应规划：`docs/ui-commercialization-plan.md`（Wave 0–8 分轮施工）。
> 本文档记录第一轮实际落地的改动、验证证据与未完成项移交。
> 状态：**Wave 1（P0 安全修缺）全部完成；Wave 2 完成可安全执行的子集；Wave 3–7 未启动**（依赖共享模式冻结后的分域并行改造，见 §5 移交）。

---

## 1. 本轮改动总览

| # | Wave | 问题（规划定位） | 修复文件 | 状态 |
|---|---|---|---|---|
| 1 | W1-P0 | SettingsModal 关闭/更新确认漏算 `videoGenDirty`/`acpDirty` | `components/app/settings/unsavedChangesSummary.ts`、`components/app/SettingsModal.tsx` | ✅ |
| 2 | W1-P0 | ConfigModal Raw 切源文件无脏草稿保护 | `src/renderer/src/ConfigModal.tsx` | ✅ |
| 3 | W1-P0 | DSH RawTab 切文件无保护 + 读失败回退空编辑器 + 保存失败仅 console | `src/renderer/src/config/DshConfigTab.tsx` | ✅ |
| 4 | W1-P0 | Dialog 可访问名称缺失（4 处） | `DshAgentToolsPanel.tsx`、`web/WebDshToolsPanel.tsx`、`SessionProxyDialog.tsx`、`SessionHistoryPanel.tsx` | ✅ |
| 5 | W1-P0 | ConfirmDialog onCancel 双触发 | `components/ui-shadcn/ConfirmDialog.tsx` | ✅ |
| 6 | W1-P0 | DataEnvMismatchDialog Esc 等同「继续使用」 | `components/app/DataEnvMismatchDialog.tsx` | ✅ |
| 7 | W1-P0 | 抽屉/BottomSheet 无焦点圈定；自绘 menu 无方向键；关闭控件不可键盘触达 | `components/motion/drawer.tsx`、`web/WebBottomSheet.tsx`、`components/workspace/ExternalEditorOverlay.tsx`、`components/overlays/AskPanelOverlay.tsx` | ✅ |
| 8 | W1-P0 | 文件树读取失败呈现为空目录、无重试 | `shared/types/session.ts`、`utils/fileTreeLazy.ts`、`hooks/files/useProjectFileTreeController.ts`、`components/session/FileTreeRows.tsx`、`components/session/WorkspaceSurface.tsx` | ✅ |
| 9 | W1-P0 | 浏览器 did-fail-load 仅处理 -3 | `components/app/BrowserPanel.tsx` | ✅ |
| 10 | W1-P0 | 危险确认分裂（普通 Dialog + destructive 按钮） | `components/session/RemoteProjectEntryDialogs.tsx` | ✅ |
| 11 | W2 | sonner 旁路绕过 showNotice | `settings/CustomThemeSection.tsx`、`wallpaper/WallpaperVideoLayer.tsx`、`hooks/useSessionTimelineController.ts` | ✅ |
| 12 | W2 | 工作台弹窗尺寸常量三处漂移 | 新建 `components/common/workbenchDialogSize.ts`；`SettingsModal.tsx`、`ConfigModal.tsx` 改引用 | ✅ |

## 2. 逐项说明

### 2.1 SettingsModal dirty 统计补全（W1）
- `SettingsUnsavedTabId` 补 `"videogen"`；`TAB_LABEL_KEYS` 补 `settings.tabs.videogen`。
- `summarizeSettingsUnsavedChanges`/`dirtySettingsTabIds` 新增 `videoGenDirty?` 入参并纳入摘要与 tab 黄点。
- `SettingsModal.tsx` 新增 `hasIndependentDraftsDirty = visionDraft.dirty || imageGenDirty || videoGenDirty || acpDirty`，`handleClose`/`savePendingChanges`/`handleInstallUpdate` 三处统一改用；`dirtyTabIds` 与 `unsavedSummary` 补 `videoGenDirty`。
- 回归测试：`tests/settingsUnsavedChangesSummary.test.mjs`（含新增用例「生视频/ACP 脏标记纳入关闭确认摘要与 tab 黄点」）。

### 2.2 Raw 编辑器草稿保护（W1）
- **ConfigModal（Pi 侧）**：`handleRawFileChange` 拆为 guard + `applyRawFileChange`；`config:raw` 有脏时先弹 ConfirmDialog（danger「放弃并切换」），确认后才加载新文件。新增 `pendingRawFile` state 与配套确认弹窗。
- **DshConfigTab（DSH 侧）**：Select 切文件改经 `handleFileChange`（脏 → `pendingFile` 确认弹窗）；读取失败不再回退空编辑器，显示 `role=alert` 错误面板 + 重试按钮（`retryTick` 驱动重载）；保存失败 `showNotice(t("config.dsh.rawSaveFailed", { file, error }))`，不再只 console.error。
- i18n 新 key：`config.rawSwitchTitle/rawSwitchMessage/rawSwitchConfirm/rawSaveFailed`、`config.dsh.rawReadFailed/rawSaveFailed`（zh-CN/en-US + 生成的 zh-TW）。

### 2.3 Dialog 可访问名称（W1）
- `DshAgentToolsPanel` / `WebDshToolsPanel`：补 `<DialogHeader className="sr-only"><DialogTitle>`（新 key `dshTools.title`）。
- `SessionProxyDialog`：手写 `<h2>` 改 `DialogTitle asChild`（保留视觉结构）。
- `SessionHistoryPanel`：空 `DialogTitle` 填 `drawer.historyTitle`。

### 2.4 确认弹窗语义（W1）
- **ConfirmDialog**：新增 `confirmedRef`——`onOpenChange(false)` 仅在非确认路径调 `onCancel`；确认按钮先置标记再 `onConfirm`；`AlertDialogCancel` 移除叠加 onClick。保证取消回调**单次触发**、确认不误触取消。
- **DataEnvMismatchDialog**：`onOpenChange={() => undefined}`——Esc/遮罩不再被解释为「继续使用」；两键均改显式 AlertDialogAction（退出保持 destructive）。「继续使用」不再挂在 AlertDialogCancel 上（其自带关闭语义与风险警告冲突）。

### 2.5 焦点与键盘（W1）
- `motion/drawer.tsx` 与 `web/WebBottomSheet.tsx`：打开后焦点圈定（Tab 循环 + 逃逸拉回），关闭/卸载归还先前焦点（`isConnected` 判定）。
- `ExternalEditorOverlay.tsx`：`role=menu` 补 ArrowUp/Down/Home/End 循环导航；打开时聚焦第一个 menuitem。
- `AskPanelOverlay.tsx`：关闭控件（嵌套 span 无法键盘触达）补 `Shift+Enter`/`Shift+Space` 快捷关闭，提示文案标注（`askPanel.closeKeyboardHint`）。

### 2.6 文件树错误态（W1）
- `FileTreeNode` 新增可选 `loadError?: string`；`markFileTreeLoadFailed(nodes, dir, error?)` 落错误信息。
- 三处 listing 失败点（restore/expand/drill）传入错误；目录行渲染 `role=alert` 错误行（图标 + `drawer.loadFailed` + `title=loadError` + 重试按钮）。
- 重试链路：`WorkspaceSurface` 两层（DrawerContent/FilesPanel）挂 `onRetryDirectory`（`latestPropsRef` 稳定引用，回退 `onToggleDirectory`）。

### 2.7 浏览器错误页（W1）
- `did-fail-load` 非 `-3` 主框架失败：记录 `{code, description, url}`，渲染统一错误页（`browser.loadFailedTitle` + url/描述 + 重试按钮 `reload()`）；`-3`（导航替换）保持静默。

### 2.8 危险确认统一（W1 → W2 模板）
- `RemoteProjectEntryDialogs` 的 **删除确认**与**清空回收站**从普通 Dialog 迁到 AlertDialog 模板：`AlertDialogCancel`（取消语义）+ destructive `AlertDialogAction`；`busy` 期间锁全部关闭与提交入口；错误区补 `role=alert`。全部 `data-testid` 与回调保持不变（E2E 零改动）。

### 2.9 Toast 收敛（W2）
- `CustomThemeSection.tsx`（9 处）、`WallpaperVideoLayer.tsx`（1 处 warning）、`useSessionTimelineController.ts`（1 处）全部迁 `showNotice(message, duration?, kind?)`。迁移后 renderer 内除 `utils/notice.ts` 与 `sonner.tsx` 外**无直接 sonner import**。

### 2.10 工作台弹窗尺寸常量（W2）
- 新建 `components/common/workbenchDialogSize.ts` 导出 `WORKBENCH_DIALOG_SIZE_CLASS`；`SettingsModal.tsx`/`ConfigModal.tsx` 原两份重复串改为引用。`ProjectResourcesModal.tsx` 高度策略不同（760px 封顶），保持自有覆盖（规划允许壳层差异）。

## 3. 验证证据

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（本轮各步后多次运行） | ✅ 通过（末期 node_modules 被外部工具破坏 `.bin` 后改用 `node node_modules/typescript/bin/tsc --noEmit` 全量跑，本任务全部改动文件 0 错误；残余 TS2307 均为依赖缺失的环境问题，与改动无关） |
| 针对性单测（按域） | ✅ 共 309 pass / 0 fail，覆盖：settingsUnsavedChangesSummary、configUnsavedChangesSummary、configDirtyMarks、remoteProjectEntryState、dataEnvIpc、dataEnvMarker、fileTreeLazy、fileTreeCompact、fileTreeDirectoryAttach、fileTreeGitStatus、customThemes、appearanceThemes、nativeTitlebarThemeSync、sessionFindJumpTarget、sessionFindInSession、dshSessionFind、browserPanelReadiness、browserPanelSecurity、agentMarketFilters、dshProviderHeadersSave、editorEditing、sessionProxyEntrypoints、sessionProxyPolicy、announcementDetailDrawerIsolation、askPanelContext/Geometry/HookContract、drawerHeaderAlignment、drawerWidthPersistence、externalPathOpenGate、layoutResizeAndDialogTimer |
| `node scripts/genZhTwCopy.mjs`（改 zh-CN 后） | ✅ 每次词典改动后运行 |
| `git diff --check` | ✅ 干净 |
| E2E | 未跑全量（并行 agent 占用环境 + node_modules 残缺）；`e2e/remote-file-management.ts` 依赖的 testid 与「无法恢复」文案已逐一核对保持不变 |

**环境注记**：会话中期 `node_modules/.bin` 与部分依赖目录（`@ai-sdk`、`@codemirror/*`、`@deepseek-ai/*`）被外部清理，`npm run typecheck` 与部分脚本失效。按项目铁律（并行期间不 `npm install`），改用 `node node_modules/typescript/bin/tsc --noEmit` 直跑完成验证。**建议在干净环境恢复依赖后重跑 `npm run typecheck` 确认。**

## 4. Wave 0 基线记录（并入本文档交付）

- 主页面清单与 Owner：规划 §5.1 表已列全（会话/文件/Git/终端/浏览器/设置等），本轮未改动页面结构，Owner 表随 Wave 3–7 分域改造建立。
- 待收敛数量基线：sonner 直连 import 迁移后为 0（除 notice.ts/sonner.tsx 本体）；工作台尺寸常量重复定义 3 → 1；危险确认分裂（RemoteProjectEntryDialogs）已收口；Dialog 无可访问名称的 4 处已清零。
- 键盘路径基线：抽屉/BottomSheet/ExternalEditorOverlay/AskPanelOverlay 已具备焦点圈定与键盘出口；其余页面键盘审计归 Wave 8。

## 5. 未完成项移交（Wave 2 剩余 + Wave 3–8）

按规划依赖关系 `Wave 2 共享模式 → Wave 3–7 分域 → Wave 8 验收`，以下按优先级移交：

1. **Wave 2 剩余**：Page/Panel Header、Toolbar、ResourceRow、AsyncState、TabChrome 五个共享模式的抽取（要求 ≥3 真实调用点）；五类 Dialog 模板化（本轮只落了尺寸常量与危险确认模板收敛）；Picker 统一（`PickerDialog` vs `CommandPickerPanel`）；MorphPopover `z-9999`/GitGraph `z-1800`/CUA `z-50` 的 z-layer 分级。
2. **Wave 3**：壳/导航/列表（AppShell/AppHeader/sidebar/SessionTabsBar 等）统一到共享模式。
3. **Wave 4**：会话/Composer 状态统一（布局冻结，只修状态）。
4. **Wave 5**：文件/Git/终端/浏览器工作台统一（本轮已落文件树错误态与浏览器错误页两块地基）。
5. **Wave 6**：设置 22 Tab 全量统一（本轮已落 dirty 统计补全与尺寸常量）。
6. **Wave 7**：弹窗收尾（本轮已落危险确认模板与可访问名称）。
7. **Wave 8**：视觉验收（Ink Workbench、字档/圆角校准、主题/对比度/键盘全检）。

## 6. 本轮新增/修改文件清单（本任务自身改动）

**修改**：
`src/renderer/src/components/app/settings/unsavedChangesSummary.ts`、`src/renderer/src/components/app/SettingsModal.tsx`、`src/renderer/src/ConfigModal.tsx`、`src/renderer/src/config/DshConfigTab.tsx`、`src/renderer/src/components/session/DshAgentToolsPanel.tsx`、`src/renderer/src/web/WebDshToolsPanel.tsx`、`src/renderer/src/components/session/SessionProxyDialog.tsx`、`src/renderer/src/components/session/SessionHistoryPanel.tsx`、`src/renderer/src/components/ui-shadcn/ConfirmDialog.tsx`、`src/renderer/src/components/app/DataEnvMismatchDialog.tsx`、`src/renderer/src/components/motion/drawer.tsx`、`src/renderer/src/web/WebBottomSheet.tsx`、`src/renderer/src/components/workspace/ExternalEditorOverlay.tsx`、`src/renderer/src/components/overlays/AskPanelOverlay.tsx`、`src/shared/types/session.ts`、`src/renderer/src/utils/fileTreeLazy.ts`、`src/renderer/src/hooks/files/useProjectFileTreeController.ts`、`src/renderer/src/components/session/FileTreeRows.tsx`、`src/renderer/src/components/session/WorkspaceSurface.tsx`、`src/renderer/src/components/app/BrowserPanel.tsx`、`src/renderer/src/components/session/RemoteProjectEntryDialogs.tsx`、`src/renderer/src/components/app/settings/CustomThemeSection.tsx`、`src/renderer/src/components/app/wallpaper/WallpaperVideoLayer.tsx`、`src/renderer/src/hooks/useSessionTimelineController.ts`、`src/renderer/src/i18n/rendererCopy.zh-CN.ts`、`src/renderer/src/i18n/rendererCopy.en-US.ts`、`src/renderer/src/i18n/rendererCopy.zh-TW.ts`（生成物）、`tests/settingsUnsavedChangesSummary.test.mjs`

**新增**：`src/renderer/src/components/common/workbenchDialogSize.ts`、`docs/ui-commercialization-impl-wave1.md`（本文档）

**并行改动（非本任务，未触碰）**：`src/main/pi/AgentManager.ts`、`src/main/pi/AgentMessageProjector.ts`、`src/main/pi/liveStreamChannel.ts`、`src/main/dsh/DshAgentManager.ts`、`src/main/dsh/dshEventProjector.ts`、`src/shared/reasoningText.ts`、`e2e/session-scroll-anchor.spec.ts`、`docs/easytier-managed-channel-plan.md`
