# ZCode 视觉质感分析与反哺计划

> 状态：**Phase 1 已落地**（2026-10，d4e60c97c / 730579b0b / 本次 token 调整）；Phase 2/3 为候选方向，按「改到哪，旧迁新到哪」增量推进，不做 big-bang。
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
| 中性灰色相 | 全部 R=G=B / 墨水 alpha | hover/active/文字带锌蓝调 | ✅ Phase 1 已改（本次） |
| 亮色 chrome 层次 | sidebar #f0f0f0 vs panel 白 | sidebar #f7f7f7（过弱） | ✅ Phase 1 已改 #f0f0f0 |
| 暗色表面阶梯 | 每档 +0x0a | panel=popover=#171717 零步长 | ✅ Phase 1 已改（相对浮层色） |
| 边框墨水化 | rgba(ink,0.1) 全站 | 不透明灰 hex | ⏳ Phase 2：改到哪旧迁新（边框 token 值换成 rgba 即可，消费方不变） |
| 圆角纪律 | 嵌套递减 + 2xl 白名单 | 混用，部分组件按「感觉」 | ⏳ Phase 2：先盘点 rounded-2xl/full 使用面，立白名单 |
| 阴影克制 | 四级阶梯 | 尚可，个别重投影 | ⏳ Phase 2：抽查 shadow-lg 使用 |
| 字号派生制 | --ui-font-size 四档 | 已有 --font-size-chat 派生制（过程层两档），接近 | 无需大动 |
| 语义色借用 | 严令禁止 | 需抽查（success/warning 装饰性使用） | ⏳ Phase 3 |

## 三、Phase 1 变更明细（本次）

`src/renderer/src/styles/foundation.css`：

- 浅色：sidebar `#f7f7f7→#f0f0f0`；muted `#f4f4f5→#f4f4f4`；hover `#e5e7eb→#e4e4e4`；active `#dfe3e8→#dcdcdc`；text-secondary `#4b5563→#4a4a4a`；text-tertiary `#636b79→#666666`；text-faint `#9fa3ac→#9a9a9a`；chat-muted-bg 同步 `#f4f4f4`。
- 暗色：panel `#171717→#1a1a1a`；popover → `color-mix(in srgb, var(--color-bg-panel) 95%, white)`；input → `var(--color-bg-panel)`；chat-card-bg/chat-table-bg 同步 `#1a1a1a`。
- 测试：`themeContrast` 的 `resolve()` 支持 color-mix 相对派生；`lightNeutralBackground` 钉值更新（含文字墨水中性钉）；`wallpaperMode` popover 钉值换相对色；`darkFixedChatColors` 钉值同步；`sidebarChromeHierarchy` 新增「暗色浮层阶梯」守卫（含皮肤继承链解析）。

对比度核算（themeContrast 矩阵实测全绿）：secondary #4a4a4a 白底 8.9:1；tertiary #666666 白底 5.7:1 / muted 底 5.2:1 / hover 底 4.5:1；faint #9a9a9a 白底 2.8:1（≥2.5 地板）。

## 四、Phase 2/3 候选（按增量纪律推进）

1. **边框墨水化**：`--color-border-*` 值换 `rgba(ink, 0.1/0.15)`（消费方零改动，效果全站生效）；暗色同步 `rgba(255,255,255,α)`。注意：涉及 `lightNeutralBackground` 钉值与 legacy CSS 里散落的硬编码边框。
2. **圆角白名单**：盘点 `rounded-2xl`/`rounded-full`，列出保留例外（输入壳/toast/对话框），其余按嵌套层级降档。
3. **语义色审计**：grep success/warning 装饰性使用（非状态语义处），换成 neutral 或身份色。
4. **暗色 chat-muted-bg（#202020）与 panel（#1a1a1a）关系复核**：现在是 muted 比面板亮一档，方向正确，无需动。
