# S6 计划：pi+dsh 全功能兼容收口、dsh 高级功能、dsh-web 风格 Web UI 与扩展性

> 目标：在 S1–S5（DSH 双后端接入，14/14）基础上完成「完整兼容 pi 和 dsh」的最后一程：
> ① 收敛剩余桌面差距（getCommands / exportHtml / skills 呈现 / 文档漂移）；
> ② 内置 Web 服务 UI 按官方 dsh-web（`@deepseek-ai/dsh-web-frontend` dist）视觉风格重构，
>    保持 pi+dsh 双后端兼容（用户明确授权「直接抄」风格）；
> ③ dsh 高级功能在桌面与 Web 双侧补全（goals/subagents/skills/jobs/workflow 呈现、会话搜索、usage 统计等）；
> ④ 扩展性收口（backend registry 注册式装配，按收益评估落地延迟的基类化）；
> ⑤ 插件支持（动态 Cordis 插件 + Web 端插件呈现）。
> 门禁沿用 AGENTS.md：每阶段 `npm run typecheck` + `npm test` 全绿；pi 链路零回归；
> 能力新增三处同步（`AgentGatewayCapability` 枚举、网关实现/缺失声明、渲染层 UI 入口）。
> 基线：`dev` 分支 @ `975f4b3b`，typecheck ✅ + 全量单测 ✅。
> 配套文档：`docs/dsh-compat-gap-analysis.md`（§1.3 已声明缺失 / §3 缺陷清单 / §4 抽象建议）。

---

## 1. 现状核对结论（2026-08 基线，代码核查）

### 1.1 已达成（S1–S5，不重复劳动）

- P0 全通 + P1 大部分：创建/attach/流式/abort/分页/模型/thinking/工具卡/审批提问/重命名/fork/compact/并发；
- G2 图片附件（内联 base64 PromptContentPart）、G3 孤儿检测、G5 goals UI、G6 subagents UI、
  G9 会话搜索、G13 动态 Cordis 插件（安装/运行/停止/卸载）、G14 归档恢复、G16 usage 投影、G17 RPC 日志；
- H1–H12 兼容期修复全部回填；S4/S5 各 10/10、14/14 验收通过。

### 1.2 剩余差距（本轮收敛对象，均以代码为准复核过）

| # | 差距 | 现状（代码证据） | S6 处置 |
|---|---|---|---|
| D15 | `/commands` 列表（getCommands） | `DshAgentManager.capabilities` 不含 `getCommands`；host 侧 slash 桥只执行不枚举；F4 的 `/` 补全对 DSH 空白 | **实现**：hostEntry 加 `pideck-command-list` 桥路由（枚举 `ctx.commands` 注册表）→ `DshAgentManager.listCommands` → 声明能力 → Composer `/` 菜单复用现有 `listRuntimeCommands` 链路 |
| G10 | 会话导出（exportHtml） | `AgentManager.exportHtml`（pi `export_html` RPC）存在；DSH 无 wire 等价物，`downloads.sessionLog` 需字节流桥（高成本） | **实现**：投影式导出——`DshAgentManager.exportHtml` 用 `readHistoryPage` 全量历史渲染 HTML（纯函数 + 单测），复用 pi 的「导出路径返回」协议，UI 入口按能力放开 |
| G7 | skills 呈现 | wire `skill.list`（按 sessionId 查只读目录，`/name` 经 session.prompt 斜杠调用）未接 | **实现**：`DshHost.listSkills` + IPC `dsh:list-skills` + 会话面板/配置页呈现（只读清单 + 提示斜杠调用） |
| A4 | 注释漂移 | `src/shared/types/settings.ts` `dshHomeDir` 注释写旧策略（应用私有目录），实现是 `~/.dsh` 优先 | **修**：注释对齐 `DshHost.resolveDshHomeDir` |
| D13 | 编辑/删除历史消息 | wire 无对应（`session.updateQueue` 只改 pending 队列项） | **保持能力缺失**（UI 已隐藏），文档化理由 |
| 其他 | e2e/回归基线 | `dsh-models / dsh-restart / dsh-security-plan / dsh-title-diag` | 新增能力后补 e2e 或单测（行为不测实现） |

### 1.3 dsh 高级功能面（S6.3 呈现对象）

| 能力 | wire/数据源 | 桌面现状 | Web 目标 |
|---|---|---|---|
| goals | `goal.*` + `goal/change` 事件 | ✅ G5 工具面板 | Web 会话面板呈现 |
| subagents | `subagent.*` + `subagent/start|report` 事件 | ✅ G6 工具面板 | Web 会话面板呈现 |
| skills | `skill.list`（S6.1 接） | ⏳ 本轮接 | Web 呈现 |
| jobs | `jobs.d.ts` 域（dsh-jobs） | ⏳ 未接 | 评估后接入（若 wire 可用） |
| workflow | `dsh-workflow`（host 侧） | 未接（host 内自驱） | 不承诺 wire 级呈现；事件投影尽力 |
| plan/permission | `plan/mode` + `permission-preset` 事件 | ✅ 底栏/徽标 | Web 复用同一投影数据 |
| usage 统计 | `turn/end` 投影 | ✅ G16 | Web 展示（如官方会话卡） |
| 会话搜索 | `session.search` | ✅ G9 | Web 侧栏搜索 |

### 1.4 扩展性收口（S6.4，按收益排序）

| # | 抽象 | 判定 |
|---|---|---|
| C1 | backend registry（`registerBackend()` 注册式装配） | **做**：把 `SessionIpcDeps` 的 dsh 可选依赖收敛为注册表查询；新后端不改 sessionIpc/index.ts 大块 |
| C2/C11/C13 | 生命周期/崩溃重启/请求超时基类 | **维持现状**（等价修复已在 DshHostProcess/DshApiClient 内部落地；再抽基类收益 < 回归风险，记录理由） |
| C8 | PromptSerializer | **维持后置**（pi 协议队列语义有回归风险） |
| C18/C19/C20/C21 | 后端标识/模型目录/安全控制/默认后端 | ✅ S3 已落地，继续复用 |

### 1.5 插件支持（S6.5）

- 桌面：G13 动态 Cordis 插件（install/run/stop/uninstall + 静态 Loader 只读清单）已落地，无需新做；
- Web：新增「插件」呈现——复用 `dsh:plugin-list/static-list` IPC，按官方 dsh-web 插件页（inventory + configurable 只读 tab）风格呈现；动态安装表单按 G13 语义（Host 半区 + 面板手势免审批）。

---

## 2. Web UI 重构方案（S6.2，用户授权「直接抄」dsh-web 风格）

### 2.1 风格来源

- `node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/*.css`：官方 dsh web 产物，含完整设计 token 体系：
  - 字体：`--dsw-font-family`（系统栈 + PingFang SC + Microsoft YaHei）、`--ds-font-family-code`（SF Mono/JetBrains Mono）；
  - 语义色板：`--dsw-alias-bg-layer-1/2/3`（背景分层）、`--dsw-alias-border-l1..l4`（边框层级）、
    `--dsw-alias-label-primary/secondary/tertiary`（文字层级）、`--dsw-alias-brand-primary`、
    `--dsw-alias-state-success/error/warn`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-button-*`；
  - 其他：`--dsw-alias-markdown-*`（代码块/引用/行内代码）、`--dsh-scrollbar-*`、`--dsl-*`（代码块/终端/diff 排版）。
- 交互模式：左侧栏（会话列表 + 分组）+ 主会话区（时间线/工具卡/思考折叠）+ 底部 Composer（斜杠命令/模型选择）+ 右上设置；trajectory 面板按轮次展开。

### 2.2 落地原则（边界）

- **只抄风格，不抄运行时**：不内嵌官方 dist（它绑定 dsh client runtime/Typert WebSocket，且无法服务 pi 会话）；
  不把 `dsh-client-ui-*` React 包引入（依赖 dsh client 运行时，与 WebServiceManager 的 REST/SSE 契约不匹配）。
- **单套 UI 双后端**：会话/工具/模型数据全部走既有 WebServiceManager API（pi+dsh 已无感），新增视觉层只消费同一契约；
  后端差异用现有 `backend` 字段做徽标/能力开关（沿用桌面 SessionBackendMark 模式）。
- **桌面 UI 不动**：dsh-web 风格只作用于内置 Web 服务页面（用户诉求）；桌面 UI 2.0（Tailwind+shadcn）维持。
- **token 落点**：`src/renderer/src/web/web.css` 定义 `:root` 的 `--dsw-*` 变量桥接（从官方 CSS 提取常量），
  组件用 utility class + CSS 变量组合实现，不引入第二套视觉语言到桌面样式表。

### 2.3 页面结构（对齐官方 dsh web 的信息架构）

```
WebChatApp（组合根）
├── WebSidebar（左栏）
│   ├── 会话分组列表（项目分组 + 未分组 + DSH 外部会话；backend 徽标）
│   ├── 新建会话（后端选择：pi/dsh，跟随 defaultAgentBackend）
│   └── 搜索框（G9 session.search 接入）
├── WebHeader（顶部：会话标题/模型选择器/thinking 档位/状态灯/runtime 操作）
├── WebTimeline（时间线）
│   ├── 用户/助手消息（markdown 渲染复用现有 streamdown 管线）
│   ├── 思考折叠（reasoning 块，deepseek 风格）
│   ├── 工具卡（ToolEventView 投影；terminal/diff/generic/search/read 卡片形态，复用 dshToolView）
│   ├── goals 卡片（phase/轮次进度）
│   ├── subagents 卡片（running/模式徽标/报告）
│   └── 轮次轨迹（trajectory 展开，复用 dshProcessEvents 数据源）
├── WebComposer（底部：斜杠命令菜单（S6.1 getCommands）/图片附件（G2 已通）/plan 模式/权限预设）
└── 设置抽屉（模型/插件清单（S6.5）/DSH 状态——按官方 settings 分组风格）
```

### 2.4 验收

- 视觉：与官方 dsh web 同 token 体系（背景分层/边框/文字层级/品牌色/状态色/字体栈）；
- 功能：pi 与 dsh 会话在 Web 端全功能可用（发送/流式/中止/历史/模型/thinking/审批提问/工具卡/goals/subagents）；
- 门禁：typecheck + 单测绿；Web 依赖纯函数（如 token 映射、能力开关）配单测；现有 Web e2e 不回归。

---

## 3. 阶段划分与验收门禁

| 阶段 | 内容 | 验收 | 依赖 | 状态 |
|---|---|---|---|---|
| **S6.1 桌面差距收敛** | D15 getCommands（host 桥 + 能力声明 + Composer `/` 菜单）；G10 exportHtml（投影式导出 + 能力声明 + UI 入口）；G7 skills（wire + IPC + 呈现）；A4 注释对齐 | typecheck + 单测绿；新纯函数单测；手测 DSH `/` 菜单、导出、skills 列表 | 无 | ✅ 完成（`dshCommandsBridge` 桥 + `dshSessionHtmlExport` 渲染器 + `skill.list` 接线；测试 `dshCommandsBridge.test.mjs`/`dshSessionHtmlExport.test.mjs` 全绿；A4 代码注释已正确，仅文档滞后） |
| **S6.2 Web UI dsh-web 风格重构** | token 提取与桥接；WebSidebar/WebHeader/WebTimeline/WebComposer 重构；双后端徽标与能力开关 | 视觉对照官方产物；pi+dsh 双后端手测；单测绿 | S6.1 | ✅ 完成（web.css token 层：官方 alias 语义 + 亮色原值 + 暗色近黑分层；结构精修：毛玻璃头部/聚焦品牌环/内容列宽/细滚动条/工具卡圆角；双后端徽标 SessionBackendMark 同源接入侧栏与头部；构建 + 全量单测绿） |
| **S6.3 dsh 高级功能 Web 呈现** | goals/subagents/skills 卡片、会话搜索框、usage 展示、jobs（评估） | Web 手测；单测绿 | S6.2 | ✅ 完成（WebDshToolsPanel：goals 只读 / subagents+transcript / skills 三 tab；REST 端点 `/api/sessions/:id/dsh/{goal,subagents,subagents/:child/history,skills}` 与桌面 IPC 同源；会话搜索框/usage/jobs 经评估：搜索框本地过滤已覆盖侧栏场景、usage 走消息 meta 投影、jobs 无 wire 呈现价值——不做） |
| **S6.4 扩展性收口** | C1 backend registry（sessionIpc deps 收敛 + `registerBackend`）；其余按 §1.4 判定维持 | 重构后双后端全量回归（typecheck + 单测 + e2e） | 任意 | ✅ 结论：C1 已由 S3 的 `dshBackend` 依赖分组 + CompositeAgentGateway（byBackend 路由 + 能力并集）满足，再抽 registerBackend 属负优化（增加间接层、装配层变胖）；新增能力（getCommands/exportHtml）走既有 `AgentGatewayCapability` 三处同步机制验证通过 |
| **S6.5 插件 Web 呈现** | Web 插件页（inventory/静态清单/动态安装表单，复用 dshPlugin* IPC） | Web 手测插件清单/安装流程 | S6.2 | ✅ 完成（REST `/api/dsh/plugins{,/install,/:pluginId/run|stop|uninstall}` 与桌面配置页同源；WebDshToolsPanel 插件 tab：清单 + 安装表单 + 运行/停止/两步卸载 + 静态只读清单；G13 语义提示文案） |
| **S6.6 收尾** | README/CHANGELOG 更新（S6 条目，中英一致）；docs 文档漂移清零；发版核对 | 文档核对；`npm run pack` smoke（按需） | 全部 | ✅ 完成（CHANGELOG.zh-CN/CHANGELOG.md 新增 v0.7.2 S6 条目；README 亮点区块留待发版走 `sync-release-notes.js`；计划文档本文档即现状快照） |

---

## 4. 关键实现决策（含理由）

1. **getCommands 走 host 侧自定义桥**（`/pideck-command/list`）：官方 wire 无命令枚举；
   `ctx.commands` 注册表在 host 进程内可直取，桥路由与现有 slash 桥/插件桥同构（前缀路由 + JSON），
   不引入新传输。
2. **exportHtml 用投影式导出**：DSH 无 `export_html` RPC；`downloads.sessionLog` 需字节流桥（改动大且
   输出是 zstd 日志 ZIP，非人类可读 HTML）；投影式导出把 `readHistoryPage` 全量消息渲染成 HTML
   （纯函数 `renderDshSessionHtml(messages, meta)`，样式内联，可单测），用户体验与 pi 一致（拿到 .html 文件）。
3. **skills 只做呈现**：`skill.list` 只读目录 + 斜杠调用提示；不做技能管理 UI（官方同样是只读）。
4. **Web token 桥接不引依赖**：CSS 变量从官方 dist 提取为常量表（`web/webTokens.ts` 生成注释），
   禁止把 `dsh-web-frontend` 设为运行时依赖（它是 build 参考物，不是代码依赖）。
5. **能力声明三处同步**：`AgentGatewayCapability` 加 `getCommands`/`exportHtml`（若已存在则补实现），
   `DshAgentManager.capabilities` 增补，渲染层按能力放开 UI（Composer `/` 菜单、右键导出）。

---

## 5. 测试计划

- `tests/dshCommands.test.mjs`：命令枚举桥响应 → `listCommands` 视图映射（纯函数）。
- `tests/dshSessionHtmlExport.test.mjs`：`renderDshSessionHtml`（消息 → HTML 的纯函数）内容断言。
- `tests/dshSkills.test.mjs`：`skill.list` 响应 → 视图映射（纯函数）。
- 既有 `tests/dsh*.test.mjs` 保持绿；e2e 视能力新增补 `dsh-commands`/`dsh-export`（真实 host 验证）。
- 每阶段门禁：`npm run typecheck` + `npm test` 全绿；涉及 Web 纯函数时补 Web 侧单测。

---

## 6. 明确不做（记录理由，防蔓延）

- 内嵌官方 dsh web dist 或 `dsh-client-ui-*`（绑定 dsh client 运行时，无法兼容 pi；见 §2.2）。
- D13 编辑/删除历史消息（wire 无对应；UI 已按能力隐藏）。
- `downloads.sessionLog` 字节流桥（成本高、输出非人类可读；投影式导出已覆盖用户价值）。
- 桌面 UI 全面改版为 dsh-web 风格（用户诉求限于内置 Web 服务）。
- 双 host 同 `$DSH_HOME` 并发支持（维持现状，启动提示已有）。
