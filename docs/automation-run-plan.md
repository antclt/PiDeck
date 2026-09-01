# PiDeck 自动化任务设计：Run 一等公民 + 本地 Agent 调度审计台

> 状态：调研 + 设计方案（v0.1，待评审）
> 范围：在不复刻 pi Agent 行为的前提下，利用 PiDeck 已有的会话 / Git / 审批 / 成本 / 通知基础设施，把「定时 / 事件驱动的无人值守 Agent 运行」做成桌面端一等公民。
> 阅读对象：PiDeck 维护者。相关规则约束见根目录 `AGENTS.md`（session-first、IPC 按域注册、shared/types 拆分、文件体量红线、测试门禁）。

---

## 1. 调研结论：业界怎么做 Agent 自动化

### 1.1 现有产品形态

| 产品 | 形态 | 触发 | 审批 | 运行隔离 | 可观测性 | 报告 |
|---|---|---|---|---|---|---|
| Claude Code Routines（云） | 云端保存 prompt + repo + connectors | 定时 / API / GitHub 事件 | 无（全自主） | 云端克隆 | run 历史 + 日志问答 | 打开 run 会话 |
| Claude Code Desktop Scheduled Tasks | 本机 | 定时 / 手动 | 可配置 per task | 可选 git worktree | run 历史含 skipped 原因 | 桌面通知 + 会话 |
| Claude Code `/loop` + Cron 工具 | 会话内 | cron | 继承会话 | 无 | 任务列表 | 会话内 |
| Cursor Cloud Agents | 云端 VM + Temporal | 手动 / 后台 | Auto-review 分类器（拦 ~4% 动作，回解释不打断用户） | VM + 镜像 checkpoint/restore | 截图 / 视频 / 日志 | 会话 |
| OvernightAgent (oa) | CLI + daemon | 队列 + 手动 `run --detach` | 四道验证门（tail 协议 / commit 检查 / 用户验证命令 / AI review）+ fix-loop | worktree per task + sandbox-exec | events.jsonl + SUMMARY.md | 晨报 |
| agent-cron (agcron) | Rust daemon | cron | `auto_approve` 布尔 | — | 日志 tail / 统计 | — |
| agentd | 本机 daemon | cron / webhook / 文件 / 链式 | — | Docker 沙箱 | 全量 trace + 成本 | — |

### 1.2 共性设计语言（值得抄的部分）

- **Run（一次执行）是独立实体**：有状态机（排队 → 运行 → 待审批 → 验证 → 成功/失败/阻塞/超预算）、结构化事件流、可回看的历史。
- **触发 ≠ 任务**：一个任务可挂多个触发器（定时 / 事件 / 手动 / API），任务可暂停不删除。
- **防抖与错峰**：同任务上一 run 未结束则跳过（记录 skipped 原因）；同一时刻任务加确定性 offset 错峰，避免 API 打爆（Claude 的做法：offset 由 task id 派生，稳定）。
- **错过补跑语义**：机器睡眠错过的 run 只补最近一次（Claude Desktop），不堆队列。
- **时间线本地时区**：cron 一律按用户本地时区解释，这是高频 bug 区（Claude 曾出 UTC 注入 bug）。
- **成本/超时/步数守卫**：预算耗尽自动停止，剩余任务标记 `budget-exhausted`；错误预算电路熔断（OvernightAgent `warnAfter/stopAfter`）。
- **验证循环**：unattended run 必须有 gate（git 提交检查、用户验证命令、AI review），失败进 fix-loop 并把 review 结论注入下一轮 prompt；重试次数上限后 `blocked-needs-human`。
- **风险分级审批而非全盘审批**（Cursor Auto-review 的核心洞见）：小模型分类器在动作执行前判断，拦 ~4%，把解释回给父 agent 让其自行改道，避免「审批疲劳」——把自主性做成「刻度盘」而不是「开关」。
- **环境是成功率第一要素**（Cursor 最大教训）：agent 跑不起来测试 = 环境没配好。任务级 bootstrap（安装依赖等前置脚本）先行。
- **紧凑恢复钩子**（OvernightAgent ADR-0015）：agent 上下文自动压缩后，注入任务上下文（进度、当前 prompt、步骤指针）防止失忆。
- **报告投递**：结构化事件 + 自动渲染的晨报（SUMMARY.md），「昨晚到底发生了什么」一次性讲清。

### 1.3 业界共性痛点（PiDeck 的机会）

1. **无本地统一看板**：CLI 工具（oa / agcron）无 UI，看不到全局运行状态。
2. **审批两极化**：要么全自主（Routines），要么全人工（传统 permission 模式）；没有「按风险分档」。
3. **无成本与预算的细粒度控制**：只有 token 计数，没有 run 级成本预算 + 配额。
4. **运行产物与日常会话割裂**：跑完只剩日志，不能像普通会话一样继续对话、回放时间线、回退变更。
5. **锁死单一后端 / 单一模型供应商**：oa 支持多 CLI 但无统一界面；Claude 系锁 Anthropic。
6. **报告通道单一**：桌面通知是极限，没有飞书 / Web 等多端投递。

---

## 2. PiDeck 的独特优势（可复用基础设施盘点）

PiDeck 不是从零起盘——下面这些已经存在，自动化任务直接站在上面：

| 已有能力 | 位置 | 对自动化的价值 |
|---|---|---|
| pi/DSH 双后端 RPC 运行时（`prompt`/`bash`/`abort`/`compact`/`set_model`/`extension_ui_response`…） | `main/pi/AgentManager.ts` | 驱动无人值守运行的原语齐全 |
| `withRuntimeReservation` 运行时预留 | `main/sessions/SessionRuntimeCoordinator.ts` | run 与手动会话共享同一套进程生命周期管理 |
| Session 时间线 / 历史恢复 / 摘要缓存 | `main/sessions/` | **运行产物天然是一条可打开、可续聊、可回放的会话** |
| `SessionUiResponseInput`（Ask 审批回传） | `SessionRuntimeCoordinator.respondToUi` | **原生审批通道**：自动化 run 可以静默挂起等审批 |
| GitService + WorktreeService | `main/git/` | run 级工作区隔离（并行不互踩）已实现 |
| rewind 纯 git checkpoint（`refs/pi-checkpoints`） | `main/rewind/` | **运行快照 / 回放 / 一键回退**，这是稀缺能力 |
| UsageStatsService + 账单解析 | `main/usageStats/` | run 级成本核算、预算守卫的数据源 |
| SecurityStore + policy | `main/security/` | 审批策略落点（已有快照给安全扩展消费） |
| FeishuBridge + AskCard + CardStream | `main/feishu/` | **飞书端审批卡片 + 运行报告投递** |
| WebServiceManager + WebEventStream | `main/web/` | webhook 触发端点、Web 端查看运行 |
| 桌面通知队列 / 桌面宠物 | `main/pet/`、通知模块 | run 状态桌面通知 |
| PromptManager / XuePromptManager | `main/prompts/` | 任务 prompt 复用本地模板 + 中文精选 |
| SkillManager + 内置技能安装 | `main/skills/` | 会话内 `/schedule` 自然语言创建的技能载体 |
| SettingsStore + 特性开关 | `main/settings/` | 保守默认 + 可回退的特性开关 |

**核心结论：PiDeck 已经具备「本地常驻调度审计台」的全部部件，缺的只是把它们编排成 Run 状态机的编排层。** 不需要复刻任何 Agent 行为——run 就是「按任务配置发起一次 pi 会话并驱动它」。

---

## 3. 核心设计：Run 一等公民

### 3.1 一句话定位

> **每次自动化运行 = 一条可审计的会话 + 一个 git 快照 + 一笔成本账 + 一份可投递的报告。**

用户视角：GitHub Actions 的运行看板 + Claude Desktop 定时任务的会话 + OvernightAgent 的验证循环 + PiDeck 自己的成本/飞书/宠物，全部落在本地、用自己的模型供应商。

### 3.2 领域模型

```
AutomationTask（自动化任务）= 触发器组 + 运行配置 + 审批策略 + 预算 + 报告设置
    │  （1:N）
    ▼
AutomationRun（一次执行）= 状态机 + sessionId（复用会话基建）+ checkpoint + 成本 + diff 统计 + 事件流
```

```ts
// src/shared/types/automation.ts（示意，非最终定义）
export type AutomationTriggerType =
  | "cron"        // 5 字段 cron，按本地时区
  | "git"         // push / new-branch / tag 等仓库事件
  | "file"        // 目录文件变更（watch）
  | "webhook"     // WebServiceManager 挂的 HTTP 端点
  | "manual"      // 仅手动 Run now
  | "after-run";  // 链式：下游任务，携带上游 run 摘要

export type ApprovalPolicy =
  | { mode: "auto" }                 // 全自动：只允许低风险动作
  | { mode: "gates" }                // 风险门禁：命中规则挂起等审批（桌面/飞书）
  | { mode: "review" };              // 完成后等人工 review diff 再提交/丢弃

export type RunStatus =
  | "queued" | "starting" | "running"
  | "waiting-approval" | "verifying"
  | "succeeded" | "failed" | "blocked" | "aborted" | "budget-exhausted" | "skipped";

export interface AutomationTask {
  id: string;
  name: string;                       // 用户可见名
  projectPath: string;                // 运行项目（必须已在工作区）
  prompt: string | { templateId: string };  // 复用 PromptManager 模板
  backend?: "pi" | "dsh";
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  triggers: AutomationTrigger[];
  approval: ApprovalPolicy;
  budget: {
    maxCostUsd?: number;              // 成本上限（基于 usageStats）
    maxTokens?: number;
    timeoutSec: number;               // 单 run 超时
    maxSteps?: number;                // 最大工具步数
  };
  verify?: {
    command?: string;                 // 用户自定义验证命令（非零退出=失败）
    requireCommit?: boolean;          // run 结束必须已有提交
    aiReview?: boolean;               // 是否用小模型 reviewer 判读
    maxAttempts: number;              // fix-loop 重试上限
  };
  isolation: "main-worktree" | "git-worktree";  // 用已有 WorktreeService
  bootstrap?: { script: string; timeoutSec: number };  // 前置环境准备（Cursor 教训）
  report: { channels: Array<"system" | "feishu" | "web">; morningDigest?: boolean };
  enabled: boolean;
  quietHours?: { from: string; to: string; timezone?: string }; // 静默时段（打点跳过）
}

export interface AutomationRun {
  id: string;
  taskId: string;
  status: RunStatus;
  sessionId: string;                  // ★ 复用既有会话基建：run 产物就是一条会话
  agentId?: string;
  checkpointRef?: string;             // rewind 快照
  attempt: number;
  startedAt?: number; endedAt?: number; durationMs?: number;
  costUsd?: number; tokens?: { input: number; output: number };
  diffStats?: { files: number; insertions: number; deletions: number };
  commit?: { hash: string; message: string };
  verdict?: string;                   // 摘要
  skippedReason?: string;
  error?: string;
  events: RunEvent[];                 // 结构化事件流（append-only）
}
```

### 3.3 Run 状态机

```
queued ──► starting ──► running ──┬──► verifying ──► succeeded
   │              │                │                    ▲
   │              │                ├──► waiting-approval ─┘（gates/review 命中）
   │              │                │       │ 批准 ──► running
   │              │                │       │ 拒绝 ──► aborted
   │              │                ├──► budget-exhausted（预算守卫触发）
   │              │                └──► failed ──► 重试（attempt+1，注入上次 review 结论）→ running
   │              └──► skipped（同任务上一 run 未结束 / 静默时段 / 错过不补）
   └──► aborted（手动停止）
blocked = failed 且达到 maxAttempts（需要人工介入）
```

### 3.4 关键流程（一次 cron 触发的 run）

1. **触发**：Scheduler 按本地时区评估 cron，命中 → 检查任务 enabled / 并发锁 / 静默时段 → 创建 run（`queued`）→ 桌面通知「任务 X 已开始」。
2. **启动**：`RunCoordinator` 向 `SessionRuntimeCoordinator` 预留/启动一个运行时，创建**新会话**（干净上下文，不复用旧会话），`set_model`/`set_thinking_level` 按任务配置套用；可选 `bootstrap.script` 前置执行。
3. **运行**：发送 `prompt`；订阅消息流。同时：
   - **BudgetGuard**：按 `get_session_stats`/usageStats 累积 token 与估算成本，超限即 `abort` 并标记 `budget-exhausted`；超时看门狗兜底。
   - **ApprovalGate**：监听工具调用事件，命中风险规则（push / 删除 / 安装依赖 / 网络 / 提交信息等）→ run 进入 `waiting-approval`，Ask 挂起到桌面/飞书卡片，用户批准后 `extension_ui_response` 回传继续。
   - **Checkpoint**：run 开始时打 rewind 快照（`refs/pi-checkpoints/run-<id>`）。
4. **验证**（可选，按任务配置）：run 声称完成后跑 gate 链——git 提交检查 → 用户验证命令 → （可选）AI review；任一失败 → fix-loop（把 review 结论拼进下一轮 prompt 重跑，attempt+1），超上限 → `blocked`。
5. **收尾**：生成报告（改动 diff 统计 / 成本 / token / 摘要 / 事件流），按配置投递（桌面 / 飞书 / Web）；写入 run 历史；`enabled` 的 `after-run` 触发器唤醒下游任务。

---

## 4. 功能清单（按用户价值分层）

### P0 — MVP（先把「Run 看板 + 定时 + 报告」立起来）

1. **Run 看板（运行面板）**：全局视图，GitHub Actions 风格的状态流。展示所有项目的 run：状态 / 耗时 / 成本 / 改动文件数 / 提交 / 结论。点击任何 run → 打开它的会话（完整时间线）、diff、报告。
2. **定时任务**：创建任务 = 选项目 + 写 prompt（可复用本地模板）+ 选 cron（预设：每晚 / 每早 / 工作日 + 自定义 5 字段，本地时区）+ 预算（超时 / 成本上限 / 最大步数）+ 审批策略（MVP 只提供 `auto` 与 `review` 两档）+ 报告投递。手动 `Run now`、暂停/恢复、删除。
3. **Run 报告**：改动文件列表 + diff 统计、成本与 token、一句摘要、事件流链接。桌面通知 + 可选飞书投递。
4. **预算守卫**：成本 / token / 超时 / 步数四类上限，超限自动 abort；全局并发上限（默认 1 个自动化 run，可调）。
5. **错过补跑**：睡眠错过的 run 只补最近一次，记录 skipped 原因（借鉴 Claude Desktop）。

### P1 — 安全与质量（把无人值守的胆子放大）

6. **风险动作审批门禁（gates）**：规则引擎拦截高风险工具调用（push / force-push / rm -rf / 安装全局依赖 / 任意网络请求 / 修改敏感路径），run 挂起 `waiting-approval`，桌面/飞书审批卡片一键批准/拒绝/改道提示。**审批疲劳控制**：命中后先把解释回给 agent 让其自行改道（Cursor Auto-review 思路），只在无法改道时才打断用户。
7. **验证与 fix-loop**：验证命令（如 `npm test`）+ git 提交检查 + 可选 AI review；失败自动重试并把结论注入下一轮，`maxAttempts` 上限。
8. **worktree 隔离**：并发 run / 不想碰主工作区的 run 用 `git-worktree`（复用 WorktreeService），结束可一键合并/丢弃。
9. **运行回放与回退**：基于 rewind 快照，run 结束后可一键 `restore` 到 run 前状态，或只保留部分文件（diff 级选择）。

### P2 — 触发生态与多端

10. **事件触发**：git 事件（新提交 / 新分支 / tag）、目录 watch、webhook（WebServiceManager 挂端点，body 原文透传不解析为指令——防注入，参照 Claude routines 的 text 字段语义）。
11. **链式任务（after-run）**：一个 run 成功后自动触发下游任务并携带上游摘要（如「release 分支创建 → 跑回归测试 → 汇报」）。
12. **会话内自然语言调度**：技能 `/schedule 每晚 9 点跑依赖审计并汇报到飞书`，解析后写入任务表（参照 Claude Code `/schedule`）。
13. **Web 端查看**：LAN Web 上浏览 run 看板与报告（复用 WebServiceManager）。
14. **清晨聚合报告**：所有过夜 run 汇总一份「昨晚发生了什么」投递飞书/桌面。

### 不做（边界，尊重 AGENTS.md）

- 不复刻 pi 的 Agent 行为 / 工具执行 / 会话写入；run 只是驱动 pi RPC 的编排层。
- 不引入第二条通信通道；不用云端执行（本地私有是差异化，不做云）。
- 不做沙箱（pi 无沙箱原语）；隔离只做 git worktree 层 + 审批门禁 + 提示注入防护。

---

## 5. 差异化亮点（为什么「与众不同」且「有利于用户」）

1. **运行产物 = 会话**：业界（oa / agent-cron）跑完只剩日志；PiDeck 的每个 run 天然是一条**可打开、可继续对话、可回放时间线**的会话。用户不是看日志，而是「走进」那次运行。
2. **run 级 git 快照与回退**：rewind checkpoint + diff 级 restore，无人值守跑完的变更可以**逐文件挑选保留或整体回退**——这是 oa 的 `git reset --hard` 之外的精细控制。
3. **原生 Ask 审批通道做「按风险分档」**：把 Cursor Auto-review 的「自主性刻度盘」落到本地——低风险动作自由跑，高风险动作挂起审批且先给 agent 自纠机会。别的本地工具要么全自动要么全人工。
4. **成本即一等公民**：run 有预算、看板有成本列、报告有账单——结合 usageStats，本地多供应商（pi 支持任意 models.json 供应商）的每一分钱都算得清。
5. **多端报告与审批**：飞书卡片审批 + 清晨聚合报告 + Web 端查看 + 桌面宠物通知——桌面应用的「温度」延伸到无人值守场景。
6. **全本地、多后端**：pi + DSH 双后端、任意模型供应商、数据不出本机。Claude 云 routines 做不到私有化，Cursor 云端贵且锁生态。
7. **与既有工作流同构**：定时任务用的就是用户每天都在用的会话、模型、提示词模板、Git 面板——学习成本≈0。

---

## 6. 架构落点（遵守 AGENTS.md 约束）

```
src/main/automation/
├── AutomationStore.ts        # 任务/运行持久化（JSON，schema 版本 + 迁移兜底）
├── Scheduler.ts              # cron 解析评估（本地时区）、确定性错峰、错过补跑、静默时段
├── RunCoordinator.ts         # Run 状态机；与 SessionRuntimeCoordinator 协作（reserve runtime / 新建会话 / prompt / abort）
├── ApprovalGate.ts           # 风险动作规则引擎 + Ask 挂起 + 桌面/飞书审批卡片回传
├── BudgetGuard.ts            # 成本/token/超时/步数上限 + 全局并发控制（消费 usageStats）
├── RunVerifier.ts            # 验证门链（git 提交检查 / 验证命令 / AI review）+ fix-loop 注入
├── RunReporter.ts            # diff 统计、摘要生成、报告投递（系统/飞书/Web）
└── triggerEvents.ts          # git/watch/webhook/after-run 事件适配（webhook 挂 WebServiceManager）
```

- **IPC**：新增 `automation:*` 通道组，三处同步（`shared/ipc.ts` 常量 / `main/ipc/automationIpc.ts` handler / preload 白名单 + 订阅返回 unsubscribe）。
- **类型**：`src/shared/types/automation.ts`，主/渲染共用；`shared/types.ts` 兼容导出。
- **渲染层**：新增 `components/automation/RunBoard.tsx`（看板）+ 任务编辑对话框 + run 详情页（复用 SessionView 渲染会话时间线）；atom 按域建（`atoms/automation.ts`），跨组件状态走 Jotai。
- **i18n**：所有用户可见文案进 `rendererCopy.zh-CN.ts` / `en-US.ts`。
- **测试**：Scheduler（cron/时区/错峰/补跑）、RunCoordinator 状态机、BudgetGuard、ApprovalGate 规则引擎、RunReporter 摘要生成，均 `tests/*.test.mjs` 纯逻辑单测；外部依赖（pi 进程/网络）mock。
- **特性开关**：`automation.enabled` 默认关，P1 的审批门禁/验证循环逐步放开。

### 状态流转的并发与安全要点

- 同任务并发锁：上一 run 未终态则新 run 直接 `skipped`（带原因），不排队堆积。
- run 与手动会话共用运行时预留（`withRuntimeReservation`），自动化 run 抢占时手动会话不受影响（按既有 reservation 语义）。
- webhook body 一律按**不解析的文本**透传进 prompt（参照 Claude routines `text` 字段），防 prompt 注入。
- 预算默认保守：无成本上限配置时仍给默认兜底（如 $2 / run 或最大 200 步），可关闭。
- 睡眠/退出处理：主进程退出清理清单登记 Scheduler timer、run 的 agent 子进程、watch；重启后 `running` 态 run 标记 `interrupted`，按「上次提交为界」决定重跑或报 blocked。

---

## 7. 分阶段落地

| 阶段 | 内容 | 验收门禁 |
|---|---|---|
| Phase 1 | P0 全部（看板 / cron / 报告 / 预算 / 补跑）+ `automation.enabled` 开关 | typecheck + Scheduler/RunCoordinator/BudgetGuard 单测全绿；手动 smoke：定时跑一条「生成 CHANGELOG 草案」任务并投递飞书 |
| Phase 2 | P1（审批门禁 / 验证 fix-loop / worktree / 回退） | 审批门禁规则引擎单测 + fix-loop 单测；手动 smoke：gates 模式任务在 push 动作时挂起、飞书批准后续跑 |
| Phase 3 | P2（事件触发 / 链式 / /schedule 技能 / Web 查看 / 晨报） | 触发事件单测 + webhook 集成测试（本地 HTTP mock） |

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 无人值守 agent 越界（删文件 / push / 装依赖） | 默认 `review` 策略 + gates 规则引擎 + 预算兜底；策略默认保守，P1 再放开 `auto` |
| 审批疲劳 | 命中风险先回传解释让 agent 自纠，仅无法改道才打断用户（Cursor 数据：~4% 拦截，多数可自纠） |
| 上下文膨胀 / 压缩失忆 | run 每次新建会话；连续 run 可选继承任务级摘要；compact 事件后注入任务上下文（oa ADR-0015 思路） |
| 机器睡眠错过 | 只补最近一次 + skipped 原因记录；设置里提示开启「阻止睡眠」（Windows 电源计划） |
| 多 run 并行互踩 | 默认串行 + 全局并发上限；P1 提供 git-worktree 隔离 |
| 成本失控 | run 级四类预算 + 全局并发 + 默认兜底额度 |
| 本地时区 cron 混乱 | 统一本地时区解释 + 任务显示 next run 预览（参照 agent-scheduler 的 cron 描述/预览） |

---

## 9. 待决策问题（评审时确认）

1. run 的会话归属：自动化 run 生成的会话是独立项目会话（列表可见）还是折叠在 run 详情里？建议：独立会话 + run 看板直达入口（会话复用 session-first）。
2. gates 的「风险动作」初始规则集：建议先覆盖 push/force-push、rm 类删除、全局依赖安装、任意 URL 网络请求、`.env`/密钥文件写。
3. AI review 的小模型选择：复用 pi 的 `get_available_models` 按需选便宜模型，或做成任务可选。
4. worktree 隔离是否 P1 必做：MVP 串行 + 并发上限已能覆盖绝大多数个人场景，worktree 可延后。
5. 晨报 / 飞书审批卡片是否需要新 IPC（feishu 已有 AskCard，大概率直接复用）。
