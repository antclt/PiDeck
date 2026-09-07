# PI 待办三态升级方案

## 目标与授权

用户批准升级 PI 待办工具，并明确：**不保留旧 `toggle` 操作入口，也不迁移旧待办数据**（旧会话待办不恢复显示，旧会话文件保持原样）。采用廉价 DeepSeek writer 串行实施，主代理审查验收。当前分支 `dev`，不创建修复分支、不提交、不暂存、不推送。

旧 **操作 API** 与旧 **持久化数据** 均不兼容：只支持新三态格式，旧格式视为无计划。

## 能力对照与范围

| 能力 | 现在 | 本次目标 |
| --- | --- | --- |
| 项目状态 | `done` 布尔 | `pending / in_progress / completed`，内部唯一真源 |
| 更新状态 | `toggle` 取反 | `update(id,status)` 显式、幂等；不接受旧 toggle |
| 新建计划 | replace(text,done?) | replace(text,status?)，默认 pending，可显式初始化进行中 |
| 增加项目 | add(text) | add(text,status?)，默认 pending |
| 更新正文 | 无 | 可选 update(id,text)，保持 ID 与顺序；至少传 status/text 之一 |
| 删除单项 | 无（只能整表 replace） | 新增 delete(id) 单项删除，编号不回收；删到最后一项即结束当前计划 |
| 计划生命周期 | list/add/replace/restore/clear | 保留这些动作与明确计划边界，禁止自动清空/自动晋升下一项 |
| 数据存储 | v2 + legacy | 只写/只读 v3（status，无 done）；旧格式不迁移、不显示 |
| 实时显示 | `☐ / ☑` | `☐ / ◐ / ☑`，复用现有 widget/RPC/圆环 |
| 离线历史 | 只支持 activePlan + done | 读取 v3 三态；旧数据直接显示空态，不做迁移 |
| 模型提醒 | 轮首快照可能过时 | 每次 context 根据当前计划刷新一份专属提醒，clear/第三方接管后移除 |
| 业务错误 | 返回 Error 文本但成功 | 校验失败 execute 抛错，由 pi 转 isError；失败不修改状态/快照 |
| 工具结果 | replace 只给数量 | replace/list 返回编号+状态+文本；update/add 给变更项与摘要 |
| 工具归属 | 路径子串 | 规范化来源与自身路径精确比较，不把近似命名第三方视为自己 |
| 更新幂等性 | 重复 toggle 翻回原状态 | 相同 update 不重写快照、不改变计划/任务 ID/关闭指纹 |
| 输入预算 | 无限制 | 新文本/数量有明确预算；超限拒绝且不部分修改；旧数据读取不静默截断 |

### 明确不做

- 不改 pi 核心、不加第二通信通道、不新增全局状态方案。
- 不修改 DSH 的工具/生命周期，DSH 原有三态要回归通过。
- 不合并或升级 `pi-deck-plan-mode.ts` 的独立生命周期；它的分支恢复问题另案处理。
- 不新增取消/依赖图/优先级/任务调度，不从工具名猜测哪个待办正在执行。
- 不用内容相同就去重 replace：它是明确的新计划边界；restore 仍是最近两份计划的交换，不是多级撤销。
- 不迁移无关的 sidebar/CSS/UI 组件。
- 不迁移旧待办数据：旧格式（`{todos,nextId}` 或 v2 `done`）读取时视为无计划，不转换、不写回、不删除旧会话文件；旧文件里的旧待办只是不再展示。

## 设计约束

### 1. 三态 API 与迁移

- actions 为 `list | add | update | delete | replace | restore | clear`，schema、description、promptSnippet、promptGuidelines 和上下文提醒统一。
- 不暴露 `toggle`，不提供旧 action 转换器；工具入参不暴露或默默消费 `done`。显式旧参数调用必须报错，不能假成功。
- `delete(id)`：正安全整数 id，删除单项；未知 id 抛错并附当前可用 id 列表（或提示 call list）；删除不回收编号（nextTodoId 保持单调），不覆盖 replace 的 previousPlan 撤销槽；删除最后一项时移除 activePlan，widget 与提醒消失，后续 add 使用递增编号创建新计划。
- `update` 参数：正安全整数 id，status 可选三态，text 可选非空文本，至少给一个更新字段；不移动项目、不更换 ID。
- 错误提示必须可操作：未知 id 附当前可用 id（超长截断并提示 list）；未知 action 枚举合法动作；status 非法列出合法值；缺参说明补哪个字段。
- `replace.items`：非空数组，每项 text 与可选 status。顺序执行通常一项进行中；真实并行允许多个，不强制自动改写其他项目状态。
- 持久化写 v3，activePlan/previousPlan 都存三态。只在明确变更时持久化，读取恢复不落盘。
- 只接受 v3 快照（activePlan.todos 每项含合法 status）；旧格式（legacy `{todos,nextId}`、v2 `done`、未知版本）一律视为无计划，不转换、不恢复、不写回。
- 旧数据无进行中证据，不自行推断。非法/重复 ID 的处理在扩展与历史读取两条链路保持一致并测试。
- 任务状态是工作记录，不是 runtime 活跃信号。首批复用当前旋转展示，不能新增自动完成/停止时重置的状态逻辑；历史动画是否暂停是独立展示政策，若实施只能依赖既有精确 session runtime，不能猜。

### 2. 提醒和结果

- `context` 是每次模型调用前的唯一状态对齐点：先移除历史里的本扩展提醒，再保留其他消息的相对顺序并临时追加一份当前提醒；提醒不写入会话历史。
- replace/update/restore/delete 后下一次 context 必须体现新计划；clear、空分支及第三方接管后不留旧提醒；上下文压缩后仍能从内存恢复当前计划提醒。
- 不在每次 context 再 appendEntry，不重写系统提示词，不制造额外模型请求。
- list/replace 的模型可见正文包含实际分配编号，不依赖 tool details 猜 id；返回当前状态统计；delete 返回被删项与剩余计数。工具结果不重复携带整份计划，避免会话体积随每次操作膨胀。
- promptGuidelines 引导模型：完成一项立即 update 为 completed；不要的项用 delete 移除；整表重构才用 replace；不确定当前编号先 list。
- 新输入建议预算：最多 100 项、单项 text 1000 UTF-16 code units；工具可见文本与提醒使用明确的输出预算/截断提示，不能无限拼接。历史持久化数据不得为迎合新输入限制而静默删项。

### 3. 模块边界

- 优先把状态解码、校验、reducer/转移、格式化抽成纯 helper，extension 只做 pi 注册、持久化与 widget 发布，避免原有约 520 行文件继续增长过 600。
- 扩展需要独立分发：不能 import 开发仓库里的 src/shared 路径，打包后不存在。
- 可将独立纯 helper 放 `resources/extensions/pi-deck-todo-state.ts`（现有根级 *.ts extraResources 会携带）；它不注册工具、不加入 BUILT_IN_EXTENSIONS，入口仍只有 pi-deck-todo.ts。
- shared 的历史解析器保持纯契约/纯转换，不反向依赖 renderer 或 pi runtime；与独立扩展必要的少量解码重复通过相同输入的 parity 测试约束，不增加生成器/打包管线。
- 新增源文件应有说明，禁止新增 any / 强转绕过类型；UI 文案走双语 i18n，样式只用现有 Tailwind/shadcn，不动 dirty 的 tailwind.css。

## 工作区边界

开始时已有用户/其他会话改动，禁止覆盖、回滚、暂存或混入本次修复：

- src/renderer/src/components/sidebar/ActiveSessionsTree.tsx
- src/renderer/src/components/sidebar/SessionTree.tsx
- src/renderer/src/styles/tailwind.css
- tests/sidebarChildCardLayout.test.mjs
- tests/titleScrollAnimation.test.mjs（未跟踪）

## 实施阶段（一个 writer，串行）

1. **核心状态与红灯测试**：先为已经证实的提醒过时、错误非拒绝、legacy 历史不一致写行为复现测试并记录失败；新功能写三态/幂等/非法入参测试。抽小型纯状态模块、实现三态 API 和 v3/旧数据恢复。
2. **端到端接入与修复**：更新 widget、提示词/context、工具可见输出/错误、归属判断、共享历史契约与 renderer 适配；更新因明确契约变更而过时的测试，旧数据测试永久保留。
3. **独立审查**：fresh-context 审查真实 diff，检查打包 helper、三态历史/实时、旧入口清除、状态原子性、旧用户改动保留和单测盲点。
4. **有限修正**：同一 writer 只修审查指出且位于本方案范围内的问题，再跑门禁。不能为通过测试放宽正确断言；范围外发现报告给主代理。
5. **主代理验收**：核对 diff/复现/门禁，总结剩余风险。改资源文件不会热替换已经运行的 pi 工具定义，开发验证需重启该会话 runtime；发行时按现有资源打包链路携带。

## 验收矩阵

- 三态：replace 初始进行中、add 可选状态、update 各状态、delete 单项/未知 id/删空、重复相同 update 无额外变更、显式并行进行中。
- 移除旧 API：schema/提示词无 toggle/done，实际旧调用拒绝，不能改错计划。
- 输入：非法状态、未知 action、未知 ID、非安全整数、空白正文、空替换、额外旧字段、预算边界；失败保留之前计划及撤销槽。
- 持久化：写入快照再用新扩展实例读取；v3 往返；旧格式（legacy/v2/未知版本）读取视为无计划且不写回、不改旧文件；active/previousPlan、restore、clear、branch/new/resume/reload 不串计划。
- 提醒：replace/update/restore/clear 后立刻一致；压缩后缺提醒时补一份；第三方接管清除，不污染其他消息。
- UI：真实扩展 widget 经过 parser 的三态结果、进度计数及动画 class；历史三态；DSH 映射不变；同状态更新不复活已关闭条。
- 错误：execute rejects；若集成测试可行，验证 pi 工具执行边界 isError（只返回 isError 属性无效）。
- 输出：replace/list 返回 ID 与状态；超长输出有上限及明确提示。
- 分发：纯 helper 在打包资源内，入口列表无误；不得让测试替身缺依赖还悄悄返回空对象掩盖加载错误。

必跑：`npm run typecheck`，以及 `node --test tests/piDeckTodoExtension.test.mjs tests/sessionTodoSnapshot.test.mjs tests/agentTodoList.test.mjs tests/sessionTodoStrip.test.mjs tests/builtInExtensions.test.mjs` 和本次新增针对性文件。按实际涉及范围补 SessionHistoryReader 的针对性测试。不强求全量 npm test；不跑真实网络/真实模型。
