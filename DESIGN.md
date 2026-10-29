---
name: PiDeck
description: Multi-project desktop workbench for local coding agents
colors:
  ink: "#18181b"
  ink-strong: "#09090b"
  ink-soft: "#e5e7eb"
  paper: "#ffffff"
  rail: "#f0f0f0"
  canvas: "color-mix(in srgb, #ffffff 55%, #f0f0f0)"
  canvas-raised: "color-mix(in srgb, #ffffff 72%, #f0f0f0)"
  ash: "#f4f4f4"
  ash-hover: "#eaeaea"
  ash-active: "#e4e4e4"
  charcoal: "#202124"
  slate: "#4a4a4a"
  graphite: "#666666"
  mist: "#9a9a9a"
  ink-inverse: "#ffffff"
  hairline: "rgba(13, 13, 13, 0.1)"
  hairline-strong: "rgba(13, 13, 13, 0.13)"
  hairline-bold: "rgba(13, 13, 13, 0.17)"
  danger: "#b42318"
  success: "#14703a"
  warning: "#854d0e"
  info: "#1d4ed8"
  thinking: "#6366f1"
  code-surface: "#111418"
  code-ink: "#d1d5db"
typography:
  wordmark:
    fontFamily: "PiDeckDepartureMono, ui-monospace, monospace"
    fontSize: "18px"
    fontWeight: 700
    letterSpacing: "0.02em"
  accent-serif:
    fontFamily: "PiDeckPlantin, Georgia, Times New Roman, serif"
    fontSize: "14px"
    fontWeight: 400
  heading:
    fontFamily: "system UI stack with CJK fallbacks"
    fontSize: "20px"
    lineHeight: "28px"
    fontWeight: 600
  title:
    fontSize: "16px"
    lineHeight: "24px"
    fontWeight: 600
  body:
    fontSize: "14px"
    lineHeight: "22px"
    fontWeight: 400
  chat:
    fontSize: "16px"
    lineHeight: "1.6"
    fontWeight: 400
  control:
    fontSize: "13px"
    lineHeight: "20px"
    fontWeight: 500
  caption:
    fontSize: "12px"
    lineHeight: "18px"
    fontWeight: 400
  micro:
    fontSize: "11px"
    lineHeight: "16px"
    fontWeight: 400
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, Cascadia Code, monospace"
    fontSize: "13px"
    lineHeight: "1.7"
    fontWeight: 400
  dense-micro:
    fontSize: "10px"
    lineHeight: "12px"
    fontWeight: 500
  boot-wordmark:
    fontFamily: "PiDeckDepartureMono, ui-monospace, monospace"
    fontSize: "40px"
    fontWeight: 700
    letterSpacing: "0.06em"
rounded:
  hairline: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  bubble: "14px"
  pill: "999px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-inverse}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-primary-hover:
    backgroundColor: "color-mix(in srgb, #18181b 90%, transparent)"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.charcoal}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.charcoal}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.charcoal}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "4px 12px"
  badge-status:
    backgroundColor: "color-mix(in srgb, #14703a 15%, transparent)"
    textColor: "{colors.success}"
    rounded: "{rounded.md}"
    padding: "2px 6px"
---

# Design System: PiDeck

## Overview

**Creative North Star: "The Ink Workbench"**

PiDeck 的界面像一张摊开的制图台：纸是白的，线是墨的，工具放在手边而不是摆在橱窗里。它默认不使用彩色——浅色主题是白纸、灰轨、近黑的动作色，深色主题是把同一张纸反相成 `#121212` 的炭面。颜色只在有语义的时候出现：成功、警告、危险、工具、思考。

密度是它的性格。11px 的微标签、13px 的控件文字、14px 的界面正文、16px 的会话正文——四档各司其职，没有为了"显大气"而放大任何一档。层级靠底色阶梯（画布 → 白卡）和 0.1 透明度的墨线建立，而不是靠投影。整块时间线里唯一长期保留投影的元素是底部输入框：它需要"浮起来"，其它所有东西都应该"贴住"。

动效是功能性的，不是表演性的。三档时长（120 / 200 / 320ms）覆盖微反馈、常规、面板级切换，缓动统一，布局动画只动 transform 与 opacity。

**Key Characteristics:**
- 单色默认：中性灰阶 + 一个可替换的主题色，同一屏不出现两个强调色
- 墨线而非灰线：边框用 `rgba(13,13,13,.10/.13/.17)` 的透明墨水，随底色自动融合
- 白卡浮于画布：内容面比画布亮一档，深度靠色阶不靠阴影
- 紧凑四档字号：11 / 13 / 14 / 16，会话正文单独一轨
- 静默界面：无渐变装饰、无玻璃拟态、无彩色图标墙

## Colors

一套中性墨阶 + 一个主题色 + 四个状态色的克制调色板；颜色是信息，不是装饰。

### Primary
- **Ink Black** (#18181b): 默认主题色。主按钮底、选中态、focus ring 的外圈基准。它是"最重的墨"，不是品牌色。
- **Lamp Black** (#09090b): ink 的加深档，用于 hover、聚焦环、需要压过背景的描边。
- **Ink Soft** (#e5e7eb): 主题色的淡底，用于下拉 hover / 选中高亮。

主题色可由用户在设置里换成绿 (`#4a7854`)、蓝 (`#2563eb`)、紫 (`#7c3aed`)、琥珀 (`#b45309`)、玫红 (`#e11d48`)。换色只替换 `--color-accent` 家族，其它语义色不动。

### Neutral
- **Paper** (#ffffff): 应用底、面板底、卡片底。浅色主题里"内容"就是纸。
- **Rail** (#f0f0f0): 左侧项目 / 会话栏。比纸暗一档，形成"轨道"而不是"另一个面板"。
- **Canvas** (`color-mix(in srgb, #ffffff 55%, #f0f0f0)`): 会话画布。白卡（消息气泡、输入框）浮在它上面，这是全系统最重要的一次色阶差。
- **Canvas Raised** (`color-mix(in srgb, #ffffff 72%, #f0f0f0)`): 右抽屉的提亮半档，比画布更接近白。
- **Ash** (#f4f4f4): 弱面——行内代码底、引用块、徽章底、空态底。
- **Ash Hover** (#eaeaea) / **Ash Active** (#e4e4e4): 悬停与选中。列表行默认无底，hover 才出现。
- **Soft Charcoal** (#202124): 主文字。不是纯黑——纯黑在长阅读里太硬。
- **Slate** (#4a4a4a): 次级文字、说明、时间戳。
- **Graphite** (#666666): 三级文字、元信息。
- **Mist** (#9a9a9a): 最弱文字、占位符、禁用。
- **Hairline** (`rgba(13,13,13,0.1)`) / **Hairline Strong** (0.13) / **Hairline Bold** (0.17): 三级描边。透明墨水叠在任意底色上都能自洽，这是它优于 `#e5e5e5` 的原因。

### Secondary
- **Tool Blue** (#1d4ed8): 工具调用行的图标与状态。工具不是"链接"，是"工具"。
- **Thinking Indigo** (#6366f1): 思考行的图标。与工具蓝刻意区分，两行并排时能一眼分开。

### Tertiary
- **Danger** (#b42318) / **Success** (#14703a) / **Warning** (#854d0e): 状态三色。暗色主题下整体提亮到 400 档（`#f87171` / `#4ade80` / `#fbbf24`），soft 底换成深色版本，不允许浅色 soft 底漏进暗色界面。
- **Code Surface** (#111418) / **Code Ink** (#d1d5db): 代码块固定深底，不随主题反转——代码永远是"另一块屏"。

### Documented Exceptions

这些值**不属于**调色板漂移，已登记在 `.impeccable/config.json` 的 detector 豁免里，改动它们时不需要同步 DESIGN.md：

- **语法高亮**：`--code-keyword` / `--code-string` / `--code-comment` 等（GitHub dark 系），只在代码块内生效，随主题切换。
- **第三方品牌标识**：飞书 `#3370FF`、微信 `#2cb35c`、MCP 服务图标原色 —— 品牌原色不得改。
- **二维码 / 画布**：黑白矩阵色、Logo 渐变、宠物美术色。
- **终端配色**：`terminalThemes.ts` 是终端 ANSI 调色板，与 UI 调色板无关。
- **阴影与兜底**：`rgba(0,0,0,.08)` 这类阴影色、`var(--color-danger, #dc2626)` 里的兜底值不算调色板成员。
- **Web 远端界面**：`web/web.css` 是独立的第二套语言——逐字取自官方 `@deepseek-ai/dsh-web-frontend` 的 alias token（含自己的亮/暗值），只作用于 Web 页面。它与桌面端调色板**故意不同**，不要为了"统一"把它并入 foundation。

### Named Rules

**The One Accent Rule.** 一个界面里只有一个强调色。它由用户的主题设置决定，不能被局部覆盖成第二个品牌色。强调色占屏面积控制在 10% 以内。

**The Ink Line Rule.** 边框永远用墨水的 alpha（`.10/.13/.17`），不用不透明灰。同一屏里出现 `#e5e5e5` 这类实色边框就是错的。

**The Status Never Borrows Brand Rule.** 成功/警告/危险/信息只用自己的语义 token。禁止写 `emerald-500` / `amber-400` / `rose-500` 这类字面色——那会让同一状态在浅色、暗色、皮肤三套环境里长成三种颜色。

## Typography

**Wordmark Font:** PiDeckDepartureMono（打包的像素等宽字体）——只用于侧栏与关于页的品牌字标，不进正文。
**Accent Serif:** PiDeckPlantin（可变字重 300–900，`Georgia` 兜底）——只用于设置页数字读数与空态标题的斜体强调，是唯一允许的衬线用法。
**Body Font:** 系统 UI 栈，CJK 优先（`-apple-system, "Segoe UI Variable Text", "Microsoft YaHei UI", "PingFang SC", "HarmonyOS Sans SC", "Noto Sans CJK SC"`）。
**Mono Font:** `ui-monospace, SFMono-Regular, Menlo, Consolas`，后面接同一套 CJK 回退——中文在 11px 等宽小字里必须命中 UI 字体，落到宋体会糊。错误边界另用 `Cascadia Code` 作为等宽回退。

**Character:** 系统原生、不加载 webfont。界面读起来应该像操作系统的一部分，而不是一个网页。中文优先意味着行高比西文排版更松：正文 22px 行高配 14px 字号。

### Hierarchy
- **Heading** (600, 20px / 28px): 页面级标题、设置分组标题。
- **Title** (600, 16px / 24px): 面板标题、会话标题、对话框标题。
- **Body** (400, 14px / 22px): 界面正文、设置项说明。
- **Chat** (400, 16px / 1.6): 会话正文。独立一轨，不随"界面字号"缩放，只随"会话字号"缩放——读代码解释和读设置项是两种阅读行为。
- **Control** (500, 13px / 20px): 按钮、输入框、下拉、菜单项。控件统一 13px，比正文小一档是刻意的。
- **Caption** (400, 12px / 18px): 元信息、时间戳、次要标签。
- **Micro** (400, 11px / 16px): 徽章、Tab 标题、极密集的辅助信息。
- **Dense Micro** (500, 9–10px): 只允许出现在徽章计数、行内 chevron、widget 弹层这类"一个字符也要塞进去"的位置。它随界面字号缩放，不是新的一档阅读字号。

字号不是固定像素：`data-ui-font-size`（紧凑/默认/宽松）整体缩放界面档，`data-chat-font-size` 单独缩放会话档。任何新字号都必须挂到已有 token 上，不能写裸 `text-[13px]`。

### Named Rules

**The Four-Step Rule.** 界面字号只有 11 / 13 / 14 / 16 四档（加 20 的 heading）。出现第五档就是层级失控。

**The Chat Is Its Own Track Rule.** 会话正文用 `--text-chat`，不跟随界面字号设置。混用会让"把界面调大"变成"把聊天记录也调大"。

## Layout

三栏可拖拽工作台，宽度以像素为单位而不是百分比：

- **列表栏（List）** 默认 221px，范围 208–440px，可折叠到 0。项目树 + 会话列表住在里面，底色是 Rail。
- **会话栏（Chat）** 最小 360px，占满剩余。内部是画布（Canvas）上的白卡序列：头部、时间线、底部输入框。正文列有最大阅读宽度，居中。
- **抽屉栏（Drawer）** 默认 320px，范围 240–880px（钉住时下限 260px），可折叠到 0。文件、Git、浏览器、活动流都在这一栏里横向切换。

密度是紧凑的：行高 28–32px，控件 32–36px，面板内边距 12–16px。间距走 Tailwind 默认的 4px 网格，没有自定义 spacing token——这意味着新代码写 `p-3`/`gap-2` 而不是发明 `--spacing-panel`。

窗口是桌面应用：自定义标题栏与 Tab 栏共用一条底边线，窗口控件在右侧。窄窗口下抽屉优先折叠，列表其次，会话栏永远保留。

## Elevation & Depth

混合体系，但以"色调分层"为主：画布比纸暗、白卡比画布亮，深度靠这两级色阶表达。阴影是被严格配给的资源。

- **时间线内的一切**（消息、工具行、思考行、用户气泡）没有投影。用户气泡靠 `border-color: color-mix(accent 16%, border)` 的淡描边和底色差浮起。
- **输入框** 是唯一常驻投影的内容元素：静置 `0 1px 2px rgba(9,9,11,0.05)`，聚焦/抬升时 `0 2px 12px rgba(9,9,11,0.06)`。
- **浮层**（popover / 菜单 / 对话框）用 `--shadow-popover`、`--shadow-modal`，暗色主题加深到 0.4/0.45 alpha。
- **抽屉** 用 `-4px 0 12px rgba(9,9,11,0.06)` 向右投，暗示它压在内容之上。

### Shadow Vocabulary
- **Composer** (`0 1px 2px 0 rgba(9,9,11,0.05)`): 底部输入框静置态。
- **Composer Lifted** (`0 2px 12px rgba(9,9,11,0.06), 0 1px 3px rgba(9,9,11,0.04)`): 输入框聚焦 / 有内容时。
- **Popover** (`0 4px 6px -1px rgba(9,9,11,0.1), 0 2px 4px -2px rgba(9,9,11,0.1)`): 下拉、菜单、tooltip。
- **Modal** (`0 10px 15px -3px rgba(9,9,11,0.1), 0 4px 6px -4px rgba(9,9,11,0.1)`): 对话框。
- **Drawer** (`-4px 0 12px rgba(9,9,11,0.06)`): 右抽屉。
- **Border** (`0 0 0 1px rgba(9,9,11,0.06)`): 用阴影画 1px 描边，避免布局抖动。

### Named Rules

**The Flat Timeline Rule.** 时间线里的任何一行都不加 box-shadow。工具行、思考行、消息卡都不例外。需要"这是一块东西"时，用底色差和左竖线，不用投影。

**The One Floating Element Rule.** 一屏之内最多一个元素"浮着"——通常是输入框。第二块浮起的东西出现时，界面就开始像仪表盘拼贴。

## Shapes

形状语言是克制的圆角矩形，没有斜切、没有大圆角胶囊（pill 只给 Git ref 这类真正的标签用）。

- **4px** (`xs`)：键帽、行内小方块、极紧凑的标签。
- **6px** (`sm`)：小徽章、头像容器、嵌套卡片。
- **8px** (`md`)：默认档。按钮、输入框、下拉、菜单项、卡片、工具行。
- **10px** (`lg`)：面板级容器、对话框。
- **12px** (`xl`)：大卡片、空态容器。
- **999px** (`pill`)：Git 分支标签、状态胶囊。
- **2px**：8px 小方块（图表图例、主题色预览块）—— 小尺寸下 4px 会糊成圆形。
- **14px**：用户消息气泡专用，比 `xl` 大半档，因为它是全屏最大的内容容器。

边框统一 1px 墨线；需要强调时加到 2px（只在聚焦环和选中态），不靠颜色加深。分割线一律 1px，不用 2px 以上的"重线"。

## Components

### Buttons
- **Shape:** 8px 圆角（`rounded-md`），默认高 32px（`h-8`）、横向内边距 12px。
- **Primary:** Ink Black 底 + 反白字，13px / 500。暗色主题下自动反相成近白底 + 深字。
- **Hover / Focus:** hover 时背景降到 90% 不透明；`focus-visible` 加 3px 半透明 ring + 1px 边框变色；按下 `scale(0.98)`，120ms。
- **Secondary:** Ash 底 + 主文字色，用于"次要但明确"的动作。
- **Outline:** 透明底 + 1px 墨线，hover 转 Ash Hover 底。
- **Ghost:** 完全透明，hover 才出现底色。侧栏行、图标按钮默认用它。
- **Destructive:** Danger 底 + 白字，只用于不可逆操作。
- **Sizes:** `xs` 24px / `sm` 32px / `default` 32px / `lg` 40px / `icon` 36×36。

### Chips
- **Style:** 8px 圆角、1px 同色系 30% 透明描边、15% 透明同色底、同色文字。状态 chip 只允许 success / warning / danger / info / neutral 五档。
- **Size:** 行内 12px 文字配 2px/6px 内边距；表格状态列固定 20px 高 + 11px 文字。
- **State:** 可点击的筛选 chip 在选中时改用主题色淡底（`accent-soft`）+ 主文字，不换文字颜色。

### Cards / Containers
- **Corner Style:** 8px（内容卡）到 10px（面板）。
- **Background:** Paper；在画布上是"白卡"，在侧栏上是 Ash。
- **Shadow Strategy:** 默认无阴影，见 Elevation。
- **Border:** 1px Hairline；嵌套时降级到 `border-subtle`。
- **Internal Padding:** 12px 常规，16px 宽松，8px 紧凑。

### Inputs / Fields
- **Style:** 36px 高（`h-9`）、8px 圆角、1px 墨线、透明底（暗色下用 30% 输入底），13px 文字。紧凑场景固定 32px（`h-8`）。
- **Focus:** 边框转 ring 色 + 3px 半透明外环，不做发光、不做位移。
- **Error:** 边框转 Danger + 20% 透明外环；错误文字用 Danger 而不是红底块。
- **Contract:** 控件高度只有 36 / 32 两档，禁止在调用处写 `h-7`/`h-10`。

### Navigation
- **Style:** 侧栏是"裸行"——默认无底色、无边框，行高 28–32px，13px 文字。hover 才出现 `bg-hover`，选中用 `bg-active`。
- **Tabs:** 会话 Tab 栏 11px 文字，激活态用底色差 + 底边线，不用下划线动画。
- **Active:** 选中行左侧不加色条；层级靠底色和字重（500）表达。

### Tool Row (signature)
工具调用行是 PiDeck 最有辨识度的组件：**无外框、无面板底、无 hover 投影**。只有图标（Tool Blue）、标题、状态和一行摘要；运行时图标呼吸 + 扫光带（transform-only），展开时靠左侧 1px 竖线而不是卡片。它的存在是为了让一次长任务里的 30 次工具调用读起来像"日志"，而不是"30 个盒子"。

### Composer (signature)
底部输入框是全系统唯一常驻浮起的元素。白卡、8px 圆角、1px 墨线、静置微投影；聚焦时投影加深但不放大。内部工具条与输入区同底，不做"输入区 + 按钮条"的两段式分割。

## Do's and Don'ts

### Do:
- **Do** 用语义 token（`var(--color-text-secondary)`、`bg-bg-hover`），不写字面色。
- **Do** 用 11 / 13 / 14 / 16 四档字号，控件统一 13px。
- **Do** 用 1px 墨线做边框，透明度 0.10 / 0.13 / 0.17 三档。
- **Do** 用 120 / 200 / 320ms 三档时长和统一缓动；布局动画只动 transform 与 opacity。
- **Do** 让列表行默认无底，hover 才出现底色。
- **Do** 状态用 success / warning / danger / info / neutral 五档 badge。

### Don't:
- **Don't** 在时间线行上加 box-shadow——需要分层就用底色和左竖线。
- **Don't** 写 `emerald-500` / `amber-400` / `rose-500` 这类字面状态色。
- **Don't** 用 `transition-all`；把过渡属性写全（颜色、阴影、transform、opacity）。
- **Don't** 在调用处临时改控件高度（`h-7`/`h-10`），只能用 36 / 32 两档。
- **Don't** 引入第二个强调色，或用渐变、玻璃拟态、彩色图标墙做装饰。
- **Don't** 给会话正文套用界面字号缩放——它有自己的轨道。
