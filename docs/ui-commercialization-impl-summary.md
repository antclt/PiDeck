# 商业化 UI/UX 统一实施总结（Wave 1–7）

> 规划来源：`docs/ui-commercialization-plan.md`（kimi 产出的商业化 UI/UX 统一规划）。
> 用户指令：按规划实现到完成，实现结果写成文档（m00001）；每完成一个 Wave 提交一次（m01186：做到 Wave 7 为止）。
> 本文是总入口；逐 Wave 明细见各 `docs/ui-commercialization-impl-wave*.md`。

## 提交与文档索引

| Wave | 提交 | 结果文档 | 主题 |
|---|---|---|---|
| 1 | `feec43b90` | `docs/ui-commercialization-impl-wave1.md` | P0 安全修缺 12 项 |
| 2 | `6fe435141` | `docs/ui-commercialization-impl-wave2.md` | 共享 UI 模式冻结 |
| 3 | `90b4dedcb` | `docs/ui-commercialization-impl-wave3.md` | 壳/导航/列表统一 |
| 4 | `0956902bf` | `docs/ui-commercialization-impl-wave4.md` | 会话/Composer 状态统一 |
| 5 | `9f46098b8` | `docs/ui-commercialization-impl-wave5.md` | 文件/Git/终端/浏览器分域 |
| 6 | `09cb6f796` | `docs/ui-commercialization-impl-wave6.md` | 设置工作台 22 Tab |
| 7 | `f5eac8ed2` | `docs/ui-commercialization-impl-wave7.md` | 弹窗收尾 + Web 同步 |

## Wave 0 基线（规划要求的盘点，随 Wave 1 文档 §4 落档）

- 界面骨架：主窗口 = 自定义标题栏 + 侧栏（项目树/会话树/搜索）+ 中央工作区（会话 Tab）+ 右侧文件抽屉；底部终端 Dock。设置/配置/资源为工作台型大弹窗。
- 技术栈：Electron + React 19 + TS + Vite + Tailwind v4 + shadcn/ui（new-york）+ Radix 原语 + Jotai + sonner（经 utils/notice 单通道）。
- i18n：zh-CN 源词典手写，zh-TW 由 `node scripts/genZhTwCopy.mjs` 生成（铁律：改 zh-CN 必跑生成）。
- 弹窗体系：shadcn Dialog（非模态用法居多）/AlertDialog（危险确认）/ConfirmDialog（统一确认）/CommandPickerDialog（选择器）；z-token 体系在 foundation.css §270（950 dialog/960 popover/980 drawer）。

## 按规划验收项的核销总表

### P0 安全修缺（Wave 1，全数完成）

| 项 | 落点 |
|---|---|
| 设置关闭漏算生视频/ACP 脏 | unsavedChangesSummary + SettingsModal hasIndependentDraftsDirty |
| Raw 编辑器切文件丢草稿 | ConfigModal/DshConfigTab 切换确认弹窗 |
| DSH Raw 保存失败仅 console | showNotice + 读失败错误面板 + 重试 |
| 文件树读取失败伪装空目录 | FileTreeNode.loadError + role=alert + 重试钮 |
| 浏览器 did-fail-load 吞错 | 非 -3 错误页 + 重试 |
| Dialog 无可访问名称 | DshAgentTools/WebDshTools/SessionProxy/SessionHistory Title |
| 抽屉/菜单无键盘路径 | drawer/WebBottomSheet 焦点圈定；ExternalEditor 方向键；AskPanel Shift+Enter |
| ConfirmDialog 双触发 | confirmedRef 防 onCancel×onConfirm 双调 |
| DataEnvMismatch Esc=继续 | 关闭手势忽略，必须二选一 |
| 远端删除确认分裂 | RemoteProjectEntryDialogs 迁 AlertDialog 模板 |

### 共享模式（Wave 2，完成 7 项 + 显式不做 5 项）

PageHeader（4 调用点）/AsyncState（3）/ChangelogReaderDialog（2）/CommandPickerDialog 统一 Skill/Prompt 列表/Toast 单通道收敛/z-token 清 9999/WORKBENCH_DIALOG_SIZE_CLASS。显式不做：Toolbar/ResourceRow/TabChrome 硬抽（结构差异大，见 wave2 文档）。

### 壳/导航/列表（Wave 3）

sidebarRowStyles 单源（SessionTree/ActiveSessionsTree/RecentSessionsSection 三份逐字重复收敛）；Tab 语义核验（4 处 role=tab 键盘语义已齐，不硬抽）；SessionHeader 查找按钮补快捷键提示（sessionFindShortcutHint，改绑自动跟随）；composerPrewarmFocus stub 补同步。

### 会话/Composer（Wave 4，布局冻结只修状态）

明细见 wave4 文档（Composer 状态一致性、引导页状态补全）。

### 工作台分域（Wave 5）

文件 dirty 关闭保护三路径 gate + 保存失败横幅重试；Git 错误 alert 语义 + 脏区切分支确认；终端标题带 cwd + 退出一键重开；浏览器设备菜单迁 Radix。

### 设置 22 Tab（Wave 6）

terminal 10 字段补进未保存目录（关闭清单+黄点）；SettingApplyBadge 生效方式徽章（terminal×2/dev×1/common×1 打点）；HostPlugins destructive 核验已有。

### 弹窗/Web 收尾（Wave 7）

Web 思考档位单源；GitGraph z-token；WebPromptPicker 失败可行动；信任/强制流程核验达标（被动关闭全屏蔽）。

## 验证总账

- 每个 Wave：`tsc --noEmit` 全量 0 错 + 改动域针对性 `node --test`（累计 30+ 测试文件、500+ 用例）0 fail + `git diff --check` 干净。
- 新增测试文件：settingsUnsavedChangesSummary 扩展、fileEditorDirtyClose(6)、browserDeviceMenu(3)、sharedUiPatterns(7)、wave7DialogParity(4) 等。
- i18n：所有新 key 走 zh-CN 手写 + en-US + `genZhTwCopy` 生成，无手改 zh-TW。

## 遗留与移交（Wave 8+ / 低优先）

1. **Wave 8 视觉验收**（规划 P2）：全页面 Ink Workbench 检查、字档/圆角/留白校准、浅暗/壁纸/低性能模式对比、before/after 截图矩阵——需真机跑 `npm run dev` 人工+截图驱动，未在本轮代码任务范围。
2. **E2E**：本轮未跑 Playwright（窗口级验证），wave5 的 testid 契约已保（remote-file-management 零改动）。
3. **自绘菜单残余**：FeishuLinkIndicator role=menu popover、公告两弹窗并入阅读壳——低频路径，模式已定型可后续按 Wave 7 同款方法迁移。
4. **终端搜索栏 UI**：SearchAddon 已装配未持引用（TerminalDock.tsx:377 注释标记），做 UI 时补。

## 环境事故记录

Wave 2 期间 node_modules 被外部工具清空 → `npm ci` 恢复（lock 钉死无 diff）；期间用 `node node_modules/typescript/bin/tsc --noEmit` 直跑保持门禁。HEAD 46e1ccee5 自带 TS2677（他人改动）曾挡 typecheck，按最小改动修谓词类型（已随 Wave 2 提交）。
