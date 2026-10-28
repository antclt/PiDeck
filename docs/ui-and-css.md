# UI 与样式（Tailwind v4 + shadcn + 旧轨迁移）

> 改渲染层布局、颜色、组件样式、引入 UI 依赖前读本文。

## 基本约定

- 新增 UI 复用 `src/renderer/src/components/ui-shadcn/` 共享原语；不用原生 `<select>`、不裸写 `<input>`。
- 图标统一 `lucide-react`；品牌 Logo 用 `LogoMark`。
- 颜色/圆角/字号复用 `styles/` 语义 token，暗色模式自然适配。
- 布局保持桌面工作台结构：左列表 / 中会话 / 右抽屉 / 底终端。
- 跨组件状态只用 Jotai（`atoms/` 按域建 atom）；副作用放 hook，视图放 component；禁止引入第二种全局状态方案。
- 文案走 i18n（见 `docs/engineering-standards.md` §i18n）。

## CSS 双轨

旧轨 = 手写语义 class（`styles/{foundation,timeline,surfaces,integrations,workspace}.css`）；新轨 = Tailwind v4 + shadcn（`styles/tailwind.css`、`components/ui-shadcn/`）。

**禁止 big-bang 全量重写，禁止第三套视觉语言。** 口诀：视觉上「新学旧」，代码上「改到哪，旧迁新到哪」。

1. **Token 以旧 foundation 为准**：新栈经 `@theme` 桥接同一套 token，不另起平行色板。
2. **新改动只写 Tailwind + shadcn**：禁止新增手写 CSS class（token、keyframes、既有 `tone-*` / `status-*` 锚点除外）；改某块 UI 时把抢同属性的旧规则删掉或收窄。
3. **Cascade 层序不可改错**（`tests/cssCascadeLayers.test.mjs`）：`theme < base < components < vendor < legacy < utilities`。legacy 必须高于 base（否则 preflight 冲掉手写外观），低于 utilities（否则 Tailwind 不生效）；旧文件只在入口用 `layer(legacy)` 引入，禁止文件内部再包 `@layer`。
4. **`!important` 会反转层优先级**：碰到旧规则的 `!important` 删掉或收窄，不给 utility 堆 `!`。半吊子 utility 比没写更糟——utility 必须对齐原视觉再删冗余 legacy 声明。
5. **`--color-accent` 是「面」不是「字」**：`text-accent` 会解析成悬停面色（亮暗色都是字底同色 → 文字消失）。面上的正文用 `text-accent-foreground`；主题强调色文字用 `text-primary`。守卫：`tests/storeSuggestionChipContrast.test.mjs`。
6. **限高 flex 列的子项必须 `shrink-0`**（近期排版事故）：`overflow-y-auto` + `max-h-*` 容器里，子项带 `overflow:hidden` 后 `min-height:auto` 被清零 → 内容被线性压缩成横条且滚动条不出现。给限高容器子项加 `overflow-hidden` 时必须同步 `shrink-0`。守卫：`tests/sessionTodoStrip.test.mjs` + `e2e/todo-strip-scrollbar.spec.ts`。
7. **utility「看不见」时用 DevTools 看胜出规则来自哪一层**，先处理冲突源再改 class。

## Markdown 语义色（`--color-md-*`）

Markdown 渲染（streamdown）的颜色一律走 `--color-md-*` 语义 token，**不要在组件里写死颜色，也不要新增手写 md CSS class**。`foundation.css` 的 `:root` 默认值等于改造前的写死值（标题/行内码=正文色、链接=正文色、引用=次级文字），所以加 token 本身零观感变化。

| token | 作用 | `:root` 默认 |
|---|---|---|
| `--color-md-heading` | h1–h5 标题（h6 仍是 `text-secondary`） | `var(--color-text-primary)` |
| `--color-md-link` | 正文链接 | `var(--color-text-primary)` |
| `--color-md-code` | 行内码（代码块内文字由 Shiki inline style 决定，不受此 token 影响） | `var(--color-text-primary)` |
| `--color-md-quote` | 引用文字 | `var(--color-text-secondary)` |
| `--color-md-quote-border` | 引用左侧竖条 | `color-mix(in srgb, var(--color-text-secondary) 30%, transparent)` |
| `--color-md-list-bullet` | ul `::marker` / ol `::before` 序号 | `var(--color-text-primary)` |
| `--color-md-hr` | 分割线 | `var(--color-border-default)` |
| `--color-md-strong` | 加粗 `<strong>` | `inherit`（跟随所在文字色） |
| `--color-md-em` | 斜体 `<em>` | `inherit` |
| `--color-md-del` | 删除线 `<del>` | `var(--color-text-secondary)` |
| `--color-md-inline-code-bg` | 行内码底色 | `var(--color-bg-muted)` |
| `--color-md-frame` | 表格 / 代码块外框线 | `var(--color-border-subtle)` |
| `--color-md-table-border` | 表格单元格分隔线 | `var(--color-border-subtle)` |
| `--color-md-table-head-bg` | 表头底色 | `var(--color-surface-ink-subtle)` |
| `--color-md-table-head-text` | 表头文字 | `var(--color-text-secondary)` |
| `--color-md-task-accent` | 任务列表勾选框（`accent-color`） | `var(--color-accent)` |
| `--color-md-image-border` | 图片边框 | `transparent` |
| `--font-family-md` | Markdown 正文字体 | `var(--font-family-base)` |

**为什么有一半规则写在 `streamdownChrome.css`**：streamdown 给元素自带 utility 颜色（链接 `text-primary`、引用 `text-muted-foreground`、hr `border-border`），同样在 `utilities` 层，legacy 层的高 specificity 规则也压不住。所以这些覆盖必须写在 `streamdownChrome.css`（`@layer utilities`，且 `@import` 排在 `tailwind.css` 之后）；标题、行内码没有 utility 颜色，仍由 `timeline.css` 负责。
文件链接（`data-md-file-link`，`MarkdownLink.tsx` 为可点击本地/文件引用加的自定义属性）固定为 `--color-accent`，不跟随 `--color-md-link`，避免改 md 链接色时连带改掉「可打开文件」这一语义。
代码块里的 token 颜色由 Shiki 生成的 inline style 决定，CSS 变量管不到；终端皮肤另带一套 Shiki 主题（`src/renderer/src/components/session/markdown/piTuiShikiThemes.ts`，`MarkdownStream` 按 `data-appearance` 换 `createCodePlugin`），移植 TUI 语法高亮时就改那个文件。

## 主题皮肤与自定义主题

- 皮肤 = `data-appearance`，定义在 `foundation.css`（`:root[data-appearance="x"]` 浅色 + `:root[data-theme="dark"][data-appearance="x"]` 暗色两块），id 在 `AppSkinId`（`shared/types/settings.ts`）与 `SKIN_PRESETS`（`themePresets.ts`）同步。
- 内置 `terminal` 皮肤是 pi TUI 主题的**成套移植**（不是只借 md 色）：面色取 TUI `pageBg/cardBg`、文字取 `text/muted/dim`、边框取 `border/borderAccent`、气泡底色取 `userMessageBg`、`--font-family-base` 直接换成等宽（整屏等宽）、`--radius-*` 全归零成方框，再加 `terminalSkin.css` 的 `⏺`（助手轮）/ `❯`（用户消息）标记、表头大写标签、代码块头部等宽。它同时是 `--color-md-*` 的第一个实际消费者，可当新增皮肤的模板。
  移植时的硬约束：**状态语义色（`--color-info`/`--color-warning`/`--color-danger`/`--color-success` 及其 soft/strong）不许被皮肤覆盖**（状态灯跨主题恒定，守卫 `tests/appearanceThemes.test.mjs`），皮肤只能改装饰色（面/字/边框/md/代码/chip）。
- 皮肤专属的形状 chrome 放 `styles/terminalSkin.css`（`@import … layer(utilities)` 排在 `streamdownChrome.css` 之后，才能压过 Tailwind 布局 utility），色值仍在 `foundation.css` 皮肤块里。
- 内置 `glass`（毛玻璃）/ `liquid-glass`（液态玻璃）是**半透明玻璃**皮肤：面色 token 直接带 alpha（`rgba()`），靠 `--app-glass-canvas` 的光雾画布 + `glassSkin.css` 的 blur 出玻璃感。三条硬约束：
  1. **画布层**：`body::before` 已被壁纸占用，玻璃画布走 `body::after`（同为 `z-index:0`、后绘制，仍在 `#root{z-index:1}` 之下；开启壁纸时让位）。`--app-glass-canvas` / `--shadow-*` / `--radius-*` 的覆盖必须写在 `foundation.css`（未分层）——`glassSkin.css` 被 `layer(utilities)` 包裹，压不过 `:root` 的未分层声明。
  2. **组件透明化**：`.wechat-shell`/`.simple-shell` 带 `bg-bg-app` 实底，必须显式 `background: transparent` 才透得出画布；贴边条（`session-tabs-bar`/`chat-header`/`drawer-activity-rail`/`window-controls`）同步透明，否则与半透明面板叠成「双层磨砂带」（同壁纸模式的处理）。
  3. **对比度口径**：`tests/themeContrast.test.mjs` 的 `parseColor` 忽略 alpha，面 token 的 RGB 要写成「叠在画布上合成后的观感色」；改面色后需另按 alpha 叠到画布渐变的极端色（最亮/最暗角）重算一遍，否则测试算的不是用户看到的颜色。
  另外：blur 只挂小体积浮层（侧栏 + dialog/popover/tooltip/copy-menu），不挂 `.chat-pane` 长列表（每帧滚动重算模糊）；玻璃皮肤**不覆盖** `--color-accent`，accent 交给 `data-accent` 块（皮肤块写会被暗色 accent 块的特异性压过）。
- 新增皮肤必须带齐 16 个必需 token（面色/灰阶）+ 亮暗两块；守卫：`tests/appearanceThemes.test.mjs`（id 列表与 token 完整性）、`tests/themeContrast.test.mjs`（把皮肤加进 `APPEARANCES`，按 WCAG 校验正文/md 文字对）。
- 用户侧可定制范围由 `src/shared/customThemes.ts` 的 `CUSTOM_THEME_TOKEN_GROUPS` 决定（颜色值必须是 `#hex`/`rgb()`/`hsl()`/`oklch()` 静态形式）；`markdown` 组让自定义主题包也能改标题/链接/行内码/引用/列表符/分割线/加粗斜体删除线/表格/任务勾选/图片边框颜色，`font` 组让主题包改字体，指南页由 groups 自动生成。
- **主题包 `base` 继承内置皮肤**：主题包可写 `"base": "terminal"`（可选值 = `CUSTOM_THEME_BASE_SKINS`，即 `SKIN_PRESETS` 全部 id 去掉 `custom`）。应用时 `settings.themeSkin` 直接落到该皮肤（不是 `"custom"`），因此内置皮肤的 CSS 块与形状 chrome（等宽/方角/`⏺`/blur/画布）整套继承，主题包只需写想改的 token；不写 `base` 时仍走裸 `custom` 皮肤（无内置色板，需写全）。生效判定在 `useAppAppearance.ts` 的 `activeCustomTheme()`（`themeSkin === "custom"` 或 `=== customTheme.base`），同步守卫：`tests/appearanceThemes.test.mjs`（`CUSTOM_THEME_BASE_SKINS` 与 `SKIN_PRESETS` 逐项相等 + 应用侧源码契约）。
- **字体 token**：`--font-family-base` / `--font-family-mono` / `--font-family-md`，值走独立白名单 `FONT_VALUE_PATTERN`（字母/数字/空格/逗号/引号/连字符/下划线/点，≤120 字符，排除 `;(){}:/` 等注入面），内部快照键是 `font-family-*`（不是 `--color-*`），注入时由 `customThemeCssVar()` 拼回 `--font-family-*`。
- 字体优先级：**设置页里显式选的自定义字体 > 主题包字体 > 内置皮肤/默认值**，集中在 `applyFontFamilyTokens()`（`hooks/appearance/useAppAppearance.ts`）算一次最终值，`applyCustomThemeTokens()` 末尾也调它，避免两处 `removeProperty` 互相抹掉。

## beUI 组件迁移

- 安装走 CLI（`npx shadcn add @beui/<name>`），不手动复制源码；文件存在加 `--overwrite`。
- `lib/ease.ts` / `lib/utils.ts` / `agents/agent-disclosure.tsx` 保持官方原版，禁止存私有曲线值（历史上曾改私有值导致每次安装被 CLI 连坐覆盖）；运动常量统一从 `@/lib/ease` 取。
- 迁移惯例：文件放 `components/<域>/`，头部保留 `// beui.dev/components/<path>` 注释，文案走 i18n。
