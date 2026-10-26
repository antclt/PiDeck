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

## beUI 组件迁移

- 安装走 CLI（`npx shadcn add @beui/<name>`），不手动复制源码；文件存在加 `--overwrite`。
- `lib/ease.ts` / `lib/utils.ts` / `agents/agent-disclosure.tsx` 保持官方原版，禁止存私有曲线值（历史上曾改私有值导致每次安装被 CLI 连坐覆盖）；运动常量统一从 `@/lib/ease` 取。
- 迁移惯例：文件放 `components/<域>/`，头部保留 `// beui.dev/components/<path>` 注释，文案走 i18n。
