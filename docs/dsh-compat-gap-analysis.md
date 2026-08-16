# DSH 兼容性差距分析与后续开发清单（v7.2-beta）

> 本文档面向后续开发：回答「要完整兼容 pi DSH，哪些功能还缺失、哪些功能需要调整、
> 哪些操作应该抽成公共抽象再各自实现」。代码基线：`dev` 分支 @ `5825d188`
> （merge: feat/dsh-agent-mvp（兼容 DSH）→ dev，v7.2-beta）。
> 配套文档：`docs/dsh-agent-backend-plan.md`（接入计划 + 落地快照，本文与其冲突处以此文代码核查为准）。

---

## 1. 现状快照（2026-08-15 合并后的能力基线）

### 1.1 架构形态

| 维度 | pi 后端 | DSH 后端 |
|---|---|---|
| 进程 | 每会话一个 stdio JSON-RPC 子进程（`PiProcess`） | 单 host utilityProcess（`pideck-dsh-host`，懒启动），会话为 in-process fiber |
| 通信 | stdio JSON-RPC（`PiRpcClient`） | MessagePort fetch 桥（`DshApiClient` 覆写 `doFetch`，四象限信封 + SSE 帧） |
| 网关 | `AgentManager`（5230 行） | `DshAgentManager`（958 行） |
| 路由 | — | `CompositeAgentGateway` 按 `AgentTab.backend` 路由 |
| 会话持久化 | 会话文件 JSONL（`SessionScanner`/`SessionHistoryReader`） | `$DSH_HOME` session log（`session.jsonl.zstd`），PiDeck catalog 只存映射 |
| 消息投影 | `AgentMessageProjector`（事件 → ChatMessage） | `dshEventProjector`（纯函数，SessionEvent → ChatMessage/ThinkingUpdate/ToolEventView） |
| 迟到流治理 | `streamGate`（纯函数状态机） | `dshRuntimeControl`（纯函数状态机） |
| 审批/提问 | pi 扩展 `ask_question`/`trust` | `approval/requested` + `question/requested` → `agents:ui-request` 桥 |

### 1.2 已实现能力（对照 plan §7）

**P0 全通**：创建/attach 会话、流式发送（串行化）、abort、历史分页（`session.history`）、
模型列表/切换（含思考档位 `reasoningEffort`）、thinking 展示、工具调用展示、
审批/提问弹窗、重命名、fork（`session.fork` 锚 seq）、compact（`/compact` slash 桥）、并发多会话。

**超出 P0 提前落地**：权限预设（`/permission`）、plan 模式（`/plan`）、agent-presets（D19）、
持久化 pwsh 工具（`pideckPwshPersistent`）、Windows 控制台治理、崩溃限次重启、
重启 attach 语义、标题同步、消息串行化、DSH 配置管理页（8 分区）。

### 1.3 已声明缺失 / 后置（按能力集隐藏）

> 编号沿用 `docs/dsh-agent-backend-plan.md` §7 的 P1/P2 能力表（D13-D19），与本文 §3 的运行时缺陷编号（A-F 系列）无关。

- **D13 编辑/删除历史消息**：`editMessage`/`deleteMessage` 未实现（DSH wire 无对应），UI 已按 capability 禁用。
- **D14 图片附件**：桥 body 仅字符串，字节载荷不支持；`attachment-local` 行禁用。
- **D15 `/commands` 列表**：命令执行桥已就绪（slash 桥），`getCommands` 列表接口未实现。
- **D17 动态 Cordis 插件管理 UI**：仅配置页 3 分区（agent-loop/shell/web-search）。
- **D18 goals / subagents / skills UI 呈现**：`goal.*`/`subagent.*` API 已就绪，UI 后置（plan-mode 已提前落地）。

### 1.4 关键语义差异（网关方法级，实现/重构时必须小心）

> 完整对照表见专项核查报告（§3.3 引用）；这里只列「同名方法语义不同」的坑。

| 方法 | pi 语义 | DSH 语义 | 风险 |
|---|---|---|---|
| `restart` | 停进程 → 同会话文件重建进程 | **attach 同一 host 会话**（仅 host 丢失才新建） | Coordinator 注释仍写「新建 host 会话」（D7 文档漂移） |
| `stop` | 杀进程 + 清理状态 | 仅 abort mux + 删 runtime，**host 会话保留**（重启 attach 恢复） | 用户预期「停止=结束」，实际数据留在 `$DSH_HOME` |
| `prepareResendFromMessage` | 截断会话文件到目标消息 + 返回文本/图片 | 只从内存取文本，**不截断、不校验角色** | 重发后 DSH 上下文不分支，与 pi 行为不同 |
| `setThinking` | 独立 RPC | 走 `selectModel.reasoningEffort`（无独立 RPC）；无模型选中时只记内存 | catalog/host 漂移（D13） |
| `setModel` | `set_model` + needsRestart | `selectModel` 同时下发 reasoningEffort | 换模型与思考档位耦合 |
| `abort` | 应答 pending UI 请求 + settled 兜底计时器 | 只抬世代 + cancel，**不碰 pending 审批/提问** | D1（P0）：host 永久阻塞 |
| `getAvailableModels` | 需存活 pi 进程，失败抛错 | 需存活 host，失败**静默返回 `[]`** | 渲染层无法区分「无模型」与「host 挂了」 |
| `sendPrompt` | bash 前缀/图片/扩展命令/乐观用户消息/steer | 仅 queue 文本；其余载荷**静默丢弃** | D2（P0/P1） |
| `fork` | 经 Coordinator `replaceBoundRuntime`（lease 保护） | manager 内自行 stop→换绑（绕过保护） | D3（P0/P1） |
| `compact` | RPC + isCompacting 去重/进行态 | `/compact` 斜杠命令，无等待无状态 | D4（P1） |
| 历史分页 | 文件分页（游标=消息下标） | `session.history`（游标=事件 seq，total=-1） | 游标协议不同，翻页 UI 已无感但实现两套 |

### 1.5 DSH wire 领域 API 使用状态（已装包类型核查）

> 依据：`node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/*.d.ts`。✅=PiDeck 已用；⏳=可用未接；❌=无此能力。

| 领域 | 方法 | 状态 | 备注 |
|---|---|---|---|
| sessions | list / search / create / history / models / selectModel / rename / fork / prompt / attachment / updateQueue / cancel | ✅ 大部分已用 | `search`（G9）、`attachment`（G2）未接；**无 delete/remove** |
| approvals | approval/requested → respond（`POST /api/respond`） | ✅ | abort 不清表（D1/D5） |
| questions | question/requested → respond（`AskUserQuestionItem[]` 批量） | ✅ | batch 应答无重试（D15） |
| events | events.mux / events.host（流 opener） | ✅ mux | 重连不补帧（D6） |
| settings | describe / update / openDocument | ✅ | 配置页 8 分区 |
| credentials | describe / set / unset（值不回显） | ✅ | 主进程读文件/环境 |
| llm | models / providers 等 | ✅ | DshHost.listModels/listProviders |
| goals | create / edit / pause / resume / complete / clear | ⏳ G5 | UI 后置 |
| subagents | list / history / prompt / interrupt | ⏳ G6 | UI 后置 |
| skills | list | ⏳ G7 | 至少可做呈现 |
| host | describe / pickDirectory / listDirectory / createDirectory / openPath | ⏳ | 当前用 directoryPicker stub；可接 PiDeck 目录选择器 |
| downloads | sessionLog（host-only GET 路由，返回会话日志 ZIP） | ⏳ G10/A5 | 桥需扩展字节流/附件响应 |
| agent-presets | list / setDefault 等 | ✅ | 配置页预设 tab |
| session-search | 侧栏搜索语义工具（上限 20/snippet 240） | ⏳ G9 | 与 sessions.search 配套 |

---

## 2. 功能缺失清单（后续要做的）

> 优先级定义：P0 = 用户可感知的兼容性硬伤 / 数据风险；P1 = 常用功能缺口；P2 = 增强项。

### P0

| # | 缺失项 | 现状 | 目标 | 涉及模块 |
|---|---|---|---|---|
| G1 | **会话删除/归档的 DSH 语义** | 删除会话只删 catalog 映射记录，host 侧会话数据留在 `$DSH_HOME`（`session.jsonl.zstd` 不清理），用户删了「以为没了」实际还在；归档同理 | 明确策略：删映射时是否同步删 host 会话（wire 无 `session.delete`，需查 host 是否有删除 API 或文档化「只删映射」并提示用户） | `SessionCatalog` / `DshAgentManager` / sessionIpc |
| G2 | **图片附件（D14）** | 桥 body 只支持字符串，`attachment` 未接 | 桥协议扩展字节载荷（base64 或二进制 transferable），启用 `attachment-local` 行（sharp 已 asarUnpack 待命），composer 图片粘贴/拖拽对 DSH 会话生效 | `dshHostBridge` / `hostEntry` / `DshAgentManager.prepareResendFromMessage` / Composer |
| G3 | **会话删除后 host 残留的会话列表清理**（与 G1 联动） | `session.list` 会列出 host 中所有会话；被 PiDeck 删除映射的会话无法从 UI 访问，但占用 `$DSH_HOME` 空间 | 提供「清理孤儿 DSH 会话」入口或删除映射时同步处理 | `DshHost` / 配置页 overview |

### P1

| # | 缺失项 | 现状 | 目标 | 涉及模块 |
|---|---|---|---|---|
| G4 | **`/commands` 列表（D15）** | slash 桥能执行命令，但没有列表入口 | host 侧自定义桥或文档化命令集：`getCommands` 能力声明 + Composer `/` 菜单 | `hostEntry` slash 桥 / `DshAgentManager` / Composer |
| G5 | **goals UI 呈现（D18）** | `goal.*` API 就绪（plan 文档 §2.2），无 UI | 会话内 goals 列表/状态卡片（对标 pi 的 Todo 条？需按 DSH 语义设计，不是搬运） | 渲染层 session 组件 / 新 hook |
| G6 | **subagents UI 呈现（D18）** | `subagent.*` API 就绪，无 UI | 会话内 subagent 活动/结果呈现 | 渲染层 session 组件 |
| G7 | **skills 呈现** | DSH 原生 skills 能力，无 UI | 至少会话内 skills 状态/结果呈现；管理 UI 可后置 | 渲染层 / `DshAgentManager` |
| G8 | **DSH 会话级模型/thinking 持久偏好（D16 收尾）** | 草稿期写 catalog、激活时 applyPreferences；但 host 侧 `session.models` 的持久性依赖 `$DSH_HOME`，跨 host 重启后 catalog 与 host 实际值可能漂移 | attach 时对账 catalog 与 host 当前模型/档位，漂移时提示或回写 | `DshAgentManager.create/restart` |
| G9 | **DSH 会话搜索/过滤** | 侧栏可按 backend badge 过滤（已实现），但 DSH 会话无全文搜索（pi 有文件扫描搜索） | 用 `session.search`（wire 有该方法；`session-search.d.ts` 定义侧栏搜索语义：结果上限 20 条、snippet 240 码点）接入侧栏搜索框 | 渲染层侧栏 / `DshHost` |
| G10 | **会话导出（HTML/分享）** | pi 有 `exportHtml` 能力；DSH 无 | 两个可行路径：(a) wire 无导出方法，用投影结果自定义渲染 HTML；(b) **`downloads.sessionLog`（host-only GET 路由，返回会话日志 ZIP，含 subagent 后代）**——桥需扩展字节流/附件响应通道。建议 (b) 做「导出会话日志」，HTML 导出另行评估 | 待决策 / `dshHostBridge` 扩展 |
| G11 | **设置页 DSH 入口** | `dshHomeDir`/`dshApprovalAutoAllow` 只在 ConfigModal 的 DSH 页；Settings 页无 DSH 项 | 设置页下沉 DSH 状态/DSH_HOME/审批策略入口 | 渲染层 settings 页（F10） |
| G12 | **权限/plan 状态全局可见性** | `permissionPreset`/`planModeActive` 数据已具备（`AgentRuntimeState`），只被底栏消费 | 侧栏/会话头/Tab 加权限预设与 plan 态徽标 | 渲染层（F11） |

### P2

| # | 缺失项 | 现状 | 目标 | 涉及模块 |
|---|---|---|---|---|
| G13 | **动态 Cordis 插件管理（D17）** | ✅ 配置页插件区动态化 + 真正安装/卸载（`dsh-cordis-host-runner` 服务经 `pideck-plugin-bridge` 暴露：define/run/stop/undefine，按会话归属、面板手势免审批；静态 Loader 只读清单；详见 §7） | 插件安装/启用/禁用 UI（`cordis-host-runner` 可运行 `@pluginId`） | 配置页 plugins / `hostEntry` / `pideckPluginBridge.ts` |
| G14 | **DSH 会话归档恢复** | pi 有归档/恢复（unarchive）；DSH 无 | host 会话文件是 zstd jsonl，可做独立归档格式 + 恢复导入（需要校验 host 路径规则） | 新模块 || G15 | **会话标题 AI 生成** | DSH 侧已依赖 `dsh-session-title` fold（list 投影 title），pi 侧标题生成在 `sessionNameLine` | 确认 DSH 标题生成是否走 host fold（现状已能同步标题），无需新增 | 验证即可 |
| G16 | **usage/计费统计接入** | pi 侧有 `usageStats`（usage.log 解析）；DSH 事件带 token/usage 吗？ | 若 `turn/end` 带 usage，投影进 `AgentRuntimeState` 的 token/cost 字段（当前 DSH runtime state 无 usage 数据） | `dshEventProjector` / runtime state |
| G17 | **RPC 日志查看器** | pi 有 `setRpcLogging`/rpcLogViewer；DSH 无 | DSH 桥帧可记 rpc log（fetch-request/response），复用 rpcLog 通道 | `DshApiClient` / rpcLog |

---

## 3. 需调整清单（现有实现的问题）

> 每条含代码证据；修完回填状态。

### 3.1 明确缺陷

| # | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| A1 | **`sessionsRuntimeClone` 无 DSH 分流**：DSH 会话 clone 会直走 `agentManager.cloneSession`（pi 会话文件逻辑） | `src/main/ipc/sessionIpc.ts` L860-884（`replaceAgentSession(() => agentManager.cloneSession(...))`）；**UI 未隐藏**：`AgentContextMenu` 的「复制会话」对 dsh agent 仍显示（`SidebarComponents.tsx` L448） | DSH 会话触发 clone 报错/行为未定义 | 按 `isDshAgent` 分流（DSH 复制语义需定义：同 host 会话复制映射？还是 fork？）或 UI 禁用 + capability 声明 |
| A2 | **`sessionsCatalogReadMessages` 对 DSH 返回空数组**（全量读消息无 DSH 分支，而分页 `readMessagePage` 有） | `sessionIpc.ts` L503-510 vs L517-519 | 依赖全量读的 UI（如某些导出/预览）对 DSH 会话空白；需确认渲染层调用方 | 复用 `readDshHistoryPage` 或声明只支持分页 |
| A3 | **`sessionsCatalogReadMessageFullText` 对 DSH 无分支**：工具结果截断「查看完整输出」在 DSH 会话不可用 | `sessionIpc.ts` L563-606 | DSH 工具输出截断后无法展开全文 | DSH 侧实现全文读取（消息投影保留完整文本，或走 `session.history` 定位） |
| A4 | **`settings.ts` 的 `dshHomeDir` 注释与实现漂移**：注释写「应用私有目录 + 首次复制」，实际是「~/.dsh 优先，仅全新用户回退，不复制」 | `src/shared/types/settings.ts` L256-262 vs `DshHost` 注释 L30-32 | 文档误导 | 改注释（plan §12.4 #1 已登记） |
| A5 | **DSH 会话「复制会话文件路径」指向 host 持久化文件**，但该文件是 `.zstd` 压缩二进制，用户拿去无法直接阅读 | `DshAgentManager.dshSessionFilePath` L66-85 | 体验落差（pi 是明文 JSONL） | 用 `downloads.sessionLog`（host GET 路由返回会话日志 ZIP）提供「导出会话日志」入口（需桥支持字节流响应），或复制路径时提示格式 |
| A6 | **`prepareResendFromMessage` 只回文本**：DSH 消息若含图片/附件（未来 G2 落地后），重发会丢附件 | `DshAgentManager.ts` L482-489（`return { text: message.text }`） | 与 G2 联动 | 随 G2 一起补 images 回填 |
| A7 | **`waitForIdle` 30s 超时直接放行**：host 卡死时消息可能串台（注释已承认），只是「避免永久挂起」的妥协 | `DshAgentManager.ts` L264-271 | 极端情况下消息串台 | 超时后检查 host 健康；host 无响应则提示而非静默放行 |
| A8 | **侧栏「复制会话」对 DSH 无分流**：`copyCatalogSession` 依赖 `entry.filePath`（pi 会话文件），DSH 会话直接 throw `session.fileNotFound` | `src/main/index.ts` L584-603；**UI 未隐藏**：`SessionContextMenu` 的「复制会话」对 DSH 仍显示（`SidebarComponents.tsx` L530） | DSH 会话复制入口真实报错 | 按 backend 分流（DSH 复制 = 新建映射 + 复用 host 会话？语义需定义）或显式声明缺失并在 UI 禁用 |
| A9 | **侧栏「导出 HTML」对 DSH 无分流**：`exportCatalogSessionHtml` 同样依赖 `entry.filePath`；`AgentContextMenu` 的导出项对 dsh agent 也未隐藏 | `src/main/index.ts` L605-613；`SidebarComponents.tsx` L452/L534 | DSH 会话导出真实报错 | DSH 侧实现导出（`downloads.sessionLog` 或投影渲染 HTML）或声明缺失 + UI 禁用；与 G10 合并决策 |

### 3.2 需核查/确认项

| # | 事项 | 结论（已核查） |
|---|---|---|
| B1 | 渲染层 clone/exportHtml 入口对 DSH 是否已隐藏 | **未隐藏（确认）**：`AgentContextMenu` 的「复制会话」「导出 HTML」对 dsh agent 仍显示（`SidebarComponents.tsx` L448/L452）；`SessionContextMenu` 同样（L530/L534）。仅「打开会话文件」按 `backend !== "dsh"` 隐藏（L462/L545）→ A1/A8/A9 均真实可触发 |
| B2 | DSH 会话删除后 host 侧会话的处置（G1） | **wire 无 `session.delete/remove`**（已核查 `dsh-host-apiproxy/lib/types/api/sessions.d.ts`：list/search/create/history/models/selectModel/rename/fork/prompt/attachment/updateQueue/cancel）→ 删除语义只能「删映射 + 文档化 host 数据保留」或未来走 host 侧自定义命令 |
| B3 | DSH 会话搜索 `session.search` 的可用性 | **可用**：`sessions.d.ts` 有 search；`session-search.d.ts` 定义侧栏语义（结果上限 20、snippet 240 码点） |
| B4 | `turn/end` 是否携带 usage/token 数据 | **待验证**：`dshEventProjector` 未投影 usage；需查 host 事件形状（`dsh-session-stats`/`dsh-token-meter` 包存在，有可行路径） |
| B5 | 配置页「DSH 审批自动放行」与 DSH 自身 approval 策略的关系 | 两层并存：PiDeck 开关（`dshApprovalAutoAllow`，approval 帧直接应答）+ host `permission` 预设（sandbox 模式 + approval 策略捆绑）→ 需文档化优先级 |
| B6 | 双 host / 多实例同 `$DSH_HOME` 并发 | **无任何防护**（`src/main/dsh/` 无 lock/占用检测）→ 启动时检测并提示，避免静默损坏 session log |
| B7 | DSH 会话的「重开上次会话」恢复体验 | restart attach 已实现；应用启动时侧栏 DSH 历史会话可打开恢复（懒启动 host） |

### 3.3 运行时交互链路缺陷（深度核查，`DshAgentManager` 958 行逐行）

> 来源：会话/事件/网关层专项核查（含 `dshEventProjector`/`dshRuntimeControl`/`dshApprovalBridge`/`SessionRuntimeCoordinator`）。

| # | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| D1 | **abort 不处理 pending 审批/提问帧 → host 永久阻塞**：abort 只抬世代 + `sessions.cancel`，不遍历 `pendingResponses` 应答；pi abort 显式对每个 pending UI 请求发 `value:null` 解阻塞 | `DshAgentManager.ts` L355-377 vs `AgentManager.ts` L1577-1595 | 停止时若有 approval/question 在等，host 工具调用永远等不到 client-response，回合不结束；后续发送被 `waitForIdle` 卡满 30s；Ask 弹窗残留 | **P0**：abort/stop 时对 pending 帧应答拒绝；补 UI 请求超时（pi 有 `scheduleUIRequestTimeout`，DSH 无） |
| D2 | **sendPrompt 静默丢弃 images / agentMessage / streamingBehavior**：只发 `{type:"text"}` | `DshAgentManager.ts` L247 | 图片消息静默降级为文本、宿主指令当普通消息、streaming 语义丢失，**无任何告警** | **P0/P1**：至少显式拒绝（accepted:false + 能力提示）；图片随 G2 支持 |
| D3 | **fork 绕过 Coordinator 的 dispatch-lease/replacement 保护**：pi fork 走 `replaceBoundRuntime`（保留/换绑/回滚/`assertNoDispatchLease`）；DSH fork 在 manager 内自行 stop→换绑 | `sessionIpc.ts` L891-929 + `index.ts` L2346-2358 + `DshAgentManager.ts` L571-627 vs `Coordinator` L772-815 | fork 时若有 prompt 在途，RPC 响应落到已废弃 mux，结果丢失/串台 | **P0/P1**：DSH fork 改为「manager 完成 host 侧 fork 后由 Coordinator 统一做绑定迁移」，复用 lease 保护 |
| D4 | **compact 无 waitForIdle / 无 isCompacting / 不等待完成**：直接发 `/compact` 命令，不等待空闲；runtime state 无压缩中状态 | `DshAgentManager.ts` L391-408、L410-423 vs `AgentManager.ts` L1679-1691 | 运行中触发压缩会拼进旧回合；UI 无进行态、可重复触发 | **P1**：补 waitForIdle + isCompacting 状态 |
| D5 | **pendingResponses 无超时、stop 不清表** | `DshAgentManager.ts` L98、L336-343 | 用户不响应则永久挂起；stop 后旧弹窗应答仍发往 host | **P1**：生命周期管理与 D1 一起修 |
| D6 | **mux 断连重连不重放历史 → 视图缺帧**：重连只重放 session/subscribed 快照，不补断连窗口事件 | `DshAgentManager.ts` L764-915（注释 L762） | host 崩溃自愈后消息投影停在断连前，control 状态可能停在旧值 | **P1**：重连后用 `session.history` 从断点补齐，或标记「视图可能陈旧」 |
| D7 | **restart 语义注释漂移**：实现是「attach 同一 host 会话」（仅 host 丢失才新建），`Coordinator` L877 注释却写「DSH restart 会新建 host 会话」 | `DshAgentManager.ts` L273-334 vs `Coordinator.ts` L877-883 | 维护者按注释会写错 catalog 值 | **P1**：修注释 + 在 gateway 层补契约注释 |
| D8 | **abort 后 turn/end 仍可能投影 error 消息**：cancelled 后迟到帧走 ignoreStream，但 turn/end error 分支仍追加 | `DshAgentManager.ts` L819-825 + `dshEventProjector.ts` L344-358 | 用户主动停止被显示为「回合失败」错误气泡 | **P2**：cancelled 分支跳过 error 消息追加 |
| D9 | **tool/result 缺失时工具卡永远 running**：只有 `executingTool` 有值时更新卡片，无超时兜底 | `dshEventProjector.ts` L311-334 vs pi L1972-2007 | 崩溃/取消后卡片转圈不止 | **P2**：补超时/兜底清理 |
| D10 | **dshSessionId 一致性风险**：catalog 迁移用 piSessionId 补齐（数据假设）；`findByDshSessionId` 不查 transient 草稿；`dshSessionFilePath` 251 截断可能折叠不同 cwd；attach 不校验 cwd 与 host 会话一致 | `SessionCatalog.ts` L200-218、L241-245；`DshAgentManager.ts` L66-85、L144-172 | 项目迁移/长路径/草稿期标题同步 miss | **P2**：补 cwd 一致性校验与路径编码校验 |
| D11 | **匿名（noSession）DSH 会话产生 host 孤儿**：无条件 `sessions.create`，无回收路径 | `DshAgentManager.ts` L174-179、L193 | 反复开匿名会话堆积 host 会话 | **P2**：清理策略（如关闭即删或定期清理） |
| D12 | **错误形状不一致**：DSH 失败返回 `JSON.stringify(result.error)`，无 i18nKey/debugDetails 分层；`getAvailableModels` 失败静默返回 `[]`；Coordinator 按错误文本启发式映射可能误判 | `DshAgentManager.ts` L250-251、L474；`Coordinator.ts` L1412-1464 | 渲染层无法区分「无模型」与「host 挂了」；错误码误映射 | **P2**：统一结构化错误 + 可区分错误码 |
| D13 | **setThinking 无模型选中时 catalog/host 漂移**：Coordinator 先写 catalog 再调 agents（顺序与 setModel 相反）；DSH 无模型时只记内存不落 host | `Coordinator.ts` L522-526 vs `DshAgentManager.ts` L513 | catalog 显示已换档但 host 实际未生效 | **P2**：顺序对齐 + attach 对账（G8） |
| D14 | **投影整数组复制 O(n²)**：`{...base, messages: [...base.messages, ...]}` 每次事件全量复制 | `dshEventProjector.ts` L122-131、L285-302、L428-441 | 长会话 + 流式时主进程 GC 压力 | **P2**：改增量写或结构共享 |
| D15 | **batch 问题无超时/无重试**：question 应答 JSON 损坏 → 静默按拒绝处理 | `DshAgentManager.ts` L637-642 | 用户已填表单被静默拒绝 | **P3**：提示重试 |
| D16 | **restartDshHost 无条件返回 true**：host 拉起失败 UI 也显示成功 | `index.ts` L2334-2341 | 配置页误导 | **P3**：检查 restart 结果 |

### 3.4 基础设施与通信层缺陷（深度核查，host 生命周期/桥/控制台）

> 来源：基础设施专项核查（`DshHost`/`DshHostProcess`/`DshApiClient`/`dshHostBridge`/`hostEntry`/`hideChildConsoles`，对照 pi 四件套）。

| # | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| E1 | **host-ready 等待无超时**：`waitForReady` 裸 Promise 无 timer；boot 卡死（进程存活但不发信号）时 `ensureStarted`/`dispose` 永久等待，连 quit 都被拖住 | `DshHostProcess.ts` L109-115、`DshHost.ts` L376-382（pi 侧探测均有超时 `PiLocator.ts` L391/L466） | 挂起 | **P0**：健康信号等待加超时（C11 载体） |
| E2 | **DshApiClient 无请求超时**：`bridgedFetch` 只建 pending + abort 监听；transport 死亡后新请求 pending 永不结算；`isStarted()` 仍 true（client 非 null），IPC 永久挂起 | `DshApiClient.ts` L95-140、`DshHost.ts` L53-55（pi `PiRpcClient` 有 30s 超时） | 挂起 | **P0**：PendingRequestTracker 统一超时（C13 载体） |
| E3 | **崩溃重启无限循环 + 无退避**：`restartCount` 在每次 host-ready 时清零（L121-123），运行期崩溃每次重启后计数归零可无限重启；`restartAfterCrash` kill 后立即 start 无退避 | `DshHostProcess.ts` L22-23、L101-104、L170-188（注释声称「限次避免死循环」与实际不符） | 崩溃循环 | **P0**：boot 失败与运行期崩溃分开计数 + 退避（C11） |
| E4 | **崩溃重启后主进程状态不重置、会话不 re-attach**：host 退出只 `abortAllPending`，`client`/`apiClient` 不清空；mux 重连用陈旧 client 向全新 host 重新订阅，流空转、会话停在崩溃前状态（streaming 时永远 streaming） | `DshHost.ts` L347-350、`DshAgentManager.ts` L757-910、`index.ts` L2335-2337 | 「静默断开」复发（注释称已修复，恢复路径是半成品） | **P0**：host-restarted 事件 + 会话 re-attach/状态重置（C11） |
| E5 | **forkEnv 传 `{}` + DSH 无环境清洗**：`ForkOptions.env` 显式传入即整体替换（`electron.d.ts`），host 近乎空环境运行（无 PATH/SystemRoot 等）；pi 有 `sanitizePiChildEnv`/`applyPiProxyEnv`，DSH 无 | `DshHost.ts` L341、`DshHostProcess.ts` L64-66 vs `PiLocator.ts` L174-208 | 需实测确认；宿主变量（ELECTRON_*/NODE_OPTIONS）可能污染子进程树 | **P1**：显式 env 策略 + 清洗（C15） |
| E6 | **exit 日志误导 + host-exit 消息被静默忽略**：运行期崩溃也打「exited before ready」日志；host 主动退出的 `host-exit` 消息（hostEntry L205-211）被 handleMessage 当普通桥消息透传，`parseDshFetchMessage` 不识别 → 无日志分支无处理 | `DshHostProcess.ts` L101-104、L117-137、`dshHostBridge.ts` L49-99 | 排障误导 | **P1**：日志条件修正 + host-exit 处理分支 |
| E7 | **stdout pipe 未消费，背压隐患**：fork `stdio:"pipe"` 只读 stderr，stdout 无人读（hostEntry 的 console.log 走 stdout） | `DshHostProcess.ts` L66-79 | 输出增多时管道缓冲阻塞子进程 | **P2**：消费或丢弃 stdout |
| E8 | **abort 监听器泄漏**：`bridgedFetch` 的 signal abort 监听结算后不 `removeEventListener`（host 侧反而有对称清理） | `DshApiClient.ts` L116-138 vs `hostEntry.ts` L276 | 长生命周期 signal 下监听器随重连累积 | **P1**：结算时移除 |
| E9 | **host 侧 abort 监听注册晚于请求**：`onAbortMessage` 在异步体内注册，主进程 abort 先到则丢失 → unary 请求无取消路径 | `hostEntry.ts` L238-243 | 请求不可取消 | **P1**：注册前置 |
| E10 | **部分启动失败不清理已 fork 进程**：`hostProcess.start()` 成功后 `getClient()` 抛错不 dispose，下次再 fork → 双 host 并存 | `DshHost.ts` L344、L352-370 | 资源泄漏 | **P1**：失败路径完整 dispose |
| E11 | **restartCount 不随显式 start() 重置**：3 次 boot 失败用尽后，用户再触发 start 的新 fork 也不再自动重启 | `DshHostProcess.ts` L61、L171-174 | 启动体验恶化 | **P2**：显式 start 重置计数 |
| E12 | **桥协议 URL 假设未校验**：`marshalFetchRequest` 丢 origin 只传 pathname+search，host 侧重基 `http://dsh.internal`；外部 URL 被静默重写；字节 body 无运行时拒绝 | `dshHostBridge.ts` L17-18、L31-46、`hostEntry.ts` L229 | 契约漂移 | **P2**：运行时校验/拒绝 |
| E13 | **主进程重复解析 host 侧格式**：`getDefaultModelSelection` 行级解析 settings.yaml、`readCredentialValue` 直读 .credentials.yaml，与 host 内解析两份代码，host 改格式时主进程静默返回 undefined | `dshDefaultModel.ts` L18-61、`DshHost.ts` L182-196、`dshCredentials.ts` L23-34 | 格式漂移 | **P2**：走 host RPC 或共享解析 |
| E14 | **getStatus 的 started 语义失真**：`started: client !== null`，host 崩溃重启超限后仍显示 started；重启后 client 是陈旧实例 | `DshHost.ts` L216-221 | UI 误导 | **P2**：语义改为「host 进程存活且 ready」 |
| E15 | **before-quit 清理不完整**：`void dshHost?.dispose()` fire-and-forget（boot 挂起时退出不等待）；`dshAgentManager.stopAll()` 未登记 | `index.ts` L3147-3149 | 退出竞态 | **P1**：QuitCleanupRegistry（C12） |
| E16 | **getClient check-then-act 竞态**：并发两次调用建两个客户端（当前仅 start 单点调用，低风险） | `DshApiClient.ts` L73-92 | 潜在双客户端 | **P2**：单例化 |

### 3.5 渲染层 UI 缺陷（深度核查，双后端分支中的硬编码/不完整）

> 来源：渲染层专项核查（`ComposerComponents`/`useSessionComposerController`/`SidebarComponents`/`DshConfigTab`/`useSessionActions`/`App.tsx`）。

| # | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| F1 | **DSH 图片附件静默丢弃（数据丢失）**：附件栏/剪贴板图片/拖拽入口对 DSH 同样展示，但 `DshAgentManager.sendPrompt` 只发 text，`input.images` 被静默丢弃；乐观消息上屏含图片，host 从未收到 | `ComposerComponents.tsx` L377-384（Paperclip 无后端分支）、`useSessionSend.ts` L369（images 透传）、`DshAgentManager.ts` L244-248 | 用户以为图已发出，实际丢失；乐观消息与会话不一致 | **P0**：DSH 会话禁用/隐藏附件入口并 toast 说明（G2 落地前）；或发送前拦截 |
| F2 | **默认后端策略分裂**：侧栏「+」默认 dsh；引导页首条消息创建 pi（无 backend）；并行问询匿名会话 pi；`createDraftDsh` 是死代码从未被调用 | `useSessionActions.ts` L224-226 vs `App.tsx` L1304 vs `useAskPanel.ts` L32 vs `App.tsx` L2575-2577 | 同一应用内新建会话后端不一致；死代码/死文案残留 | **P0**：统一新建会话后端默认值（C21），删除死代码与未用 i18n key |
| F3 | **compact 按钮对 DSH 永远显示「0%」**：`t("app.compactUsage", { percent: 0 })` 硬编码 | `ComposerComponents.tsx` L421 | 视觉噪音（实际上下文占用由 ContextMeter 显示） | **P0/P1**：DSH 下移除百分比或复用真实占用 |
| F4 | **`/` 命令补全对 DSH 空白**：命令源只有 `listRuntimeCommands`（pi）+ 内置桌面命令；DSH 命令注册表不提供列表 | `useSessionComposerController.ts` L503-518、`AppUtils.ts` L660-667 | DSH 用户无法发现 /permission /plan 等命令 | **P1**：G4 的 UI 侧 |
| F5 | **DSH 会话右键缺「复制会话文件路径」+ undefined 隐患**：主进程已实现 `dshSessionFilePath`，渲染层整组隐藏；若显示，`copyPath` 会把 undefined 写进剪贴板 | `SidebarContent.tsx` L291、`App.tsx` L2585-2589 | 能力缺失；`clipboard.writeText(undefined)` 写 "undefined" 字符串 | **P1**：接通复制路径入口 + 修复 undefined 防御 |
| F6 | **imagegen 模式对 DSH 无意义仍可选** | `ComposerComponents.tsx` L712-734 | 无效入口 | **P2**：DSH 隐藏 |
| F7 | **TurnRow 行头署名硬编码 "dsh"/"pi" 文本**，未走 i18n/徽章体系 | `turn/TurnRow.tsx` L256-259 | 与徽章体系不一致 | **P2**：统一 `SessionBackendMark`（C18） |
| F8 | **DSH 历史翻页轮次边界**：DSH 分支不读 `options.unit`，「按轮次翻页」退化为按条分页，可能截断一轮 | `sessionIpc.ts` L517-519 vs `SessionMessageTimeline.tsx` L560-609 | 翻页语义退化 | **P2**：DSH 分页支持 unit=turn |
| F9 | **RawTab 手拼文件路径**：`${homeDir}/${fileName}` 字符串拼接后走 files 读写 | `DshConfigTab.tsx` L1058/L1081 | 路径规范化依赖 replace 兜底 | **P2**：走主进程目录 API |
| F10 | **设置页无 DSH 入口**：`dshHomeDir`/`dshApprovalAutoAllow` 只在 ConfigModal DSH 页；Settings 页无 DSH 项 | 全仓搜索仅命中 `DshConfigTab.tsx` | 可发现性差 | **P1**：设置页加 DSH 状态/DSH_HOME/审批策略入口 |
| F11 | **权限/plan 状态全局不可见**：`permissionPreset`/`planModeActive` 只被底栏菜单与 composer 消费，侧栏/会话头/Tab 无徽标 | 全仓命中仅 `DshPermissionMenu`/`useSessionComposerController`/`ComposerPickerHost` | 权限/plan 态不透明 | **P1**：会话头/侧栏加状态徽标 |

---

## 4. 公共抽象建议（抽公共操作，pi/dsh 各自实现）

> 原则：**抽「操作契约 + 通用状态机」，不抽「事件解析」**。pi 与 DSH 的事件模型完全不同，
> 强行合并投影器只会得到一堆 if(backend) 分支。真正值得抽象的是：生命周期、能力协商、
> 运行时状态机、审批/提问桥、模型目录映射、消息窗口协议这类「两端语义一致、实现不同」的部分。

### 4.1 已抽象（保持现状，不要动）

| 抽象 | 位置 | 说明 |
|---|---|---|
| `SessionAgentGateway` + `CompositeAgentGateway` | `sessions/SessionRuntimeCoordinator.ts` + `agents/CompositeAgentGateway.ts` | 双后端路由、能力并集/缺失拒绝——**已达标，后续新能力一律进这个接口** |
| `capabilities` 能力协商 | 同上 | 新增 pi 专属能力时同步加枚举，禁止绕过 |
| 纯函数状态机模式 | `pi/streamGate.ts` vs `dsh/dshRuntimeControl.ts` | 两端各自纯函数、各自单测——模式已对齐，**不要合并成一个大状态机** |
| 事件输出契约 | `shared/types/agent.ts`（ChatMessage/ThinkingUpdate/ToolEventView/AgentRuntimeState） | 渲染层无感双后端的基础 |

### 4.2 值得新增的公共抽象（按收益排序）

| # | 抽象 | 现状（两边差异） | 抽象形态 | 收益 |
|---|---|---|---|---|
| C1 | **后端能力注册表（backend registry）** | `CompositeAgentGateway` 硬编码 pi+dsh；`main/index.ts` 装配散落 dsh 专用 deps（`SessionIpcDeps` 十几个可选函数） | 把「后端声明」收敛：`backendId → { gateway 工厂, capabilities, 专用 IPC 注入器, UI 元信息（badge/label/默认开关） }`，`registerBackend()` 注册式装配 | 未来加第三个后端（Codex/Claude 已有 importer）不再改 `index.ts`/sessionIpc 大块；sessionIpc 的可选 deps 从「十几个字段」变成「按后端查注册表」 |
| C2 | **进程/宿主生命周期管理基类** | `PiProcess`（spawn/退出清理/WSL）与 `DshHostProcess`（utilityProcess fork/健康信号/限次重启/退出清理）各写一套 | 抽象 `AgentHostLifecycle`：`start/waitReady/isReady/restart(限次)/kill+兜底强杀/退出订阅/清理登记`；pi/dsh 各自实现 transport 细节 | 崩溃重启、退出清理清单、健康诊断三处行为对齐；新后端直接复用 |
| C3 | **会话历史分页协议统一** | pi：文件分页（`readSessionDisplayMessagePage`，游标=消息下标）；DSH：`session.history`（游标=事件 seq）；sessionIpc 里按 `entry.backend` 分流 | 定义统一 `HistoryPageGateway`（`readPage(sessionId, cursor, pageSize, unit)`），两个实现各自翻译游标；渲染层已无感 | 消除 sessionIpc 里「pi 分支 + dsh 分支」散落；G14 归档恢复也可复用 |
| C4 | **审批/提问桥基类（UiRequestBridge）** | pi：`extension_ui_request`/`extension_ui_response`，有超时（`scheduleUIRequestTimeout`）；DSH：`approval/requested`+`question/requested` → `client-response`，**无超时、abort 不清（D1/D5）**——两端都映射同一 `agents:ui-request` 协议 | 抽象 `UiRequestBridge`：`parse(frame)/buildResponse()/onAbort(agentId, pending)/scheduleTimeout()`，共享「pending 表、超时、abort 清理、completed 事件」 | D1/D5 的修复载体；pi 侧 extension 请求与审批语义（approvalId）需保留 backdoor 字段 |
| C5 | **模型目录映射（catalog → AvailableModel）** | pi：`modelListCache`/`modelSpecsStore`（models.json）；DSH：`dshModels`（llm.models groups → AvailableModel） | 抽象 `ModelCatalog`（`listModels/selectModel/setThinking/refresh`），渲染层 `ModelPicker`/`ThinkingPicker` 只认它 | 思考档位过滤、草稿偏好、默认模型三段逻辑收敛 |
| C6 | **会话偏好持久化（草稿期 prefs → 激活 apply）** | pi：模型/thinking 写在会话文件/设置；DSH：草稿期写 catalog、激活时 `selectModel`+`reasoningEffort` | 抽象 `SessionPreferencesStore`（get/set/applyOnActivate），后端各自实现落点 | G8（attach 对账）顺带解决；免去渲染层「草稿/激活两套逻辑」 |
| C7 | **事件门控/回合闸（RunGate）** | pi：`streamGate`（世代封印 + agent_settled 解封）；DSH：`dshRuntimeControl`（cancelGeneration + turn/end 解封）——两套纯函数状态机语义平行 | 抽象 `RunGate`：`seal()/onRunStart()/onRunSettled()/shouldDrop()`，后端各自提供「run start/settled」事件映射（pi: agent_start/agent_settled；DSH: turn/start / turn/end） | 统一「停止后还在跑」「停止后立刻重发串台」两条竞态语义，可写共享单测；abort 主路径改动需谨慎 |
| C8 | **发送串行化（PromptSerializer）** | pi：协议内 `streamingBehavior` 队列；DSH：`waitForIdle` 100ms 自旋 + 30s 硬超时（规避 host reject 丢消息 bug） | `PromptSerializer`：per-session FIFO + 忙时策略（queue / wait-idle / reject）；DSH 的 waitForIdle 作为其实现注入，pi 走协议队列 | 消除自旋轮询、统一忙时策略、DSH reject 路径丢消息有统一兜底；需行为测试保护 pi 语义 |
| C9 | **会话身份桥（SessionIdentityBridge）** | `SessionCatalog.attachRuntime` 已是抽象（filePath/piSessionId/dshSessionId），但 coordinator/index.ts 里 `backend === "dsh"` 三元判断散布（Coordinator L875/877/979/1068/1070） | 收拢为 `describe(sessionId) → { filePath?, piSessionId?, dshSessionId? }`；能力级操作由 capabilities 表达 | 消除 backend 特判漂移（D7 类问题） |
| C10 | **fork/compact 统一 replacement 流程** | pi：经 `replaceBoundRuntime`（dispatch-lease/replacement 全套保护）；DSH：manager 内自行 stop→换绑（绕开保护，D3） | DSH fork 改为「host 侧 fork 完成后由 Coordinator 统一做绑定迁移」；compact 的完成状态由 Coordinator 统一跟踪 | D3 的修复载体；DSH fork 获得并发保护 |
| C11 | **子进程生命周期基类（ManagedChildProcess + CrashRestartPolicy + 健康信号超时）** | pi：spawn + EventEmitter + 无重启；DSH：utilityProcess + 无超时 ready 等待 + 无退避限次重启（E1/E3/E4） | `ManagedChildProcess`（start(带超时)/stop/kill 兜底/onExit/onStderr）+ `CrashRestartPolicy`（boot 失败与运行期崩溃分开计数 + 退避） | E1/E3/E4 的修复载体；pi 未来探测超时也复用 |
| C12 | **退出清理登记表（QuitCleanupRegistry）** | `before-quit` 手写清理链（webService/terminal/agentManager/dshHost/pet），签名不齐 | `register(label, fn) / runAll()`，顺序执行、单项失败记日志不阻塞 | E15 修复；AGENTS.md「退出清单同步登记」落成代码；新增资源不再改 index.ts |
| C13 | **RPC pending 管理 + 请求超时（PendingRequestTracker）** | PiRpcClient 有 30s 超时但逻辑私有；DshApiClient 无超时（E2） | `register(id, {timeoutMs}) / settle(id) / abortAll(error)` | E2 修复；两端的 close 清理逻辑统一 |
| C14 | **信封解析与校验共享** | pi `isResponse` 只查 type；DSH `parseDshFetchMessage` 逐字段校验 | `parseEnvelopeLine(line, knownTypes) / isEnvelopeOf(msg, type, id)` | pi 行解析升级到 DSH 同级校验强度 |
| C15 | **环境变量清洗与代理注入** | pi 有 `sanitizePiChildEnv`/`applyPiProxyEnv`；DSH 无清洗、forkEnv 传 `{}`（E5） | `sanitizeChildEnv(env, opts) / applyProxyEnv(env, proxy)` | E5 修复；两条后端子进程树对宿主变量行为一致 |
| C16 | **打包入口/依赖锚点定位** | pi：整套 PiLocator（用户安装检测）；DSH：`resolveHostEntryPath` 两分支 + `dirname³` 黑魔法 | `resolveBundledEntryPath(appPath, entryName)` 覆盖 dev/out/main/asar.unpacked 三形态 | 打包布局变更单点；消除脆弱假设 |
| C17 | **结构化进程诊断** | pi：`getDiagnostics`（8KB 环形缓冲 stderr/exitCode/signal）；DSH：只有日志流 | `ProcessDiagnostics`（recordStderr/setExit/toJSON） | DSH 启动失败/崩溃可上诊断卡，替代 grep 日志 |
| C18 | **后端标识渲染组件（SessionBackendMark）** | `backend==="dsh" ? <SessionBackendBadge/> : <SessionPiBadge/>` 三元在 SessionTree/SessionTabsBar/ComposerComponents 重复 6+ 处 | 公共组件收敛 logo+aria-label+data-backend | 新增后端只改一处；视觉一致（F7 顺带修复） |
| C19 | **模型目录数据源 hook（useBackendModelCatalog）** | `ComposerPickerHost` 按 `isDshSession` 分 loader（listDshModels vs projects.listModels）；底栏又按 backend 取 defaultModel | `useBackendModelCatalog(sessionId, backend) → { models, current, defaultModel }` | 消除「DSH 豁免 welcome 偏好」等易漏分支 |
| C20 | **安全/权限控制位统一（SecurityControl）** | `ComposerArea` 按 backend 在 `DshPermissionMenu`（3 预设）与 `SecurityLevelMenu`（pi 安全等级）间二选一 | 注册式 presets 表 `{ backend, options, confirmFor, apply }` | 底栏左工具组不再背后端 if/else |
| C21 | **新建会话服务统一（createSession）** | 默认 backend 分别写在 `useSessionActions`（dsh）、`App.tsx`（pi）、`useAskPanel`（pi）、`createDraftDsh` 死代码 | 单一 `createSession(projectId, { backend? })`，缺省值集中一处 | 消灭 F2 默认后端分裂与死代码 |
| C22 | **统一保存/脏注册（useSaveRegistry）** | Pi 侧 `ConfigModal` 的 dirtyTabs+saveByKey 与 DSH 侧 `DshConfigTab` 的 saversRef+DshSectionApi 两套平行实现 | 公共 hook（register/unregister/dirty 聚合/批量 save） | 一套语义；关闭确认逻辑统一 |

### 4.3 不要抽象（明确不做）

- **消息投影器**（`AgentMessageProjector` vs `dshEventProjector`）：输入事件模型完全不同，合并 = 双倍复杂度。
- **会话文件解析**（`SessionScanner`/`SessionHistoryReader` vs host session log）：持久化格式物理不同，保持各自。
- **发送协议**（stdio JSON-RPC vs ApiProxy 信封）：传输与领域契约不同，只共享 `SessionAgentGateway` 接口。
- **审批/提问弹窗**（渲染层）：已统一走 `agents:ui-request` → `SessionRuntimeUiOverlay`，不要再复制 DSH 专属审批 UI。

---

## 5. 落地路线（建议顺序）

> 状态：✅ 已完成（commit d258eeff / 30758e95 / ee5cc1d9）｜⏳ 后置（纯架构重构，功能已等价落地）

| 阶段 | 内容 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|
| **S1 运行时硬伤** | D1 abort 解阻塞审批/提问 + 超时、D2 sendPrompt 显式拒绝不支持载荷、D3 fork 接入 Coordinator lease 保护、D4 compact 补 waitForIdle/isCompacting；E1 host-ready 超时、E2 请求超时、E3 崩溃重启限次+退避、E4 崩溃后状态重置/re-attach；F1 DSH 附件入口禁用、F2 默认后端统一、F3 compact 0% 文案；A1 clone 分流（或 UI 禁用）、A8/A9 复制/导出分流、A2/A3 全量读/全文读 DSH 分支 | 无 | typecheck + 单测绿；DSH 会话 abort 中审批、fork 并发、host 崩溃恢复、clone/导出手测 | ✅ |
| **S2 收尾 + 公共抽象一期** | A4 注释修正、B6 同目录并发提示、D5 pending 表生命周期、D6 mux 重连补帧、E5 环境策略、E6 日志/消息处理、E8/E9 abort 泄漏与竞态、E10/E15 清理与退出登记；C12 退出清理表；C2/C11/C13 的等价修复已在 DshHostProcess/DshApiClient 内部落地（健康信号超时/请求超时/崩溃限次退避/pending 清理），基类化后置；C5 ModelCatalog 渲染侧已由 C19 覆盖（主进程侧 SessionAgentGateway.getAvailableModels 即统一接口，无需再抽）；C8 PromptSerializer 后置（pi 协议队列语义有回归风险） | S1 | 重构后 pi/dsh 全量回归（e2e 双后端） | ✅（抽象基类化后置） |
| **S3 公共抽象二期 + 数据面** | C18 SessionBackendMark、C19 useBackendModelCatalog、C20 SecurityControl、C21 DEFAULT_AGENT_BACKEND、C9 buildAttachPatch、C12 QuitCleanupRegistry、C1 dshBackend 依赖分组、C10 withRuntimeReservation、C22 useSaveRegistry 已完成；C6 偏好存储现状已满足（SessionCatalog=store，Coordinator.applyPreferences=applyOnActivate）；C3 历史分页**判定无需额外抽象**——所有分页路径已统一返回 `{ messages, total, nextBefore }` 形状，pi/dsh 分支经 `readDshHistoryPage` 注入隔离，再抽 HistoryPageGateway 属负优化（增加间接层、让装配层变胖） | S2 | sessionIpc deps 收敛；backend 特判消除；UI 双后端分支收敛 | ✅（C3 已论证无需抽象） |
| **S4 功能补齐 P1** | ✅ 全部完成：F5 复制路径入口、G11 设置页 DSH tab、G12 plan/权限徽标、G4 `/commands` 建议菜单、G16 usage 统计投影、D7 注释对齐、D8 abort 后 error 不投影、D9 工具卡收口（commit 976c02c8 / b2b2a212）、G9 会话全文搜索、G5 目标管理（goal/change 投影 + create/操作 + 工具面板）、G6 子代理呈现（subagent.list/history + 工具面板）（commit e3b116a1） | S3 | e2e 新增覆盖 | ✅ 10/10 |
| **S5 功能补齐 P2 + 增强** | ✅ 全部完成：F6 imagegen 隐藏、F7 署名 i18n、E14 getStatus 语义、D16 restart 校验、E12 桥 origin 校验、D13 setThinking 顺序、G1 删除提示、E16 getClient 单例、F9 路径拼接、G3/D11 孤儿检测、G17 DSH RPC 日志（复用 RpcLogger + 侧栏开关分流，commit f183f548/2062b278/c7fe6112/b4310c94）、**G2 图片附件**（`session.prompt` 的 `PromptContentPart` 原生支持内联 base64 image，无需桥字节扩展——upload 端点方案已废弃；Composer 附件放开 + 重发携带 images + 投影 imageBlocksFromContent，commit 已合）、**G14 DSH 会话归档恢复**（`DshHost.archiveSession/unarchiveSession/listArchivedSessions`：目录移入 `$DSH_HOME/.pideck-archive` + manifest，会话列表右键归档、配置页概览归档区一键恢复并重建 catalog 记录；`workspaceDirFor`/`dshSessionFilePath` 抽到 `dshSessionPath.ts` 供 DshAgentManager/DshHost 共用，单测 `dshArchive.test.mjs`）、**G13 插件配置区动态化**（插件 tab 不再硬编码 3 分区：dsh-settings 契约规定 namespace 即插件短名，除 PiDeck 独占管理的保留命名空间（模型/安全/预设）外 host 注册的命名空间全部按插件呈现，新插件自动出现；分类器纯函数 + 单测 `dshPluginNamespaces.test.mjs`）；D14/D15/E13 论证为现状可接受或已知限制；**G13 的安装/卸载/启停按钮论证为宿主契约限制**：`IApiClient`/`ApiProxy` 无 plugin 域（`dsh-host-plugin-inventory` 仅 Typert 远程面，PiDeck 的 ApiProxy RPC 传输不可达），官方 dsh-web 的插件页同样只读（inventory + configurable 两个只读 tab，install = 编辑 host cordis 配置），cordis-host-runner 未随部署提供——配置修改走「源文件」raw tab，插件区负责动态发现与配置 | S4 | 全量手测 + 打包验证 | ✅ 14/14 |

## 6. 验证门禁（沿用 AGENTS.md）

- 每个阶段合入前：`npm run typecheck` + `npm test` 全绿（涉及主进程/会话链路必须两个都跑）。
- 公共抽象改动必须保持现有单测绿（`tests/dsh*.test.mjs`、`compositeAgentGateway.test.mjs` 等），
  新抽象配新单测（行为不测实现）。
- 纯 UI 调整至少 typecheck；交互状态流转 hook 配测试。
- 双后端回归：e2e `dsh-models / dsh-restart / dsh-security-plan / dsh-title-diag` + pi 侧现有 e2e。
- 能力新增必须三处同步：`AgentGatewayCapability` 枚举、网关实现/缺失声明、渲染层 UI 入口。

---

## 7. G13 深化：真正的插件安装/卸载（动态 Cordis 插件管理）

> 状态：✅ 已实现（本目标轮）｜范围：**动态 Cordis 插件**（进程内临时扩展）的
> 安装/运行/停止/卸载 + 静态 Loader 只读清单。静态部署插件的增删/启停**论证为不做**
> （见下方「边界」）。

### 为什么是动态 runner，而不是静态 loader

- **静态 loader（cordis.yml）**：`ctx.loader.create/remove/update` 可运行时变更，但
  DSH host 的 Include 持久化写回的是**patch 合成后的树**（`applyEntryPatches` 把
  base + overlay 的 `insert` 行 append 进根列表），写回会把 patch 行 bake 进
  `cordis.yml`，下次 boot 再 apply 会重复——运行时变更静态 loader 不安全；
  且打包环境无法运行时 npm install 新包。
- **动态 runner（`dsh-cordis-host-runner`）**：官方为运行时插件生命周期设计的服务
  （`dsh-tool-cordis` 同源）：`define`（源码包，不落盘）/`run`/`stop`/`undefine`，
  按会话归属、面板手势无需审批。这就是 G13 文档里 `cordis-host-runner 可运行
  @pluginId` 所指的机制。官方 dsh-web 的插件页只有只读 inventory + 配置展示，
  **安装/卸载操作 UI 是本轮新增**（服务对象本身是官方能力）。

### 架构（三层）

```
配置页插件 tab（DshPluginSection）
  └─ IPC dshPluginList/Install/Run/Stop/Uninstall/StaticList
      └─ DshHost.pluginRpc → DshApiClient.rawFetch（复用同一桥 transport，不经过 ApiProxy 信封）
          └─ fetch 桥 POST /pideck-plugin/rpc
              └─ hostEntry 前缀路由 → ctx.pideckPluginBridge
                  └─ pideckPluginBridge.ts（cordis 插件，独立入口打包）
                      ├─ ctx.dynamicCordisRunner（define/runHostHalf/stop/undefine/inventory）
                      ├─ ctx.pluginInventory（只读 Loader 清单）
                      └─ ctx.agents.get(sessionId)（会话归属解析）
```

- `src/main/dsh/pideckPluginBridge.ts`：桥插件 + 纯函数（入参校验/视图映射/Agent
  解析/RPC 分发），命名导出 `{ name, apply }`（与 pideckPwshPersistent 同形状，
  electron-vite 多入口产物 `out/main/pideckPluginBridge.js`）。
- `src/main/dsh/hostEntry.ts`：overlay patches 挂载 `plugin-inventory` +
  `cordis-host-runner` + `pideck-plugin-bridge`；fetch handler 前缀路由
  `/pideck-plugin/rpc`（其余路径仍走 ApiProxy handler）。
- `src/main/dsh/DshApiClient.ts`：新增公开 `rawFetch`（桥传输复用，含超时/abort/
  dispose 全链路）。
- 主进程 `DshHost`：`listDynamicPlugins/listStaticPlugins/installDynamicPlugin/
  runDynamicPlugin/stopDynamicPlugin/uninstallDynamicPlugin`。
- 渲染层 `src/renderer/src/config/DshPluginSection.tsx`：清单行（名称/pluginId/
  归属会话/状态/错误）+ 运行/停止/两步确认卸载 + 安装表单（会话选择 + 3-6 小写
  前缀 + 名称/用途 + Host 源码）；静态 Loader 只读列表。

### 语义与安全边界

- 动态插件**进程内临时**：define 不写仓库/配置/磁盘，host 重启即失（运行器与
  dsh-tool-cordis 同语义）。
- **面板手势**（run/stop/uninstall）走 `requestId=null` 的 direct gesture，无需审批；
  模型驱动的 Client 激活审批流不在本 UI 范围。
- **只支持 Host 半区**：Client 半区需 dsh-web 浏览器页面渲染，PiDeck 桌面端没有
  client runtime——安装表单提示用户只填 Host 源码。
- Host 源码在 DSH host 进程内执行，运行器明示**不是安全边界**：UI 文案提示只安装
  自己编写的代码。

### 边界（明确不做，记录理由）

- 静态部署插件（`@deepseek-ai/dsh-*` 等 cordis 组合行）的增删/启停：Include 写回
  bake patch 行（见上），改动走「源文件」raw tab + host 重启；只读清单已展示
  moduleName/enabled/fiberPhase。
- Client 半区渲染、审批流 UI、跨重启持久化：依赖官方未提供/桌面端不存在的运行时。

### 测试

- `tests/dshPluginBridge.test.mjs`：入参校验（idPrefix/必填/源码上限）、inventory/
  Loader 视图映射、Agent 解析、RPC 分发、桥 fetch 协议（POST/JSON/错误 4xx）。
- `tests/dshApiClientBridge.test.mjs`：`rawFetch` 不经过 ApiProxy 信封、桥 unary
  响应原样返回。
- 真机验证（需真实 Electron + DSH host）：安装→运行→停止→卸载全链路，以及 host
  重启后清单清空。


---

## 8. 2026-12 兼容期修复清单（用户实测反馈轮）

> 用户实测反馈的一批问题，已在本轮全部处理；每条含根因与落点，供回归验证。

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| H1 | **轨迹面板不支持 dsh** | DSH 会话没有 pi 会话文件，`sessionsCatalogReadProcessEvents` 对 dsh 恒返回空数组，轨迹账本缺过程记录（模型切换/权限/plan/goal/压缩） | 新增 `src/main/dsh/dshProcessEvents.ts`（纯函数收集器）：mux 事件流按语义收集 modelChange（request/context）/ permission / plan / goal / compaction（/compact 命令回合）→ `DshAgentManager.readProcessEvents` → sessionIpc dsh 分支（运行时会话有效）；单测 `tests/dshProcessEvents.test.mjs` |
| H2 | **上下文圆环不支持 dsh** | DSH runtime state 无 contextPercent/contextTokens/contextWindow，圆环（ContextMeter）无 capacity 不渲染 | 接入 host `contextPressure`/`contextBreakdown` 投影：mux `session/projection` 帧实时推送（`applyProjectionFrame`）+ attach/restart 时 list projections 初值（`parseContextPressureProjection`/`parseContextBreakdownProjection`）→ getRuntimeState 映射 percent/tokens/window/messageTokens，圆环与 dsh-web 同源 |
| H3 | **草稿本全屏遮挡** | `.scratch-pad-overlay` 全屏遮罩 + 背景盖住整个应用 | 改为悬浮便签：overlay `pointer-events:none` 不拦截点击、去掉遮罩底色；面板右上角新增 X 关闭（Escape/⌘⇧S 保留） |
| H4 | **edit/write 工具卡不显示 diff** | ToolCard 展开区只渲染工具结果文本 | ToolCard 展开区对 write/edit/create/patch 优先渲染内联 FileDiff（复用 `getToolDiffTarget`/`fileChangeToDiffLines`），结果文本保留在其下 |
| H5 | **plan 模式回车不发送** | Enter 意图判定与 composer 模式无关，sendShortcut 非 enter-send 时 plan 模式回车只换行 | `composerBehavior.ts` 新增 `isPlanModeSendKey`：plan 模式（ComposerAgentMode==="plan"）下无修饰键回车强制发送（Shift/Ctrl+Enter 仍换行，IME 合成忽略）；controller onKeyDown 接入；单测补 `tests/composerBehavior.test.mjs` |
| H6 | **更新无法弹窗** | 更新检查改为「仅设置页手动触发」后，启动不再自动检查，有新版也不弹窗 | App 设置加载完成后自动 `appUpdate.check("auto")` 一次（`disableUpdateCheck` 门控，只跑一次，无周期定时器）；测试 `tests/appUpdateManualCheck.test.mjs` 随策略更新 |
| H7 | **web 端 dsh 会话未分组 / 重启后会话丢失** | WebSidebar 按 projectId 分组，孤儿记录（projectId 无匹配项目）不可见；catalog 草稿清理（见 H7b） | WebSidebar 增加「未分组」兜底分组（i18n `web.ungrouped`）；catalog 草稿清理只删 pi 后端 draft，dsh draft 保留（host 数据由 $DSH_HOME 持久化）；回归测试 `tests/sessionCatalog.test.mjs` |
| H8 | **自定义供应商无法保存** | DSH 配置保存带 `expectedRevision` CAS；并发写入（host 预设/dsh-web/另一 tab）使页面 revision 过期后，host 以 `SETTINGS_CONFLICT` 拒绝写入，而页面沿用同一过期 revision 重试会被**永久拒绝**（草稿无法保存） | `DshConfigTab.saveNamespace` 冲突时刷新 namespace（最新 revision）后重试一次（patch 为部分合并，安全）；非冲突错误原样上抛并保留草稿 |
| H9 | **排队/ask/目标/后台任务/子代理展示优化** | 五类卡片信息缺失、状态不可辨 | 队列项状态图标与撤回/重试、ask 卡片等待/已答/取消三态、目标卡片 phase 语义色+轮次进度、后台任务通知带会话/摘要、子代理 running 指示与模式徽标（渲染层多文件，见提交） |
| H10 | **历史会话加载（web 端 DSH 历史空态）** | Web 服务的 `readSessionMessages`/`readSessionMessagePage` 依赖只处理 pi 会话（有 filePath），DSH 会话（无 filePath）直接返回空数组/空页——桌面 IPC 已接 `readDshHistoryPage`，Web 侧独立依赖未接通 | `src/main/index.ts` 给两个 web 依赖补 DSH 分支，走 `dshAgentManager.readHistoryPage`（与 IPC 同源；未挂载 DSH 后端时安全回退空）；Web 前端无需改动 |
| H11 | **会话结束不展开工具调用、思考打字机残留** | useTurnExecution 在 agent 停转 1.5s 后自动收起；useSmoothStream 流式结束后仍按 drain 速率逐字排空 | 结束边沿（running→停转，有最终回答、最新轮、无手动 override）改为展开执行过程；`isStreaming` 置 false 时立即取消 rAF、排空队列、直接显示全文（打字机只在流式期间运行）；测试 `tests/timelineUxPolish.test.mjs` 随策略更新 |
| H12 | **默认 Agent 后端不可配置** | 新建会话默认后端硬编码 dsh（`DEFAULT_AGENT_BACKEND`，引导页/侧栏/并行问询三处） | 新增设置项 `defaultAgentBackend`（默认 pi，用户可切 dsh）：SettingsStore 默认值、CommonTab 选择器、useSessionActions 注入、引导页与 AskPanel 跟随；i18n 中英同步 |
