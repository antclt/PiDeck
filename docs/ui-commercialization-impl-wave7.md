# 商业化 UI/UX 统一 — Wave 7 实施记录（弹窗收尾 + Web 同步）

> 规划来源：`docs/ui-commercialization-plan.md` §Wave 7（第 353–366 行）。
> 前序：Wave 1 `feec43b90`、Wave 2 `6fe435141`、Wave 3 `90b4dedcb`、Wave 4 `0956902bf`、Wave 5 `9f46098b8`、Wave 6 `09cb6f796`。

## 调查结论（Explore + 核实）

Wave 7 六项施工中，Wave 1/2 已提前消化大部分：

- **施工 4（信任/强制流程安全出口）已达标**：TrustConfirmModal/DataModeChoiceDialog/DataImportProgressDialog 全部屏蔽被动关闭、显式三选一；DataEnvMismatchDialog Wave 1 已修。
- **施工 5（z-layer/焦点）基本达标**：ImageLightbox（捕获 Esc+圈定+归还）、SessionFindOverlay、WebBottomSheet（Wave 1 焦点圈定）齐；残留 2 处硬编码 z-index。
- **施工 3（Web 共享数据与关闭语义）半成**：数据层同源（/api/prompts、/api/models 同后端）；WebDshToolsPanel 注释明确声明分叉；WebThinkingSelector 档位表手抄桌面。
- **施工 1–2（五类模板全迁）主体未做**：FormDialog 不存在；WorkbenchDialog 仅尺寸常量；十数个业务弹窗仍裸 Dialog——但逐个检视后发现它们大多**各有成熟交互模型**（导入弹窗已统一 SessionImportModal 泛型 + 搜索/进度/结果报告；ProviderLoginModal 有完整 phase 机 + 重试；RenameModals 有 IME/Enter/saving 语义）。

## 实施（按缺口最小集）

### 1. Web 思考档位单源化（施工 3）

`WebThinkingSelector.tsx` 的 `WEB_THINKING_LEVELS` 手抄数组（注释自认「与桌面一致」）→ 改为 `THINKING_LEVELS.map((level) => level.value)`，从桌面 `sessionPickerOptions.ts` 导入。桌面加档位 Web 自动跟随，不再漂移。

### 2. z-layer 残留清理（施工 5）

- `GitGraph.tsx:314` hover 详情卡 `z-[1800]` → `z-[var(--z-popover)]`（portal 到 body 的 popover 语义；`tests/gitPanelUi.test.mjs` 断言同步）。
- `ImportOverlayHost.tsx` `zIndex: 1100`：必须浮在旧式 1000 层导入 overlay 之上通报错误，无对应语义 token（--z-* 到 980 止）——有意识保留，补意图注释（消灭「无意识硬编码」，非消灭数字）。
- sonner 999999998：Toast 顶层，豁免。

### 3. WebPromptPicker 失败态可行动（施工 2/6）

加载失败从一行红字升格 `role=alert` + 重试按钮（`common.retry`，重发 `load(debounced, category)`）——对齐桌面 Picker（CommandPickerPanel/DshConfigTab RawTab）的错误重试模式。

### 4. 新契约测试

`tests/wave7DialogParity.test.mjs`（4 pass）：档位单源/手抄数组不回归、GitGraph z token、ImportOverlayHost 1100 意图注释、WebPromptPicker 失败态可行动。

## 显式不做（判定依据）

- **FormDialog 新模板组件**：RenameModals（IME/saving/Enter 语义）、ProviderLoginModal（phase 机）等各自交互模型成熟且互不同构——强行套一个新壳属「为假设需求加抽象」。规划的「五类模板」实质是**模式语义**（表单弹窗必须：输入聚焦/Enter 提交/IME 防误触/saving 锁），这些语义各弹窗已具备；缺的只是「叫 FormDialog 的包装层」，不做。
- **WorkbenchDialog 壳组件化**：现状 WORKBENCH_DIALOG_SIZE_CLASS 尺寸已单源（Wave 2）；ProjectResourcesModal(760px 封顶)/FeedbackDialog/UsageProbeConfigDialog 高度策略各异，壳化收益低于迁移风险。
- **公告阅读壳扩容**：notice-details/history 两弹窗宽度写法与 ChangelogReaderDialog 类似但内容结构不同（列表 vs markdown 流），并入需重构数据层，超出「收尾」范围。
- **WebModelSheet 迁 CommandPickerDialog**：Web 是 flat 窗口（无 portal Dialog 语义），容器差异属规划允许的「桌面/Web 容器差异」。
- **AskPanelOverlay Esc**：Wave 1 已给 Shift+Enter/Space；胶囊非模态、不抢焦点，Esc 会与输入框冲突——维持。

## 验证

- `tsc --noEmit` 全量 0 错。
- sharedUiPatterns 7 + gitPanelUi 27 + piThinkingLevels/thinkingLevelDropdown/modelThinkingLevels 41 + wave7DialogParity 4 = **79 pass / 0 fail**。
- `git diff --check` 干净。

## 并行改动（他人，未动未提交）

`src/renderer/src/hooks/useSessionTimelineController.ts`（send-scroll 锚点 hunk）、`tests/sessionSendScroll.test.mjs`、`e2e/session-scroll-anchor.spec.ts`。
