# UI 商业化统一 Wave 2 实施记录（共享模式冻结）

> **Status: Historical（归档于 2026-10-31；内容按归档时代码，不代表现状；现行见 docs/README.md）**


> 承接 `docs/archive/plans/ui-commercialization-impl-wave1.md`（Wave 1 P0 安全修缺，提交 feec43b90）。
> Wave 2 目标（规划 §265）：冻结共享 UI 模式——从真实重复中抽取，不再新增局部样式体系；所有 Toast 走 showNotice；z-layer 用语义 token。

## 1. 本轮改动总览

| # | 模式 | 内容 | 调用点 |
|---|------|------|--------|
| 1 | PageHeader（§3.1） | 新建 `components/common/PageHeader.tsx`：图标+标题+徽标+副标题+右侧动作+可选搜索行的共享页头，`aria-labelledby` 关联 h1 | Agent 市场（`AgentMarketHeader`/`AgentMarketWorkspace`）、收藏（`FavoritesWorkspace`）、自动化（`AutomationWorkspace`）4 处 |
| 2 | AsyncState（§3.1） | 新建 `components/common/AsyncState.tsx`：`AsyncLoadingBlock`（role=status live region）+ `AsyncEmptyBlock`（图标/标题/说明/action 四槽） | FavoritesWorkspace、AutomationTaskList、AgentMarketGrid 3 处 |
| 3 | Dialog 尺寸单源（§5.3） | 新建 `components/common/workbenchDialogSize.ts`（`WORKBENCH_DIALOG_SIZE_CLASS`），SettingsModal/ConfigModal 引用同一常量 | 2 处 |
| 4 | Changelog 阅读壳合并（§5.3） | 新建 `ChangelogReaderDialog.tsx` 共享壳（ScrollArea+markdown-body+footer+unavailable 降级），`ChangelogDialog.tsx`（216→151 行）与 `PiChangelogDialog.tsx`（115→79 行）重写为消费方，各自保留领域差异（版本切分/展开/来源 vs releaseNotes IPC/truncated） | 2 处 |
| 5 | Picker 统一（§312） | `CommandPickerDialog` 导出复用；`ComposerSkillPicker` 列表态迁移到 `CommandPickerPanel` + 两个 `CommandPickerGroup`（项目/全局技能分组）；`PromptTemplatePicker`（ComposerComponents 内）列表态迁移到共享壳；预览态保留 `PickerDialog` | 2 列表 + 面板复用（模型选择器/DshAgentPresetControl 原有） |
| 6 | Toast 单通道（§4） | `CustomThemeSection.tsx`（9 处）、`WallpaperVideoLayer.tsx`（1 处）、`useSessionTimelineController.ts`（1 处）sonner 旁路全部迁移到 `showNotice` | 3 文件 11 处 |
| 7 | z-layer 语义化（§5） | `GitPanel.tsx` 分支下拉 `zIndex: 9999` → `var(--z-popover)`；`popover-morph.tsx` `z-[9999]` → `z-[var(--z-drawer)]`（980，压过弹窗 950、低于 1000 旧浮层） | 2 处旁路清零 |

**显式不做**（有调查依据，移交后续 Wave）：

- **Toolbar 共享模式**：GitPanel 工具行用 `--git-panel-*` CSS 变量主题化、TerminalDockPanel 无 border-b 工具行，各面板结构差异大，硬抽会吞并领域语义——归 Wave 5 分域统一（规划 §301 本就把工具行统一放在 Wave 5）。
- **ResourceRow**：调用点在侧栏（ProjectTree/SidebarContent），行深耦 legacy CSS（`conversation-body`/`codex-subagent-sidebar-row`）与拖拽/手风琴逻辑——规划 §292 归 Wave 3 壳/导航/列表，届时随侧栏改造一起做。
- **TabChrome**：SessionTabsBar/WorkbenchFileTabs/TerminalDock 各自的 Tab 语义差异（预览/dirty/pin/溢出）归 Wave 3 §3。
- **WebPromptPicker（web/）**：数据源（/api/prompts）与桌面不同源，归 Wave 7 Web 同步验收。
- **自绘菜单迁移 Radix**（FeishuLinkIndicator popover、GitGraph 内嵌详情）：存量键盘导航已具备（Wave 1.7），全量迁移归 Wave 5/7。

## 2. 逐项说明

### 2.1 PageHeader

三个独立页面（收藏/自动化/Agent 市场）此前各自维护同构 `<header class="border-b px-5 py-3">`。抽取为 `PageHeader`（props：`icon/iconClassName/title/titleSuffix/subtitle/actions/search/leading/className`），只收敛结构骨架与语义槽位：

- `titleSuffix` 槽原样插入 Badge（收藏计数/自动化 running 数）；
- `search` 槽出现时切换两行布局（与三页面现状一致）；
- `leading` 槽供 Agent 市场返回按钮用；
- 不内置关闭按钮/搜索逻辑/图标视觉，避免为统一改造各页视觉细节；
- `useId` 生成 h1 id，`aria-labelledby` 让 landmark 有可访问名称。

### 2.2 AsyncState

`AsyncLoadingBlock`（`role="status" aria-live="polite"` + Loader2 自旋 + `t("common.loading")`）与 `AsyncEmptyBlock`（图标槽默认色块底、收藏传裸色；title/description/action 三槽）。错误态**不在**此文件——错误带重试语义，走 Wave 1 建立的 role=alert 错误行口径（文件树/DSH Raw/浏览器错误页同款）。

### 2.3 Dialog 尺寸与 Changelog 壳

- `WORKBENCH_DIALOG_SIZE_CLASS = "w-[80vw] max-w-[80vw] h-[80vh] max-h-[80vh] sm:max-w-[min(1300px,80vw)]"`——与 `surfaces.css` 的 `.config-modal/.settings-modal`（min(1300px,80vw) × min(850px,80vh) + 小窗覆盖）对齐；ProjectResourcesModal 高度策略不同（760px 封顶）保持自有。
- `ChangelogReaderDialog` 壳持有 DialogContent（`sm:max-w-[min(760px,calc(100vw-48px))]`，Tailwind v4 字母序约束）、标题区、loading、unavailable 降级（在浏览器查看）、`ScrollArea(h-[52vh])` + `markdown-body` 载体、footer（来源·时间 + 刷新 + 外链）。消费方只保留领域差异。

### 2.4 Picker 统一

`CommandPickerDialog`（Dialog 壳 + `CommandPickerPanel`）从 ComposerComponents 导出复用：

- **Skill 列表**：条目渲染抽为 `renderSkillItem`，列表改为两个 `CommandPickerGroup`（`skills:project` / `skills:global`，label 用 `app.skillBadgeProject/Global`，计数 `config.count.skills` 新 key）；loading/error/blocked/三态空态保留为面板 children（非列表态与共享搜索空态不冲突）。
- **Prompt 模板列表**：`templates.length===0` 空态 div 保留为 children；条目块整体缩进 -1 tab；预览态（`previewTemplate` 分支）保留原 `PickerDialog`（内容型预览，非选择语义）。
- cmdk 的 `CommandEmpty` 语义（过滤无匹配）由面板 `emptyLabel` 承担，调用方不再自建。

### 2.5 Toast 与 z-layer

- sonner 直连 import 迁移后 renderer 内仅剩 `utils/notice.ts` 与 `ui-shadcn/sonner.tsx` 本体。
- z-index token 体系（foundation.css §270）：拖拽条 900 → 窗口控件 920 → 品牌区 930 → 旧 backdrop 940 → `--z-dialog` 950 → `--z-popover` 960 → `--z-drawer` 980 → 旧浮层 1000。GitPanel 分支下拉是 popover 语义（960）；popover-morph 装饰层要压弹窗内容（980）。两处 9999 旁路清零。

## 3. 验证证据

| 验证 | 结果 |
|------|------|
| `node node_modules/typescript/bin/tsc --noEmit`（过滤本任务文件） | 0 错误（node_modules/.bin 仍残缺，见 Wave 1 文档环境注记） |
| `node --test tests/sharedUiPatterns.test.mjs`（新增） | 7/7 pass |
| changangelog 系（changelogDialogLayout 等 5 文件） | 36 pass |
| favorites/agentMarket/automation 系 | 77 pass |
| picker 系（commandPickerExpansion/GroupHeader/modelPicker*3/runtimePromptTemplateBodies/composerSkillPicker/composerSlashCommand/composerPickerTemplates） | 48 pass |
| gitPanel 系（gitPanelUi/Badge/RefreshStability） | 25 pass |
| sessionSendScroll（受 timeline controller 迁移影响的回归） | 15 pass |
| `git diff --check` | 干净 |

`tests/sharedUiPatterns.test.mjs` 是 Wave 2 的契约测试：断言 PageHeader h1/aria-labelledby、AsyncState role=status、尺寸常量单源、Changelog 壳单源（消费方无 markdown-body）、Skill/Prompt 列表无 CommandInput/`<Command>` 自建壳、Toast 单通道、z-layer 无 9999 旁路。

## 4. 未完成项移交（Wave 3–8）

1. **Wave 3**：壳/导航/列表——ResourceRow（侧栏行 legacy CSS 解耦后抽取）、TabChrome（会话/文件/终端 Tab 统一层级）、SidebarParts 活动行。
2. **Wave 4**：会话/Composer 状态统一（布局冻结；模型选择器用量/收藏已具备，Agent/分支/思考选择器统一 Picker 语义）。
3. **Wave 5**：文件/Git/终端/浏览器——Toolbar 分域统一（本轮调查结论：GitPanel 工具行 CSS 变量主题化、Terminal 无边框工具行，需分域设计而非全局硬抽）；自绘菜单（FeishuLinkIndicator/GitGraph）迁 Radix。
4. **Wave 6**：设置 22 Tab 统一（PageHeader/AsyncState 模式可复用到设置页空态）。
5. **Wave 7**：Web 端同步（WebPromptPicker 数据通道统一、WebDshToolsPanel 等 Web 组件的模式对齐）。
6. **Wave 8**：视觉验收（Ink Workbench 字档/圆角校准、对比度、键盘全检、八态一致性巡检）。

## 5. 本轮新增/修改文件清单

**新增**：`src/renderer/src/components/common/PageHeader.tsx`、`src/renderer/src/components/common/AsyncState.tsx`、`src/renderer/src/components/app/settings/ChangelogReaderDialog.tsx`、`tests/sharedUiPatterns.test.mjs`、本文档

**修改**：`AgentMarketHeader.tsx`、`AgentMarketWorkspace.tsx`、`AgentMarketGrid.tsx`、`FavoritesWorkspace.tsx`、`AutomationWorkspace.tsx`、`AutomationTaskList.tsx`、`ChangelogDialog.tsx`、`PiChangelogDialog.tsx`、`SettingsModal.tsx`（尺寸常量）、`ConfigModal.tsx`（尺寸常量）、`ComposerComponents.tsx`（CommandPickerDialog 导出 + Prompt 列表迁移）、`ComposerSkillPicker.tsx`、`GitPanel.tsx`（z token）、`popover-morph.tsx`（z token）、`CustomThemeSection.tsx`、`WallpaperVideoLayer.tsx`、`useSessionTimelineController.ts`（Toast 迁移）、`workbenchDialogSize.ts`（Wave 1 尾新增，本轮启用双消费方）、i18n 三语（`config.count.skills`）、`tests/changelogDialogLayout.test.mjs`、`tests/favoritesFeature.test.mjs`（断言迁移到共享模式，同意图非放宽）

**并行改动（他人，未触碰未提交）**：`e2e/session-scroll-anchor.spec.ts`、`tests/sessionSendScroll.test.mjs`、`useSessionTimelineController.ts` 的 send-scroll 锚点部分（同文件内与 Toast 迁移不同 hunk，提交时按 hunk 分离或整体留给对方）。
