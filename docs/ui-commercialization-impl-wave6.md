# 商业化 UI/UX 统一 — Wave 6 实施记录（设置工作台 22 Tab）

> 规划来源：`docs/ui-commercialization-plan.md` §Wave 6（第 343 行起）。
> 前序：Wave 1 `feec43b90`、Wave 2 `6fe435141`、Wave 3 `90b4dedcb`、Wave 4 `0956902bf`、Wave 5 `9f46098b8`。

## 现状盘点（Explore 调查 + 核实）

设置域基础远好于规划预期，Wave 6 实际缺口集中在三处：

| 能力 | 现状 |
|---|---|
| dirty 引擎 | 已有：`SettingsModal.tsx:327` `computeDirtyFields`（deepEqual 摘脏）、`saveAll:437`（patch + vision/imageGen/videoGen/acp 四独立草稿）、失败保草稿、保存中禁用。Wave 1 已补 videoGen/acp 关闭统计。 |
| 共享行组件 | `SettingRows.tsx`（DirtyMarker/SettingBox/SettingRow 260px 控件列/SettingSwitchRow/SettingTextarea…），15/22 Tab 已用。 |
| 危险确认 | DevTab/AcpPresetChips/ImTab/ProcessMetricsTab/SettingsBackupTab/SettingsStorageTab/HostPluginsTab 全有 ConfirmDialog/AlertDialog，后者 Action 已带 destructive。 |
| **缺口 1** | `unsavedChangesSummary.ts` FIELD_CATALOG（~100 条）不含 terminal 10 字段——dirty 落「其他选项」兜底、侧栏无黄点。 |
| **缺口 2** | 生效方式标注仅 DSH 配置页有徽章（`config.dsh.appliesLive/appliesRestart`）；设置页只有散落 desc 文案，无统一徽章。 |
| **缺口 3** | HostPluginsTab 卸载 AlertDialogAction 无 destructive 变体。 |

## 实施内容

### 1. terminal 字段补进未保存目录（缺口 1）

`unsavedChangesSummary.ts`：

- `SettingsUnsavedTabId` 联合类型补 `"terminal"`；`TAB_LABEL_KEYS` 补 `terminal: "settings.tabs.terminal"`。
- `FIELD_CATALOG` 补 10 条（terminalTheme/FontSize/FontFamily/PaddingY/Scrollback/CursorStyle/CursorBlink/CopyOnSelect/ConfirmClose/StartupCommand → `settings.terminal.*`）。

效果：终端设置有未保存改动时，关闭确认清单逐条列出 + 侧栏 Tab 黄点，不再落「其他选项」兜底。

### 2. 生效方式徽章 SettingApplyBadge（缺口 2）

- `SettingRows.tsx` 新增 `SettingApplyBadge(props: { mode: "live" | "newSession" | "restart" })`：`span.rounded-full border px-2 py-0.5 text-micro text-muted-foreground`，key 映射 `settings.apply.live/newSession/restart`。视觉对齐 DSH 配置页徽章，不新造样式。
- 打点（只给有明确证据的非即时段落）：
  - `TerminalTab.tsx`：上下内边距、滚动上限两行 → `newSession`（desc 本就写着「重启会话后生效 / 只影响新建的终端」）。
  - `DevTab.tsx`：Electron 沙箱 → `restart`。
  - `CommonTab.tsx`：单实例模式 → `restart`。
- i18n 三语：`settings.apply.live`「即时生效」/ `settings.apply.newSession`「新会话生效」/ `settings.apply.restart`「重启后生效」（zh 手写 + genZhTwCopy）。

判定：其余 tab 均为保存即生效，无标注需求；不做全 tab 段落扫描（无证据不猜）。

### 3. HostPluginsTab 卸载 destructive（缺口 3）

核查发现 `variant="destructive"` 已存在（先前/并行改动覆盖），幂等跳过，无 diff。

## 显式不做（与规划核对后判定）

- **7 个未用 SettingRows 的 Tab 硬迁**：ConnectionsTab（自有交互模型，代码内有设计注释）、ImageGen/VideoGen（转发壳→config/ 域共享）、AcpTools/Usage/Process（只读/监控豁免）。强行迁移会破坏各自交互模型。
- **危险区视觉分组容器**：现有危险操作全部已有确认框 + destructive 红钮，规划无硬性容器样式要求；增加容器属为未来需求加抽象。
- **切 Tab 自动 flush**：草稿全在 Modal 层 state，切 Tab 不丢（现状已满足规划「不丢失」要求），自动保存反而违背「有 dirty 才保存」原则。

## 测试

- 新增用例：`tests/settingsUnsavedChangesSummary.test.mjs`「终端字段纳入关闭确认摘要与侧栏黄点（Wave 6）」——dirtyFields 含 terminalTheme/terminalStartupCommand 时 totalCount=2、tabKey 全为 `settings.tabs.terminal`、`dirtySettingsTabIds` 含 terminal。
- 回归：settingsUnsavedChangesSummary + settingsDirtyFields + settingsTabLayout + settingsFieldAnchors + settingsTabVisibility + voiceSettingsAutoSave + configDirtyMarks + configUnsavedChangesSummary **71 pass / 0 fail**。
- `tsc --noEmit` 全量 0 错；`git diff --check` 干净。

## 并行改动（他人，未动未提交）

`src/renderer/src/hooks/useSessionTimelineController.ts`（send-scroll 锚点 hunk）、`tests/sessionSendScroll.test.mjs`、`e2e/session-scroll-anchor.spec.ts`。
