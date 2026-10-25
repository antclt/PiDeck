# ZCode 视觉质感分析与反哺计划

> 状态：**Phase 1 已落地**（2026-10，d4e60c97c / 730579b0b / 6a45b179f）；**Phase 2 已落地**（2026-10，31792faf0，边框墨水化 + 圆角降档 + 语义色审计）；**Phase 3 已落地**（2026-10，25e4e7284，忙碌色结论 + 阴影降档）；**Phase 4 已落地**（2026-10，字号/等宽纪律 + 守卫测试）；**Phase 5 已落地**（2026-10，会话页画布档 + 白卡模型 + 墨水罩染表面，见 §七）；**Phase 6 已落地**（2026-10，右抽屉表面定版：白面板维持 + 工具 pill 降档，chrome 实验经用户裁决回退，见 §八）；**Phase 7 已落地**（2026-10，排版对齐：标题压平 + 行内码缩档 + 按钮紧凑，见 §九）；**Phase 8 已落地**（2026-10，过程层去阴影——运行态洗底/占位卡/折叠条/气泡投影移除 + Git 摘要按钮 ghost，见 §十）；**Phase 9 已落地**（2026-10，右抽屉画布提亮半档 --color-bg-page-raised，见 §十一）；后续按「改到哪，旧迁新到哪」增量推进，不做 big-bang。
> 分析来源：`zai-org/ZCode`（Apache-2.0，main 分支 2026-10 浅克隆）。核心文件：`DESIGN.md`（设计宪法）、`packages/ui/src/styles.css`（Zai Light/Dark 主题值）。

## 一、ZCode 质感的六个机制（带证据）

### 1. 灰阶零色相 + 墨水相对色

ZCode 所有中性色是纯 R=G=B 灰，或「墨水 alpha」相对色：

- 边框：`--color-border: rgba(13,13,13,0.1)`（亮）/ `rgba(255,255,255,0.1)`（暗）——**不是不透明灰线**，是 10% 墨水。好处：叠在任何表面上色相永远一致，hover 只需把 alpha 0.05→0.15。
- hover/selected：`rgba(13,13,13,0.05)`；surface（低层容器）：`rgba(13,13,13,0.03)`——「材质感」来自半透明墨水罩染，不是另一块不透明灰。
- 文字三级：`neutral-800` 实色 / 60% alpha / 40% alpha，同一墨水不同浓度 → 层级天然协调。

PiDeck 现状：边框已中性（#e5e5e5 系），但 hover/active 带锌蓝调（#e5e7eb、#dfe3e8），文字 secondary/tertiary 是 slate（#4b5563 B−R=24）。**本次已改**：hover/active/muted/文字三级全部纯中性化。

### 2. 表面阶梯单向且步长克制

Zai Light：page `#f8f8f8` → sidebar `#f0f0f0` → panel/card/popover `#ffffff`。
Zai Dark：bg/sidebar `#161616` → panel `#202020` → card/menu/popover `#2b2b2b` → menu-hover `#363636`。

暗色比浅色**步长更大**（+0x0a 一档），这是暗色下「层次感」的关键——PiDeck 原暗色 panel→popover 都是 #171717（零步长），菜单像贴在内容上。**本次已改**：暗色 popover 换 `color-mix(in srgb, var(--color-bg-panel) 95%, white)` 相对浮层色（经典 #1a1a1a→#252525，与 ZCode #202020→#2b2b2b 同构），graphite/sea-blue/warm-beige 不覆盖该 token，继承相对派生自动获得正确方向（守卫：`tests/sidebarChromeHierarchy.test.mjs`）。

### 3. 品牌/语义色极度克制

- Zai 品牌色就是黑（亮）/白（暗）：`--color-brand: #000000`、`--color-primary: #000000`。强调是「墨水加深」不是「刷颜色」。
- accent 是**面色**不是字色：`--color-accent: #ebf4ff`（浅蓝罩染）只用于弱强调块。
- 语义色（success/warning/destructive）只用于真实语义状态，DESIGN.md 原话："Do not borrow success, warning, or destructive colors just to make a block feel louder."
- 身份色（文件蓝/技能紫/会话青）统一 10% alpha 底 + 深实色字。

### 4. 深度靠底色对比和边框，不靠阴影

DESIGN.md「Elevation and Depth」：Base 无阴影（结构来自底色对比）；Surface 细边框；Overlay 才 `shadow-md`（菜单/弹窗）；`shadow-lg` 只给 toast。原则："Background layering is usually more important than shadow strength."

### 5. 圆角按嵌套层级递减，与重要性无关

- 第一个可见圆角容器 `rounded-xl`，嵌套逐级 `lg → md → sm`，`rounded-sm` 是下限。
- `rounded-2xl` 是**白名单例外**（主输入框/toast/对话框壳），「尺寸大」不构成理由。
- 控件圆角跟随最近的圆角父容器，不跟控件类型走。
- `rounded-full` 只给刻意的胶囊/圆。

### 6. 字号三级制 + 等宽克制

- 界面字号全部从单一 `--ui-font-size`(14px) 派生：base/−1/−2/−4 四档，**禁止** Tailwind 内建 `text-sm` 和任意 `text-[13px]`——字号是「可读性设置」的派生量，不是自由变量。
- 等宽只用于天然技术内容：路径/命令/代码/标识符/快捷键/commit hash/模型 ID。
- 层级靠字重与颜色，不靠缩小字号：h3–h6 同字号靠 semibold/medium/normal 区分。

## 二、PiDeck 差距与落地状态

| 维度 | ZCode | PiDeck 现状 | 动作 |
|---|---|---|---|
| 中性灰色相 | 全部 R=G=B / 墨水 alpha | hover/active/文字带锌蓝调 | ✅ Phase 1 已改 |
| 亮色 chrome 层次 | sidebar #f0f0f0 vs panel 白 | sidebar #f7f7f7（过弱） | ✅ Phase 1 已改 #f0f0f0 |
| 暗色表面阶梯 | 每档 +0x0a | panel=popover=#171717 零步长 | ✅ Phase 1 已改（相对浮层色） |
| 边框墨水化 | rgba(ink,0.1) 全站 | 不透明灰 hex | ✅ Phase 2 已改（经典浅/暗色块；皮肤保留带色相边框作为身份色） |
| 圆角纪律 | 嵌套递减 + 2xl 白名单 | 混用，部分组件按「感觉」 | ✅ Phase 2 已改（消息流卡片降档，白名单见下） |
| 阴影克制 | 四级阶梯 | 尚可，个别重投影 | ⏳ Phase 3：抽查 shadow-lg 使用 |
| 字号派生制 | --ui-font-size 四档 | 已有 --font-size-chat 派生制（过程层两档），接近 | 无需大动 |
| 语义色借用 | 严令禁止 | 审计结论：无装饰性滥用，全部绑定真实状态 | ✅ Phase 2 已审计 |

## 三、Phase 1 变更明细（本次）

`src/renderer/src/styles/foundation.css`：

- 浅色：sidebar `#f7f7f7→#f0f0f0`；muted `#f4f4f5→#f4f4f4`；hover `#e5e7eb→#e4e4e4`；active `#dfe3e8→#dcdcdc`；text-secondary `#4b5563→#4a4a4a`；text-tertiary `#636b79→#666666`；text-faint `#9fa3ac→#9a9a9a`；chat-muted-bg 同步 `#f4f4f4`。
- 暗色：panel `#171717→#1a1a1a`；popover → `color-mix(in srgb, var(--color-bg-panel) 95%, white)`；input → `var(--color-bg-panel)`；chat-card-bg/chat-table-bg 同步 `#1a1a1a`。
- 测试：`themeContrast` 的 `resolve()` 支持 color-mix 相对派生；`lightNeutralBackground` 钉值更新（含文字墨水中性钉）；`wallpaperMode` popover 钉值换相对色；`darkFixedChatColors` 钉值同步；`sidebarChromeHierarchy` 新增「暗色浮层阶梯」守卫（含皮肤继承链解析）。

对比度核算（themeContrast 矩阵实测全绿）：secondary #4a4a4a 白底 8.9:1；tertiary #666666 白底 5.7:1 / muted 底 5.2:1 / hover 底 4.5:1；faint #9a9a9a 白底 2.8:1（≥2.5 地板）。

## 四、Phase 2 变更明细（本次）

### 4.1 边框墨水化（foundation.css 经典浅/暗色块）

- 浅色：`--color-border-subtle/default/strong` #e5e5e5/#dfdfdf/#d7d7d7 → `rgba(13,13,13, 0.10/0.13/0.17)`（白底上渲染 ≈ #e6e6e6/#dedede/#d5d5d5，视觉等值）。
- 暗色：#262626/#2e2e2e/#3a3a3a → `rgba(255,255,255, 0.05/0.09/0.14)`（panel #1a1a1a 上 ≈ #262626/#2f2f2f/#383838）。
- 机制收益：边框叠在任何表面（侧栏 #f0f0f0、壁纸半透明面板、皮肤色底）色相永远中性一致；暗色边框自动跟随底色形成正确亮度（与既有 `--shadow-border: rgba(255,255,255,0.08)` 同构）。
- 皮肤（fresh-green/graphite/sea-blue/warm-beige）自带带色相边框，作为皮肤身份色保留不动。

### 4.2 圆角白名单（嵌套递减纪律）

消息流内容卡片从 rounded-2xl 降档（ZCode：内容卡跟父容器递减，2xl 只给壳）：

- `agents/message-bubble.tsx` 气泡 2xl→lg；`agents/code-block.tsx` 代码块 2xl→md（气泡内再递减）；
- `agents/todo-list.tsx` 卡片 2xl→lg、卡头按钮 →md；`agents/approval-card/index.tsx`、`agents/tool-approval.tsx` 审批卡 →lg；
- `web/WebTimeline.tsx` 用户/助手气泡 ×2 →lg；`agents/market/AgentMarketGrid.tsx` 图标底板 →xl。

**rounded-2xl 白名单**（新增组件不得随意用 2xl；「块大」不构成理由）：

- 主输入壳：`agents/prompt-input.tsx`
- 对话框/浮层壳：`web/WebBottomSheet.tsx`、`agents/chat-app.tsx`（面板根壳）
- 浮层/动画层：`components/motion/*`（dock、preview-rail、animated-sidebar、shared-layout-bg——vendored 动效代码）

### 4.3 语义色审计结论

全量扫描 80 处 success/warning 使用：全部绑定真实状态（安装成败、鉴权关闭警告、导入取消、日志级别、子代理状态），**无 ZCode 所禁的「借语义色让块更响」装饰性滥用**。唯一软性候选：`agentListDisplay.ts` 把 running/starting/pending/waiting（忙碌中）映射到 warning 黄点——「忙碌」不是警告，ZCode 口径下更该是中性活动色（info 或 primary）；但黄色=进行中是广泛惯例，改动影响全局状态点视觉，列为 Phase 3 候选待用户视觉确认后再动。

## 五、Phase 3 变更明细（本次）

### 5.1 忙碌状态色：结论「保留不改」

审计发现黄色=运行中是**文档化的用户约定**（agentListDisplay.ts：「用户语义：idle=蓝、starting/运行中=黄、error=红」；sessionStatusBadge.ts：「颜色语义与用户约定一致」），且三个状态映射器（agentListDisplay / sessionStatusBadge / subagentStatus）口径一致——这不是 ZCode 禁的装饰性借用，是显式产品决策，改了反而违背既有约定。黄色=进行中也是广泛惯例，保留。

### 5.2 阴影克制降档（shadow-lg 只留给 toast）

自研组件 7 处 shadow-lg → shadow-md（浮层/提示条/工具条均为 overlay 档，不是 toast）：

- `overlays/AskPanelOverlay.tsx` 详情浮层 + 拖拽药丸 ×2
- `selectionTool/SelectionInlineToolbar.tsx`、`selectionTool/SelectionToolHost.tsx` 划词浮层
- `session/SessionFindOverlay.tsx` 会话内查找条
- `session/SurfaceComponents.tsx` ctx 详情 tooltip
- `sidebar/UpdateDotHint.tsx` 更新提示浮层
- 另：`session/SessionSurfaceStage.tsx` FAB 删 hover:shadow-lg 升档（悬停加深投影属装饰）；`styles/surfaces.css` file-diff 图片预览 var(--shadow-lg)→md（内容深度靠底色对比，不靠投影）。

保留例外：菜单/FAB/桌面悬浮球 shadow-md ✓、模态导入浮层与 Web 抽屉/bottom-sheet shadow-xl ✓（大 overlay）、vendored shadcn 原语（dialog/chart tooltip）不动（beUI 纪律：官方原版禁改）。自研组件现已零 shadow-lg。

### 5.3 暗色 chat-muted-bg（#202020）与 panel（#1a1a1a）关系

muted 比面板亮一档，方向正确，无需动。

## 六、Phase 4 变更明细（字号/等宽纪律）

### 6.1 任意字号归位语义类（16 处）

- `text-[11px]` → `text-micro`：SelectionToolWindowView ×5、HostPluginRow ×4、TipTapComposer kbd、SelectionToolWindowView reasonHint 等；`text-[13px]` → `text-control`：SelectionInlineToolbar 选区原文、SelectionToolWindowView 结果区；`text-[10px]` → `text-micro`：DshAgentPresetControl 预设 chip（+1px，换来随「界面字号」缩放）；`text-[18px]` → `text-brand`：AppParts/WebBrandLockup 品牌字。
- 保留例外：`text-[9px]` ×4（GitPanel ahead/behind 计数 ×2、SessionSourceBadge、SettingsTab 折叠箭头）——徽标计数器低于 token 下限的刻意微型排版；`text-[40px]` App.tsx 空态 hero 大标题——展示型排版不参与 UI 阶梯。
- 收益：这些文本现在随「界面字号」设置缩放（原来任意 px 完全不缩放， Accessibility 缺口）。

### 6.2 等宽纪律

- 修复 SelectionInlineToolbar 译文结果继承容器 `font-mono`（自然语言禁等宽，源码视图保持 mono 正确）。
- 抽查 ModelsTab/McpTab/AuthTab 等设置页 font-mono 使用：均为模型 ID/URL/env 键/路径，合规。

### 6.3 守卫测试

`tests/fontSizeDiscipline.test.mjs`（3 项）：① 自研组件任意字号扫描（空白容忍正则，9px 徽标与 ≥20px hero 豁免，ui-shadcn/motion 免检）；② foundation 字号阶梯 token 存在性；③ 划词工具条译文 font-sans 钉。

## 七、Phase 5 变更明细（会话页画布档 + 白卡模型 + 墨水罩染表面）

用户反馈两个问题：会话页背景太白；灰色背景块太多、主题被拆碎缺乏一体性。根因：会话正文面板是纯白（`--color-bg-panel`），而时间线里的气泡/过程卡/行内代码/引用/代码块各自配了一块**互不成阶**的不透明灰（用户气泡 #EBEBEB、过程条 #FAFAFA、行内码 #F4F4F4、引用 #F0F2F4 还带锌蓝调）——六档散灰直接贴在白底上，就是「碎成小块」的来源。暗色侧整页同底、卡片提亮，本就一体，不动。

### 7.1 画布档（`--color-bg-page`，ZCode page 机制）

- 浅色 `:root`：`color-mix(panel 55%, sidebar)`，经典值 = #f8f8f8（恰为 Zai Light page 同值）；由 panel/sidebar **派生**而非写死——四套皮肤与自定义主题不覆盖它时自动落在自己的 panel/sidebar 之间，方向恒对。
- 暗色：`= var(--color-bg-panel)`（暗色画布维持整页同底，var 引用让皮肤暗色 panel 覆盖自动传导）。
- 应用面：`chat-pane`（AppShell `bg-bg-panel → bg-bg-page`）、`.chat-header`（自铺白条改 `bg-transparent` 透出画布，避免顶部色阶断层）；壁纸模式 `BG_TOKENS`（useAppAppearance）补 `--color-bg-page`，与 panel 同批转半透明。

### 7.2 白卡模型（浅色会话卡一律白）

ZCode Light 的 panel/card/popover 同为 #ffffff，分层靠浮在 page 上——PiDeck 会话区的「块」收敛到同一档：

- `--color-chat-card-bg` #fafafa→#ffffff、`--color-chat-muted-bg` #f4f4f4→#ffffff（浅色；暗色保持 #1a1a1a/#202020 原阶梯）。过程组折叠条、诊断卡、代码块、表格、Extension/Notify 卡全部经 token 自动变白卡。
- 用户气泡新增专属 token `--color-chat-bubble-bg`：浅色 = panel（白卡，替代旧 accent 4%+muted 的 #EBEBEB 灰板）；暗色 = 旧公式 color-mix(accent 4%, muted)（#2E2E2E 提亮卡，维持既有层级）。
- 输入框（composer-box = bg-card 白 + 边框 + shadow-composer-lifted）与用户气泡/代码块同一「白卡」语言，上下呼应。

### 7.3 墨水罩染弱表面（`--color-surface-ink*`）

新增两个从 text-primary 派生的半透明 token（明暗自动取正确方向，暗色即白墨水提亮）：

- `--color-surface-ink-subtle`（3%）：引用块、代码块/表格头部条、表格斑马纹——替代旧的 accent-soft 55% 混面板（带锌蓝调，中性纪律破口）与 panel/muted 混色（白卡化后混成纯白失去分层）。
- `--color-surface-ink`（5%）：行内代码、过程组图标底/统计徽标、代码块语言 pill、轮次模型 chip（TurnRow 旧 `bg-muted/60` 在画布上只剩 Δ2 几乎不可见）。

### 7.4 落地后的浅色阶梯（截图像素实测）

sidebar #F0F0F0 → 画布 #F8F8F8 → 罩染弱表面 #F1F1F1（3% 落画布）/ #EDEDED（5% 落画布）→ 白卡 #FFFFFF → 卡上罩染 #F4F4F4。从六档散灰收敛为「一画布 + 一罩染机制 + 一白卡档」；暗色全部维持原值（气泡 #2E2E2E、行内码 #262626、引用白墨水 3%）。

### 7.5 守卫与巡检

- `tests/darkFixedChatColors.test.mjs`：浅色 chat token 钉值更新为白卡；新增 bg-page/bubble/surface-ink 派生关系钉；表格头部/表头断言从 color-mix 换 surface-ink。
- `tests/themeContrast.test.mjs`：`resolve()` 支持 `color-mix(var(--a) N%, var(--b))` 双 var 派生；FACES 补 `bg-page`（会话正文最长阅读底进矩阵）。
- `e2e/visual-tune-session.spec.ts`：会话区明暗截图巡检（手动跑，不进门禁），输出 test-results/visual-tune/。

## 八、Phase 6 变更明细（右抽屉表面定版：chrome 实验回退 + 工具 pill 降档）

全区域审计（`e2e/visual-tune-surfaces.spec.ts`，明暗 × 文件树/Git/浏览器/设置/配置/公告）曾把右抽屉统一退到 chrome 档（=sidebar #f0f0f0）求左右对称；**用户裁决回退**（2026-10）：抽屉是内容型工具面，白面板上无色阶噪声更符合预期，粘性目录行/吸顶工具行的白底在灰面板上反而变成补丁、「乱七八糟」。最终态：

- **右抽屉维持白面板**（bg-background / --color-bg-panel）：抽屉根（.detail-drawer）、活动栏（.drawer-activity-rail）、会话历史顶栏（.drawer-header）、文件树吸顶工具行、GitPanel 根与 `--git-panel-bg/hover/active`（workspace.css）、`.browser-panel`（surfaces.css）全部回退原值。
- **会话画布档不受影响**：chat-pane 仍铺 `--color-bg-page`（#f8f8f8）。最终三段 = 侧栏 #F0F0F0 | 会话 #F8F8F8 | 右抽屉 #FFFFFF——轻微不对称是用户接受的取舍。
- **工具按钮常驻灰 pill 降档**（本轮唯一保留的新改动方向：灰底别太深）：文件树工具行的切换态 pill（折叠包/搜索激活，`bg-accent` #e4e4e4 Δ27 偏深且常驻可见）降为 `bg-muted`（#f4f4f4 Δ11）；hover 反馈维持全局 ghost 行为不变。
- 文件树行/文件搜索行 hover 回退 `bg-muted`（白底上轻档可见；chrome 实验期的 bg-bg-hover 深档一并回退）。
- `drawerCompositorAnimation` 钉值回退 hover:bg-muted；foundation `--color-bg-sidebar` 注释同步（右抽屉不再声明为 chrome 档）。
- 壁纸模式不受影响：BG_TOKENS 与 utilities 层透明化覆盖均按 token 名生效，回退后照常。
- 弹窗审计结论不变：设置/配置管理/公告中心为「白弹窗 + 45% 遮罩 + 灰导航/白内容」结构，无散灰断阶，不动。
- 既有红记录（非本批回归，未顺手修）：drawer.spec.ts / browser-tabs.spec.ts 断言 browser tab 默认在 rail 可见，与 pinnedPanels 重构后的现实不符。

## 九、Phase 7 变更明细（排版对齐：标题压平 + 行内码缩档 + 按钮紧凑）

真值来源：`zai-org/ZCode` 的 `DESIGN.md` 与 `packages/ui/src/styles.css`（2026-10 经 web 通道重新核对全文）。核心结论：字号派生制 PiDeck 已对齐（14 基准 ± 档、h-6~9 控件高、4/8/12/16 间距节奏全同构），**差距集中在三处**：

- **Markdown 标题刻度压平**：ZCode「标题不比正文响」——h1 只 +4px（ratio 1.29@14 基准）、h2 只 +2px、h3 起同字号纯靠字重（h3/h4 semibold、h5 medium、h6 normal）。PiDeck 旧 1.5/1.28/1.12/1.08em 在 16px 正文下 h1 冲到 24px（ratio 1.5），比 ZCode 响一截。改为 **1.3/1.15/1.06/1.03em**（≈+4.8/+2.4/+1/+0.5px），双轨同步（timeline.css `.markdown-body h*` + streamdownChrome.css `heading-*`），守卫钉值更新（streamdownRenderer）。
- **行内代码缩一档**：ZCode inline code = ui-sm（−2 档，12px@14 基准）；PiDeck 行内码原继承正文字号，等宽字面面积大、成行内最响元素。`.markdown-body :not(pre) > code` 加 `font-size: 0.875em`（16→14px，恰 −2 档）。
- **按钮默认档紧凑化**：ZCode button default = `h-8 px-3 py-1.5`（shadcn 原版 h-9 px-4 在其上显松）；PiDeck ui-shadcn button default 从 `h-9 px-4` 改 `h-8 px-3 py-1.5`，弹窗主操作密度提升。sm 档（h-8 px-3）保持不变，两档视觉等高、sm 保留 gap-1.5 图标行语义。
- 核对后**不动**的：滚动条（ZCode 全局药丸滚动条 vs PiDeck `scrollbar-width: thin` 标准方案——foundation 有明确事故注记「Chromium 121+ 声明 scrollbar-width 后忽略 webkit 伪元素」，不回退）；菜单行字号（shadcn text-sm=14px 已等于 ZCode ui-base）；行高/段距/间距节奏（已同构）；tracking（ZCode 0.09em 仅限 9-10px 大写等宽标签，PiDeck 现有 0.03em lang chip 足够）。
- 巡检：mock-pi 新增 `HDEMO` 标题演示消息（只增分支不影响既有用例），visual-tune-session 消息序列加入 HDEMO 验证标题刻度。
- 既有红记录（改动文件回退到基线复跑核实，非本批回归）：settings.spec「appearance theme switch」在关闭弹窗一步失败、ask-ui「多 pending」卡 `.session-tab[aria-selected]` 选择器。

## 十、Phase 8 变更明细（过程层去阴影：淡如 ZCode、回复凸显）

用户反馈：表格/工具调用/思考带「灰色阴影条」，过程层应像 ZCode 一样淡、回复明显；Git 摘要生成按钮背景不佳。computed-style 全量枚举 + 运行态截图定位后五处收口：

- **移除 `turn-row--running::before` 呼吸洗底**（accent 3% × 2.2s 呼吸动画，inset -6/-8px 的大片洗底即「灰色阴影条」本体）及 `turn-running-breathe` keyframes——运行感由图标 pulse/扫光单独承担，过程行运行中也保持无框无底。ZCode 过程层无任何整片运行底色。
- **`.tool-activity-card` 运行占位卡去阴影/渐变**：`0 4px 14px accent 8%` 投影 + accent 8% 渐变底 + accent 32% 边框 → 白卡（panel）+ border-subtle 混 accent 22% 一缕身份色 + `box-shadow: none`；入场/扫光动画保留。
- **`.execution-summary-toggle:hover` 去投影**（0 3px 12px 7%）：hover 只变色/边框，ZCode hover 纪律。
- **`.user-turn-bubble` 去常驻投影**（0 2px 8px 5% 及 hover 4px 12px 一并移除）：深度靠底色对比 + 边框；全时间线唯一保留浮起阴影的是底部输入框（--shadow-composer-lifted）。
- **Git 摘要生成按钮 outline → ghost**：去边框/白底/shadow-xs，辅助动作退为图标级，与主「提交」按钮主次分明。
- 表格核实无 box-shadow（streamdownChrome 两处均 none），用户感知的表格阴影即运行态洗底/卡片投影的组合，随上列移除一并消失；落定态 computed 枚举确认时间线阴影仅剩输入框（在时间线外）。

## 十一、Phase 9 变更明细（右抽屉画布提亮半档：与正文区分又不刺眼）

Phase 8 后用户反馈：右抽屉纯白（bg-background）比正文画布 #f8f8f8 亮一档「太白」；完全对齐画布后又裁决「别太一致，稍微白一点有区分」。最终引入 **`--color-bg-page-raised`（画布提亮半档）**：

- 定义：`color-mix(in srgb, var(--color-bg-page) 55%, var(--color-bg-panel))`——经典浅色 #fbfbfb（正文 Δ3 / 纯白 Δ4），由 page/panel 派生：暗色 page=panel 自动坍缩为同值（暗色本就整页同底无需区分），皮肤自动落在自身两档之间，壁纸模式两 token 同批注入半透明自动跟随。
- 应用面（Phase 8 的 chrome 实验面逐点换成 raised，替代原 bg-background）：`.detail-drawer` 根、`.drawer-activity-rail`、`.drawer-header`、文件树吸顶工具行与粘性目录行（粘性行必须不透明，否则滚动内容透出）、GitPanel 根 + `--git-panel-bg/hover/active`、`.browser-panel`。白卡（Git 提交/筛选输入框、浏览器地址栏、会话历史卡、GitGraph 浮层）保持 panel 纯白，在 raised 上浮起 Δ4。
- 像素实测阶梯：侧栏 #F0F0F0 → 正文 #F8F8F8 → 抽屉 #FBFBFB → 白卡 #FFFFFF；暗色抽屉=panel 不变。
- 与 Phase 6 的关系：当时的教训不是「抽屉不能退档」而是「不能退到 sidebar chrome 档（Δ8 过深）且半途而废留白条补丁」；raised 只退半档且粘性行/工具行全部同批换色，无补丁。
