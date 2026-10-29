---
target: 工作台主界面（src/renderer/src/App.tsx）
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:D:\\project\\github\\pi-desktop\\src\\renderer\\src\\App.tsx"
target_fingerprint: "sha256:ae8cd94403c54b9a11bac9a4b63c015b7b5d59cb83d3e5735644d501ecbb1b30"
target_path: "D:\\project\\github\\pi-desktop\\src\\renderer\\src\\App.tsx"
timestamp: 2026-10-29T04-45-39Z
slug: src-renderer-src-app-tsx
---
# Critique: PiDeck 工作台

Method: degraded (single-context)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | 流式/运行态齐全，但侧栏折叠态用 6px 纯色点表示运行中（ProjectTree.tsx:211） |
| 2 | Match System / Real World | 2 | Bypass 权限、ACP 工具、worktree、检查点等术语无内联解释 |
| 3 | User Control and Freedom | 3 | 三栏可拖拽可折叠、破坏性操作有确认；但无全局撤销 |
| 4 | Consistency and Standards | 2 | ui-shadcn + legacy CSS 并存，67 处未登记颜色、7 处越界字号、7 处越界圆角 |
| 5 | Error Prevention | 3 | 不可逆操作有二次确认；但「自动批准所有工具」是默认开关 |
| 6 | Recognition Rather Than Recall | 3 | 图标均带文字；快捷键提示只在 hover 出现 |
| 7 | Flexibility and Efficiency | 3 | 命令面板、可自定义快捷键、面板宽度记忆 |
| 8 | Aesthetic and Minimalist Design | 3 | 单色纪律强；侧栏顶部 6 个平铺动作行与内容竞争注意力 |
| 9 | Error Recovery | 3 | 错误文案点名原因、修复路径与替代方案 |
| 10 | Help and Documentation | 2 | 有引导面板与悬浮卡，工作区内无上下文帮助入口 |

**Total: 27/40 — Acceptable（需要实质改进）**

## Design Specificity Verdict

强。工具行无外框、白卡浮于画布、墨线边框、三栏会话工作台，这套语言不是通用后台能直接套用的。

确定性扫描：2 条 warning（均为 Markdown 引用左边框，误报），82 条 advisory（67 未登记颜色、7 越界字号、7 越界圆角、1 弹簧缓动）。

## Priority Issues

- [P1] 术语门槛与产品目标冲突
- [P1] 设计系统一致性债
- [P2] 侧栏顶部动作堆叠
- [P2] 设置面过大
- [P3] 快捷键提示不可发现

## Persona Red Flags

- Alex：快捷键提示 hover 才出现；无批量会话操作。
- Jordan：Bypass 权限 / ACP / worktree / 检查点 无内联解释。
- Sam：折叠树运行态是 aria-hidden 的纯色点；11px 徽章字号偏小。

## Minor Observations

- 命令面板与搜索是两个入口
- 错误边界直接展示堆栈
- 60 个设置 tab 文件
- 侧栏分段 pill 与上方动作行样式接近
- 文档站与工作区无互链
