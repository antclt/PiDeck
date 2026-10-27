# SSH 远程功能优化计划：DS 执行交接

> 状态：**F1/F2/F3/F4 已实施（离线证据完整，§7.1 记录）；真实 SSH 主链本轮未跑，见 §7.2 未验证项**。UI 布局、视觉、组件和连接向导仍不在本轮范围。
> 目标：连接能及时取消，慢网络下资源有界，切项目和加载会话少做重复工作；保持现有远端文件、Git、会话、终端的行为与安全边界。
> 证据等级：下文分别标注源码核对、离线复现、历史验收和未来验收目标；不以代码量、测试数量或参考项目文档中的 PASS 证明本项目可发布。

## 1. 快照、范围与现有入口

| 项目 | 本轮核对基线 | 用途 |
| --- | --- | --- |
| PiDeck | `dev` / `d1cbcb35b1f6c82920078fcc5538196317e86f06` | 实施目标 |
| `F:/deepseek-harness` | `master` / `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` | 请求预算、写侧背压、取消与进程清理参考 |
| `F:/ZCode` | `main` / `3c5b227649371507ddc4eb46ac5133afe6db1cab` | 当前 R3 部署、连接取消、恢复与实机验收参考 |

PiDeck 调研开始已有三个未提交的并行文件：`src/renderer/src/components/session/trajectory/SessionTrajectoryPanel.tsx`、`src/renderer/src/hooks/useSessionTrajectorySource.ts`、`tests/trajectoryRefreshContract.test.mjs`。本轮不触碰；DS 开工时重新检查状态，不假设此清单仍完整。

执行前先读根 `AGENTS.md`、[架构](architecture.md)、[宿主边界](host-boundaries.md)、[工程标准](engineering-standards.md)、[Electron 手册](electron-playbook.md)。远端现有事实入口：

- [远端开发计划](remote-development-plan.md)：架构和能力边界；较早阶段的状态不能直接当现状。
- [发布门禁台账](remote-release-gate-status.md)：已有功能和历史实机证据，仍是唯一发布门禁台账，本计划不复制一套发布状态。
- [开发交接](remote-development-handoff.md)：历史问题、验收方法和落点。
- [远端扩展注入计划](remote-extension-injection-plan.md)：已有 S1/S2 与未交付 S3 的边界，本轮不扩展远端后端或扩展能力。

本次编写仅新增本文件，未修改产品代码，也未连接外部 SSH 主机。计划不授权发布、部署、远端破坏性演练或更改用户设置。后续 DS 在用户交办实施后按下述范围执行；公共契约变化先确认其实施计划并同步对应 spec，普通内部修复不另设审批。

## 2. 调研纠正：哪些不能作为“缺失功能”再做

| 上轮说法 | 本轮核对结果 | 本轮决策 |
| --- | --- | --- |
| PiDeck 没有帧/挂起请求上限 | [RemoteHelperContract.ts](../src/main/remote/RemoteHelperContract.ts) 已有 8 MiB 帧、4 个执行中、64 个排队请求；[RemoteControlClient.ts](../src/main/remote/RemoteControlClient.ts) 已有普通请求挂起表 128 门禁，cancel 特意绕过门禁 | 不重做限流；只补重复取消的有界性和写侧积压，见 F2 |
| PiDeck 的文件上传只有 scp | helper/扩展部署使用 scp；[RemoteProjectFileUpload.ts](../src/main/remote/RemoteProjectFileUpload.ts) 已用 stdin 分块上传，16 MiB 上限、摘要校验、临时文件后 rename | 分清部署上传与项目文件上传，禁止另造统一上传框架 |
| ZCode 当前主链是 `connect.ts → deploy.ts` | R3 当前入口是 [sourceServerConnectionManager.ts](../../ZCode/packages/desktop/src/host/sourceServerConnectionManager.ts) → [source-server/transportAdapter.ts](../../ZCode/packages/server/src/source-server/transportAdapter.ts) → SSH backend；规格明确废弃旧 `deployServer` 主编排 | 学当前 source-server 主链，旧 remote 目录只按仍被调用的原语参考 |
| 远端跑完整 Agent 天然违反 PiDeck 边界 | PiDeck 本来就在远端启动真实 pi。真正限制是 PiDeck 不重写 Agent 行为、不新增任意宿主桥、不擅自改持久运行语义 | 不把 ZCode 的部署模型定性成错误；本轮只借鉴适配我方模型的部分 |
| 行数多代表功能更成熟、E2E 文件多代表全套通过 | 文件数混有 fixture/pending/旧主链；没有本轮对应环境实跑不能推出发布质量 | 删除此类优劣判断，以调用链和具体断言为依据 |
| 我们还缺基本文件、Git、终端功能 | 当前台账已有这些能力及部分真实 SSH 证据 | 本轮聚焦可靠性与性能，不重做已交付动词 |

DSH 的 SSH provider 让 Agent 留在本地、文件和进程在远端；PiDeck 是本地 UI + 远端真实 pi + 独立 helper。两者并非语义等价实现，不能把对照阅读称为“与上游完全对齐”。

## 3. 推荐实施顺序

| 包 | 优先级 | 用户得到的改善 | 依赖 | 实施状态 |
| --- | --- | --- | --- | --- |
| F0 基线与场景固定 | 起点 | 优化有前后数据，定位慢在哪个阶段 | 无 | 本轮已有局部基线，待 DS 补场景 |
| F1 连接/部署取消贯通 | P1 | 取消后不继续上传、迟到上线；重试和退出不用等长超时 | F0 | **已实施**（§7.1） |
| F2 控制写侧背压与取消去重 | P1 | 慢链路、对端不读时不会不断积压；重复取消不放大请求 | F0；与 F1 共享 launcher 时串行 | **已实施**（F2a+F2b，§7.1） |
| F3 已安装 bundle 的验证复用 | P2，高体验收益 | 切项目和重连不再每次重传相同 helper/runner | F1；bootstrap 契约评审 | **已实施**（§7.1） |
| F4 会话元数据批量读取 | P2，高体验收益 | 多会话列表在高延迟网络下减少往返 | F2/F3；helper 契约评审 | **已实施**（§7.1） |
| F5 真实 SSH 功能回归与故障恢复 | 每包门禁 + 收尾 | 实际产品链路可用，取消/断线/重试不重复执行写操作 | 随各包推进 | 本轮未跑真机（§7.2） |

首轮推荐交付 F1 + F2，再交付 F3 + F4；每包都包含相应 F5 场景，不把真机验证全部推到最后。F6 候选项不在默认实施范围内。

### F0：固定基线，不新增监控系统

在已有测试 ports、fixture 与主进程日志中记录一次操作的：总耗时、SSH 子进程数、node/pi 探测次数、bootstrap 调用次数、实际 scp 次数/上传字节、helper RPC 次数、峰值未发送字节、终态与清理结果。计数属于测试证据；生产诊断沿用已有稳定码与脱敏边界，不为计时先改 shared/IPC 或设置 schema。

基准场景固定为：首次连接；同主机 A→B→A 文件读取；配置根→会话根→项目根切换；100/2000 个会话的列表；部署中取消立即重试；慢读对端下连续请求。先用可控延迟消除抖动，再在授权的真实 SSH 环境复核。报告中说明 cold/warm、样本数、客户端/远端 OS、版本及实验条件；未测的 p95 不编造。

性能优先用实际工作量作硬判据（额外上传次数、RPC 数、缓存峰值），墙钟耗时作同条件前后对比。不要未测先承诺“连接必须 2 秒”或套用 ZCode 的 10 秒恢复预算。

### F1：让取消真正到达部署与进程边界

**源码依据**：

- [RemoteHostConnectionService.ts](../src/main/remote/RemoteHostConnectionService.ts) 的模块说明明确：`bootstrapPinnedHost` 无取消参数，上传进行中不能取消；`disconnect()` 要等待同主机 `operationLock`，`dispose()` 等待 `inFlight`。
- [RemoteBootstrapSession.ts](../src/main/remote/RemoteBootstrapSession.ts) 的 `runPreparedBootstrap` / `bootstrapPinnedHost` 和 [RemoteBootstrapDeployment.ts](../src/main/remote/RemoteBootstrapDeployment.ts) 未接取消信号；bootstrap session 总预算为 300 秒。此值是预算，不是已经测出的用户等待时间。
- ZCode 当前 [transportAdapter.ts](../../ZCode/packages/server/src/source-server/transportAdapter.ts) 有 `TransportContext.signal`、target 级 cancel，上传传递 signal；[ssh-backend.ts](../../ZCode/packages/server/src/remote/ssh-backend.ts) 在 await 后重验 disposed，防止旧连接复活。参考的是生命周期做法，不照搬 daemon 和协议。

**最小方案**：

1. 每次连接/部署 attempt 持有自己的 AbortController，取消先标记该 attempt 并触发 signal，再进入锁内完成状态收敛。不能把“用户点了取消”也排在该 attempt 的长操作之后。
2. signal 贯通 node 探测、bootstrap ready、scp 上传、finalize 等待和扩展快照部署；优先用已有 launcher handle 的 stop，任何新等待都必须能同时被超时/取消/退出结算。
3. 每个 await 后、真正 spawn/上传/finalize/发布 ready 前检查 signal 与 attempt 身份。迟到 continuation 只能清理自己的 handle、nonce、staging，不能拆掉新 attempt 或其它主机。
4. 分清提交点：finalize 前取消可终止传输并清理本次 staging；commit 已发但回执丢失只能报未确认，不能宣称激活已撤销，也不能自动重放 finalize 或用户写操作。
5. 沿用现有 IPC 与状态语义。确实需要新增稳定码/契约字段时先补相应合同；不要顺手改状态名称、连接向导或重试次数。

**主要范围**：`RemoteHostConnectionService.ts`、`RemoteBootstrapSession.ts`、`RemoteBootstrapDeployment.ts`、`RemoteBootstrapTransfer.ts`、`RemoteExtensionDeployment.ts`；必要时 `SshClientRuntime.ts` / `SshProcessLauncher.ts` 及直接调用者。存量大文件不得净增，新逻辑抽到该域小模块，不大范围拆文件。

**验收**：

- 分别阻塞 probe、ready、upload、finalize：取消均结束等待，timer/listener/本 attempt 子进程释放，不用等 120/300 秒默认预算；确定性测试推进到既有 stop/kill 预算即可收敛。
- 取消 A 后立即重试 B，A 的 ready/error/exit 迟到都不能把 B 标为失败或在线；取消上传后不再启动后续 finalize（若提交点已经越过，按未确认语义结算）。
- 主机 A 取消不影响主机 B；应用退出能清理本次连接资源；显式断开后后台扫描不自动复活连接。
- 授权真机上在部署阶段取消，独立检查属于该 run 的进程、staging/锁状态，随后重新连接并完成一次文件读取。不用按名称批量杀远端进程。

**定向回归**：`remoteBootstrapSession.test.mjs`、`remoteBootstrapSessionIntegration.test.mjs`、`remoteBootstrapDeployment.test.mjs`、`remoteBootstrapTransfer.test.mjs`、`remoteHostConnectionService.test.mjs`、`remoteRuntimePortExtensions.test.mjs`。新增 race 用例放新测试文件或追加，保留已有断言。

### F2：补真正缺失的预算，不重写现有协议

**已复现**：对一个尚未回复的普通请求连发 256 次 `cancel(targetId)`，当前实现得到 **257 个 pending、256 条 cancel 帧、257 个 timer**。`closeConnection()` 后都清零。说明 cleanup 已有，但取消风暴到来前的资源占用没有独立界限；尚未证明正常 UI 会发出该风暴。

**写侧源码依据**：[SshProcessLauncher.ts](../src/main/remote/SshProcessLauncher.ts) 的 `writeStdinLine` 校验单帧后直接 `stdin.write`，不使用返回的背压信号；不能把已有单帧/读侧上限当成未发送字节总量上限。实际内存增长尚未压测，F0/F2 必须用慢 Writable 复现。

**参考**：DSH [protocol.ts](../../deepseek-harness/packages/ssh/ssh/src/protocol.ts) 的 managementLimits、queuedBytes、writeTail 与 drain/close 结算。只借鉴预算与清理；PiDeck 继续 NDJSON，不迁移它的长度前缀协议、TLS-PSK 或 Unix socket 拓扑。

**最小方案与顺序**：

1. F2a 先做取消合并：按连接 generation + 原始普通 requestId 合并同时进行的取消，复用结果；只为实际在途普通请求预留取消额度，防止取消请求再被无限套娃取消。普通请求原有 128 门禁、helper 的 4+64 门禁与“满载仍可取消”的语义保留。
2. 用独立的有界取消记录维护该额度；原请求/取消请求完成、超时、连接关闭都回收。先核对 manager 与 reader 的直接调用者，不改变 `commit-started` / `already-settled` 或回执丢失的含义。
3. F2b 再做发送字节预算：计入应用待发队列与 Node Writable 已缓冲的字节，在写入风险点限制；遇到 `write=false` 尊重 drain，error/close/abort 都释放等待。不要只在上层 pending 表处检查。
4. 优先限制在现有 main 内部传输边界。若要把 handle.write 改为 awaitable，先列齐直接调用者，覆盖 bootstrap 连续帧和项目上传的 END/EOF 顺序；不能只改签名而让调用方继续不 await。
5. 不自动重发 write 失败的帧；某帧若在本地尚未提交就超时/取消，必须从待发队列剔除，或者终止其所属连接并明确结果，不能 drain 后才补发旧写请求。普通队列满仍给取消/收尾留有界空间，但网络完全阻塞时不能承诺远端取消成功。

**验收**：相同 target 重复取消只发一条在途 cancel 帧；普通请求饱和时原有 cancel 用例照常通过；无回复/反复超时/断线换代时表、字节计数、timer 都有上限且归零。慢 Writable 返回 false 后不会继续无界写；drain 恢复保持整帧顺序；关闭或错误不挂等待；过期帧不迟到执行。项目文件上传的 SHA/字节数与最后 END 顺序不变。

**主要范围与回归**：`RemoteControlClient.ts`、`SshProcessLauncher.ts`、`SshConnectionAttempt.ts`、其直接写调用者；`remoteControlClient.test.mjs`、`sshProcessLauncher.test.mjs`、`sshLauncherOutput.test.mjs`、`remoteProjectUpload.test.mjs`、bootstrap 相关测试。优先沿用已有错误码；必须新增公共码时先更新合同。

### F3：切项目仍重建 root 会话，但复用已验证的安装内容

**现状**：`establishProjectSession` 切 root 会 `discard(entry)`，清掉 held 与 manager；`ensureHeld` 再发现 Node 并 bootstrap。`bootstrapPinnedHost` 又验 Node 版本，`deployPreparedBundle` 每次先 scp 再 finalize。会话配置根与会话存储根也会造成 root 切换。

**重要测试约束**：[remoteHostConnectionService.test.mjs](../tests/remoteHostConnectionService.test.mjs) 已明确断言 root 切换会再次调用 bootstrap 并用新 root 建 manager。**不得把这些断言改掉来实现缓存**。本包不做多 root helper、连接池或“保留旧 root 会话”。

**参考**：ZCode 当前 adapter 用已经观察到的 daemon ready 状态减少重复启动，但 ingress 身份仍重新获取；组件安装按预期身份校验而不是只看路径存在。我方借鉴“跳过重复工作但保留验证”，不引入 daemon。

**选定方案**：保留每次 root 切换的 bootstrap 调用，在 bootstrap 内增加“验证已安装 bundle”分支：

1. 使用固定、版本化 bootstrap 代码检查目标内容寻址目录，而不是执行待验证 helper 来证明它自己可信。
2. 按本地 manifest 逐文件确认内容 SHA-256、bytes、owner/mode、文件类型、目录和路径约束，使用现有部署锁/并发边界；只有完全匹配才返回可复用事实。校验必须发生在远端，不把上次成功写进本地永久缓存后直接信任。
3. 目录缺失进入现有 staging→scp→finalize；已存在但摘要/权限/owner/类型异常沿用 fail-closed 修复路径，不能覆盖可疑目录或“坏了就静默重装”。
4. verify 返回完整 manifest/bundle 身份，main 严格校验；root 仍单独 canonical 复核并随新 helper 启动/hello 核对。主机 pin、route、revision、Node 版本门控不跳过。
5. 第一阶段只优化 helper/runner bundle，明确不顺手扩展 Node 分发、扩展缓存或 pi 探测缓存。测量后再决定是否消除同 attempt 重复 Node 版本探测；不能为省一次命令弱化信任检查。

**契约步骤**：这是 bootstrap 握手增量。实施前补 [开发计划 §4.2](remote-development-plan.md) 与 bootstrap 合同，明确 `verified-existing` 与 `finalized-new` 的内部结果如何归一、是否 bump 版本以及旧输入的拒绝策略；同步冻结源码摘要/manifest。不要混用“没有传输”与“上传成功”，也不要制造第二套部署入口。

**验收**：首次 cold 正常上传；相同 bundle 的 A→B→A 中，bootstrap 调用与新 root 握手仍发生，但首次安装后实际 scp 次数为 0；损坏任意 payload、缺文件、权限异常、symlink 替换都不能命中复用；两客户端不同 bundle 并存不互删；取消 verify 不进入 upload；新增/旧 bootstrap 用例全部保留。

**主要范围与回归**：`RemoteBootstrapContract.ts`、`RemoteBootstrapSession.ts`、`RemoteBootstrapTransfer.ts`、`RemoteBootstrapDeployment.ts`、必要的维护调用；`remoteBootstrapContract.test.mjs`、`remoteBootstrapSessionIntegration.test.mjs`、`remoteBootstrapDeployment.test.mjs`、`remoteHostConnectionService.test.mjs`、`remoteProjectReadIsolation.test.mjs`、`remoteProjectRootReverify.test.mjs`、`remoteBundleMaintenance.test.mjs`。

### F4：批量取会话元数据，缩短占用主机操作锁的时间

**源码依据**：[RemoteSessionScanner.ts](../src/main/sessions/RemoteSessionScanner.ts) 的 `collectEntries` 先列目录，再对每个候选文件做一次 `fs.stat`，最多 2000 次、并发 4；整个扫描持有项目 session 的操作边界。这是源码确认的往返成本，不代表已经测得具体慢多少。

**选定最小方案**：新增有界 `fs.statMany`，不把全部会话发现/标题/项目归属规则搬入 helper。

- 扫描器继续拥有候选选择、现有配置根解析、预算、排序、catalog 归属及 tombstone；只把逐文件 stat 合成小批次，建议每批最多 64 条，总请求/响应仍受现有帧上限约束。
- helper 每条复用现有 `fs.stat` 的 root/非链接/路径校验与结果形状，拒绝任何路径逃逸；不新增任意绝对路径读取、不 import pi SDK、不读正文。
- 原 512 目录/2000 文件/1 MiB 元数据预算不提高，计费仍按逻辑条目，而不是“合成一个 RPC 只算一条”。过界继续报错，不返回貌似完整的半列表。
- 单项类型变化、消失、权限失败的语义先与当前单条 stat 对照；保持现有扫描行为，不靠新增 fallback 吞掉失败。传输中断不能返回部分成功。
- 旧 `fs.stat` 保留给其它消费者和原有测试；新调用前 capability gate，缺能力明确报不兼容并走已有升级/修复流程，不维护两套隐式扫描实现。
- 此方案是本轮针对 PiDeck 成本的设计，不宣称 DSH/ZCode 已有同名 API。DSH 的 bounded FS/RPC 提供边界参考；现有扫描器注释建议未来 `session.list`，本轮选择更窄的批量元数据，避免把会话规则再复制一份。

**契约步骤**：先定义 `RemoteHelperContract` 的方法、输入/输出/错误/取消与 capability；同步 helper 版本、冻结源码与摘要，再接 reader/scanner。公开 renderer 列表形状保持不变；不改 pi 配置优先级、会话格式或扫描范围。分 F4a（合同、helper、reader 与新增行为测试）和 F4b（扫描器接入）交付；F4b 前盘点既有扫描测试的假端口是否只接受 `fs.stat`。若需要升级测试合同，作为独立任务保留原行为断言后处理；未解决前不把 F4a 当作扫描优化已完成，也不加入仅为绕过旧测试的生产 fallback。

**验收**：在相同候选集合下，2000 个文件的元数据 RPC 由 2000 次变为最多 32 次（64 条/批；不含原有 list/config/root 探测）；空集不发 stat 请求；最后不足 64 条正常；重复/越界/不存在/类型变化/超预算遵循已定义语义。对冻结临时目录逐项对比新旧 size/mtime/id/顺序；mtime 来自远端事实，不能用当前时间或文件名猜。100 ms 可控 RTT 下报告前后耗时，真机再确认列表与导入仍一致。

**主要范围与回归**：`RemoteHelperContract.ts`、`RemoteHelperEntry.ts`（需要时抽独立 helper 实现并纳入 manifest）、`RemoteWorkspaceReader.ts`、`src/main/sessions/RemoteSessionScanner.ts`；`remoteWorkspaceReader.test.mjs`、`remoteWorkspaceEndToEnd.test.mjs`、`remoteSessionScanner.test.mjs`、`remoteSessionScanIsolation.test.mjs`、`remoteSessionRootResolution.test.mjs`、`remoteSessionRegistration.test.mjs`，以及新增 batch 行为测试。若旧测试钉的是逐条实现且与新合同冲突，记录为独立测试合同更新事项，不在本包改写/删除原断言。

## 4. F5：验收到真实功能链，而不是“单测绿了就结束”

| 场景 | 必须观察的产品结果 | 独立证据 |
| --- | --- | --- |
| 部署中取消→立即重试 | 旧 attempt 不上线，新连接能读文件 | 本 run 进程/锁/staging、代次、上传与 finalize 计数 |
| A/B 项目交替 + 配置/会话扫描 | 文件内容/会话归属不串，旧请求不能落到新 root | 同名不同内容 fixture、root 握手、scp/RPC 次数 |
| 普通请求满载 + 重复 cancel + 慢读 | 内存队列有界、取消保留通路、断开收尾 | pending、queued bytes、监听器和 timer 计数 |
| 文件/Git 写已执行但回执丢失 | 明确未确认，不自动重复写/提交/推送 | 只读复核文件摘要、Git HEAD/refs；不做第二次 mutation |
| pi runtime 意外退出再恢复 | 恢复同一会话，历史不丢，prompt 不重放 | Session 身份、远端历史、实际 prompt 次数 |
| helper bundle 已存在/损坏/版本变化 | 合法缓存少上传，异常明确拒绝或走既有修复 | 本地 manifest 与远端逐文件核查，升级/降级结果 |
| 退出/断开 + 终端 | 只清理本 run 资源，不留无限等待，不伤其它会话 | 有归属的 pid/nonce/lease，终端关闭后的远端进程观察 |

三层证据都需要，但不可相互冒充：

1. **定向离线**：真实生产模块 + 可控时钟/传输，验证边界与 race。现有 `tests/helpers/loadTsCommonJs.mjs` 等直接复用，不手写 VM loader。
2. **真实子进程**：实际冻结 helper/bootstrap 文件与临时目录；验证校验、原子激活、EOF/取消与半写。不能用对源码做正则代替运行。
3. **真实 SSH + Electron**：授权隔离主机、临时 userData/项目、真实 pi 和原生文件/Git/终端；模型回复可控，但实际远端执行与落盘必须真实。只中断本次 fixture 持有的连接/进程，不重启共享 sshd/宿主服务。

复用 [remote-fixtures.ts](../e2e/remote-fixtures.ts)、[主机验收](../e2e/remoteHostAcceptance.spec.ts)、[会话与功能验收](../e2e/remoteSessionAcceptance.spec.ts)。新故障场景另写 spec，避免继续扩大大文件；现有场景可用 `--grep` 精确选择。参考 ZCode [SSH P0 计划](../../ZCode/docs/testing/ssh-remote-p0-e2e-plan.md) 的 setup/action/assertion，以及 [当前远端阅读入口](../../ZCode/docs/remote/README.md) 的正式/pending/历史证据分界；链接中的 harness 路径若本地不存在，不能写成可直接执行的工具。

DS 实施每包后运行 `npm run typecheck` 和该包列出的 `node --test tests/<文件>.test.mjs`。仅选择相关 E2E，例如：

```sh
npx playwright test e2e/remoteHostAcceptance.spec.ts
npx playwright test e2e/remoteSessionAcceptance.spec.ts --grep "远端 Git G6b|远端终端|远端会话产品路"
```

上述 E2E 仅在已获得相应主机/操作授权且环境具备时执行。缺凭据导致 skip 必须记录“未验证”；不把历史成功或离线替身升级为本轮真机成功。Windows→Linux 优先，Linux→Linux 次之，macOS 仍需对应机器证据。定向测试全绿后，只有新变更/失败/未解决问题才扩大验证；不运行全仓构建或为文档任务跑打包。

证据复用测试输出/trace 位置。每项记录：caseId、源码 revision/dirty 范围、helper/runner/bundle 版本、环境类型（不放连接凭据）、执行命令、pass/fail/skip、前后计数/耗时、清理结果、证据路径。历史发布项仍回填 [发布门禁台账](remote-release-gate-status.md)，不把本计划标成“全部发布通过”。

## 5. F6：后续候选，不交给 DS 顺手扩大实施

| 候选 | 价值与参考 | 当前处理 |
| --- | --- | --- |
| 部署 scp/SFTP 不可用时走 exec 流 | ZCode `ssh-backend.ts` 有真实实现，可覆盖受限网关 | 先用故障 fixture 证明目标环境确有需求。若实施只能写受控 staging、绑定同一 pin/nonce/manifest；认证失败、pin 不符、取消或磁盘错误不触发降级。不能把普通错误全变成 shell 写入 |
| 阶段/字节进度 | ZCode adapter 区分 upload/extract/verify/install，能解释连接耗时 | 本轮只保留测试计数和现有诊断；UI 下一轮再消费。scp `-q` 不提供可靠字节事实，不编百分比；传完不等于校验/激活成功 |
| 自带 Node 或免 Node helper | DSH [ssh-helper-runtime](../../deepseek-harness/packages/ssh/ssh-helper-runtime/README.md) 有完整归档、原生资源、校验及无 Node sshd 验收 | 属分发/体积/平台矩阵决策。PiDeck 目前有远端 Node 先决条件，尚不引入 SEA 或远端自动下载 |
| 常驻 daemon、断线任务继续跑 | ZCode R3 的完整产品能力 | 会改变远端进程寿命、会话归属与恢复语义，独立方案；不能用本轮“优化取消”顺便实现 |
| SSH 密码/AskPass、端口转发、WSL/Docker、手机中继 | 可扩展远程覆盖范围 | 不属于本轮已验证问题；与 UI/认证/产品路线一起排期 |
| DSH 多通道 TLS-PSK | 管理/输出独立流控，可用于特定传输设计 | PiDeck 已有独立 Agent/终端通路；这轮不换传输架构，不照抄 POSIX-only 客户端 |

## 6. 交给 DS 的执行约束与交付格式

- 建议单 owner 顺序执行 F1→F2→F3→F4，F5 随包收口；不要让多个 agent 同时写 `RemoteHostConnectionService`、launcher、bootstrap 合同或冻结 helper。
- 同一交付单元先增加能失败的行为测试再修复；已有测试不删、不降级、不改断言。F3 必须保留“切 root 重建 session 并再次 bootstrap”的断言，优化发生在 bootstrap 内部的实际上传。
- F3/F4 是明确契约增量，在用户授权实施范围内先同步合同与版本策略。若遇到现有测试合同冲突，先交代具体冲突和独立处理项，不以“优化”为由绕过检查。
- 每包 diff 只包含本任务文件。只改功能实现及必需合同/测试，不改 renderer 的视觉、布局、i18n 文案结构，不动轨迹面板并行工作。
- 保持：系统 SSH、严格 pin/route/revision 校验；root 内访问；用户主动断开不自动恢复；不自动重放 prompt/文件/Git 写；不复制凭据；远端真实 pi 仍是 Agent 唯一执行者。
- 每包完成写明：用户行为变化、参考机制、修改文件、验证结果、没验证的环境、回退方法。F1/F2 用原子代码回退；F3/F4 保留旧内容寻址 bundle，回退主机端版本时不能删除其它活跃客户端引用的版本。不要另做数据迁移或用户设置开关。
- 只有用户明确要求提交/推送时才执行 Git 写操作；本计划文件本身不构成提交授权。

可直接交给 DS：

> 阅读 `docs/remote-functional-optimization-plan.md` 与根规则，从 F0/F1 开始做 SSH 远程功能优化，随后做 F2；F3/F4 按文中合同评审步骤推进。保留现有 UI 和远端架构。每包保留已有测试并补行为回归，跑 typecheck 和定向测试，真实 SSH 验证使用授权隔离环境。没有真机证据就明确写未验证。不要顺手做 F6，不要提交并行文件。

## 7. 本次实际验证与复现

本轮在未改产品代码的基线上执行：

```sh
node --test tests/remoteControlClient.test.mjs tests/remoteBootstrapDeployment.test.mjs tests/remoteHostConnectionService.test.mjs
```

结果：**70 passed、0 failed、0 skipped**。这只证明这三个文件的当前回归通过，不证明本计划已实施或整条 SSH 产品链路通过。本轮没有跑 typecheck、构建、真实 SSH/Electron 或参考仓库测试；只新增 Markdown。文档检查：30 个相对链接均存在，代码围栏成对，无行尾空白；工作区仍有并行改动，本任务仅新增本文件且未暂存/提交。

另执行以下有界离线探针（20 秒超时，无网络、无文件写入），复现 F2 重复取消；输出为 `pending=257, cancelFrames=256, timers=257`，关闭后 pending/timers 均为 0。探针代码保留在此便于 DS 复现，不额外创建临时脚本：

```js
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./tests/helpers/loadTsCommonJs.mjs";
const { createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");
const frames = [], timers = new Set();
const client = createRemoteControlClient({
  hostId: "probe-host", send: line => frames.push(JSON.parse(line)), now: () => 0,
  scheduler: {
    setTimeout(fn) { const timer = { fn }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  },
});
client.openConnection();
const operations = [client.request("echo", {}).catch(error => error.code)];
const targetId = frames[0].id;
for (let i = 0; i < 256; i++) operations.push(client.cancel(targetId).catch(error => error.code));
assert.equal(client.pendingCount(), 257); // 当前缺陷的观测值，修复后的回归应断言有界合并。
console.log({ pending: client.pendingCount(), cancelFrames: frames.filter(f => f.method === "cancel").length, timers: timers.size });
client.closeConnection();
await Promise.all(operations);
assert.equal(client.pendingCount(), 0);
assert.equal(timers.size, 0);
```

## 7.1 本轮实施记录（F1–F4）

每包记录：用户可见变化、参考机制、修改文件、验证结果、未验证项、回退方法。证据均为**离线**：真实生产模块 + 注入的 transport/时钟/fixture，以及真实冻结入口子进程；不含真实 SSH 环境。

### F1 连接/部署取消贯通

- **用户可见**：连接或部署中途取消（显式断开、应用退出）立即结束等待，不再等 30 s ready / 300 s session / 120 s scp 预算；取消后不再上传、不再 finalize；迟到的旧 attempt 不会把主机标成在线，也不会拆掉接替它的新 attempt。
- **实现**：`RemoteHostConnectionService` 每次 connect 持有一个 `AbortController`（`HostEntry.attempt`）；`disconnect()` / `dispose()` 在**进入 host 锁之前** abort，`ensureHeld` 把 signal 传给 node 探测与 bootstrap，并在每个 await 后重验 signal 与 attempt generation（旧 generation 不得发布 held/manager）。`RemoteBootstrapSession` / `RemoteBootstrapDeployment` / `RemoteBootstrapTransfer` / `RemoteExtensionDeployment` 接受 `signal`，在 await 后与 spawn/上传/finalize 前检查；`awaitUploadExit` 在 abort 时只停止本次 scp。`SshClientRuntime.run` 增加可选 `{ signal }`，把 abort 映射为 `SSH_HOST_COMMAND_CANCELLED`（main 内部）。
- **稳住的行为**：finalize 的提交点语义未改——提交已发出而回执丢失只报 `BOOTSTRAP_FINALIZE_UNCONFIRMED`，不宣称回滚、不自动重放；取消统一沿用既有码（连接层 `SSH_HOST_DISCONNECTED`、部署层 `BOOTSTRAP_ABORTED`、退出 `REMOTE_CONNECTION_SERVICE_DISPOSED`），未新增公共码、未改状态名、未碰连接向导。
- **与参考实现的关系**：只借鉴 ZCode 当前 `TransportContext.signal` / attempt 内 abort / await 后重验 disposed 的生命周期做法；未引入 daemon、未改传输拓扑。
- **验证**：`tests/remoteBootstrapCancellation.test.mjs`（5：ready 阻塞中取消、上传中取消停止 scp 且无 finalize、提交后取消=未确认、入口前取消不 spawn、node 探测取消不再花钱后续候选）、`tests/remoteConnectionCancellation.test.mjs`（5：disconnect 立即取消 bootstrap、迟到完成不发布、A 主机取消不影响 B、dispose 立即取消、**读取路径的 bootstrap 同样可被 disconnect 取消**）。
- **补强（2026-11 收尾）**：需要 bootstrap 的**读取**（`establishProjectSession`）也会占用同一个 attempt 槽位，因此 `disconnect()`/`dispose()` 同样能取消它，而不是等完 probe/upload 预算；调用方自己的 `readOptions.signal` 仍映射为 `REQUEST_CANCELLED`。
- **回退**：按文件原子回退即可（无 schema、无数据迁移、无用户设置项）。

### F2 控制写侧背压与取消去重

- **F2a 取消合并**：`RemoteControlClient` 以目标 `requestId` 为键合并同时进行的取消，只发 **一条** cancel 帧并共享结果；只有普通请求可被取消（取消自身不可再取消，因此不会套娃），`openConnection`/`closeConnection` 清空该表。计划里的探针从 `pending=257, cancelFrames=256, timers=257` 变为 `pending=2, cancelFrames=1, timers=2`，关闭后归零。
- **F2b 发送字节预算**：`SshProcessLauncher` 增加内部待发队列与字节预算 `SSH_LAUNCHER_MAX_PENDING_STDIN_BYTES`（4 MiB，计入我们自己的队列 + `writableLength`）。`write()` 在同步写入越过预算时 fail-closed（`SSH_LAUNCHER_STDIN_BACKLOG`）；返回 promise 表示这一帧仍在等 `drain`；新增 `writeAwait()` 在预算边界等待 drain 而不是拒绝。`drain` 恢复、`error`/`close`/`stop` 都释放等待者，结束/停止后不再写。项目文件上传改为逐块 `await`（优先 `writeAwait`），`END` 仍是最后一行，SHA/字节数语义未变。
- **与参考实现的关系**：只借鉴 DSH `protocol.ts` 的 queuedBytes / writeTail / drain 结算思路；协议仍是 NDJSON，未迁移长度前缀、TLS-PSK 或 socket 拓扑。
- **验证**：`tests/remoteControlClientCancelBudget.test.mjs`（5：256 次重复取消合并、结算后重复取消不发帧、取消不可再取消、满载仍可取消、断开释放等待）、`tests/sshLauncherStdinBackpressure.test.mjs`（5：false 后停写并保持整帧顺序、同步越界 fail-closed、`writeAwait` 等 drain、停止释放排队帧与等待者、上传逐帧 await 且 END 最后）。
- **回退**：按文件原子回退；helper 侧无对应改动（取消语义未变）。

### F3 复用已安装 bundle

- **用户可见**：切项目 / 重连不再每次重传同一份 helper/runner；已安装目录与本地 manifest 逐文件一致时，bootstrap 只做一轮只读复验；不一致时明确失败，而不是被一次上传悄悄覆盖。
- **实现**：冻结 bootstrap 入口新增一轮 `finalize-verify` 声明与 `verified` / `verify-miss`（`reason: absent | conflict`）结果帧；`RemoteBootstrapTransfer` 用同一个 `runDeclarationRound` 驱动 commit 与 verify（终止帧绑定 `./<target>/<manifestSha>` 与文件数）；`deployPreparedBundle` 在上传前先 verify：`verified` → 不传输（`reused: true`）、`absent` → 既有 staging→scp→finalize、`conflict` → `BOOTSTRAP_ACTIVE_CONFLICT`（fail-closed）。`RemoteHelperContract` 增加对应帧类型，`docs/remote-development-plan.md` §4.2 追加了该握手增量。
- **刻意保留**：切 root 仍重建 session 并再次 bootstrap（既有断言未改，`tests/remoteHostConnectionService.test.mjs` 原样通过）；scp 仍是唯一上传路径；verify 由固定入口执行，不运行被验证的 bundle，也不读正文；Node 版本/pin/route/revision 门控一步不跳。
- **验证**：`tests/remoteBootstrapContract.test.mjs` 新增 4 个**真实冻结入口**用例（复用命中且不留 staging/lock、absent 后同一会话仍能上传提交、内容被改→conflict 且不改写、未声明多余文件→conflict）；`tests/remoteBootstrapReuse.test.mjs` 6 个 main 侧用例（verified 不启动传输、错误 active 拒绝、conflict 不上传、absent 继续上传、无回执=未确认、注入定时器超时）。
- **回退**：主机上多份内容寻址 bundle 可并存；回退客户端版本不需要删除其它活跃客户端引用的目录（维护清理逻辑未改）。

### F4 会话元数据批量读取

- **用户可见**：会话列表在高延迟链路上从「每个文件一次往返」变成「每 64 个文件一次」；列表形状、归属、排序不变。
- **实现**：helper 1.22.0 新增 `fs.statMany`（`{ paths: string[1..64] }`，逐条复用 `fs.stat` 的 root/非链接/路径判定，**任何一条不可用整批拒绝**，按请求顺序回显 `path`，进 hello capabilities，无新错误码）；`RemoteWorkspaceReader.statMany` 严格按位置/字段校验（空列表不发帧、非法列表不发帧）；`RemoteSessionScanner.collectEntries` 改为 ≤64 条/批（并发仍 ≤4），预算仍按逻辑条目计，候选选择/配置根解析/排序/catalog 归属/tombstone 全部留在扫描器。
- **刻意不做的**：不把会话发现/标题/项目归属搬进 helper；不提高 512 目录 / 2000 文件 / 1 MiB 预算；不为旧 helper 维护逐条 fallback（缺方法会得到 `METHOD_NOT_FOUND`，属明确不兼容，升级由既有的内容寻址部署在连接时完成）。
- **握手期的可诊断性**：`fs.statMany` 在握手上是**建议能力**（不进 `REQUIRED_HELPER_CAPABILITIES`，旧 helper 仍可 ready），但缺失时会记录 `SSH_HELPER_CAPABILITY_MISSING_FS_STAT_MANY` 诊断——于是「扫描报 METHOD_NOT_FOUND」在此之前就有一句可读的事实，而不是一个没有前因的失败（`tests/sshHelperCapabilityGate.test.mjs`）。
- **验证**：`tests/remoteHelperEntry.test.mjs` 新增 2 个**真实 helper** 用例（批量顺序与逐条结果完全一致；整批拒绝清单与 64 条上限边界）、`tests/remoteWorkspaceReader.test.mjs` 新增 5 个（单帧、空集不发帧、非法列表不发帧、位置/字段不符拒绝、helper 拒绝原样转述）、`tests/remoteSessionScanner.test.mjs` 新增 2 个（2000 文件 ≤32 次请求且每批 ≤64；短批与空集）。
- **回退**：按文件原子回退；旧 bundle 仍在主机上，回退客户端会部署回自己的内容寻址 bundle，不影响其他客户端。

### F0 基线（注入 100 ms RTT，离线）

固定一次远端往返 = 100 ms，用**实际工作量**（请求数、上线字节）做硬判据、墙钟作同条件对照：

```sh
node --test tests/remoteLatencyBaseline.test.mjs
```

| 场景 | 请求数（硬判据） | 墙钟（同条件，Windows 本机） |
| --- | --- | --- |
| 2000 个会话文件的元数据（现行为） | 34 = 1 配置探测 + 1 列目录 + **32** 批 `fs.statMany`（峰值并发 4） | 1051–1059 ms |
| 200 个会话文件，逐条 `fs.stat`（F4 之前的扫描循环） | 201 = 1 + 200 | 5341–5466 ms |
| 200 个会话文件，批量 `fs.statMany`（现行为） | 6 = 1 探测 + 1 + **4** 批 | 310–311 ms |
| bundle 首次安装（F3 cold） | 1 次 scp + 2 轮声明（verify + finalize），1728 字节上线 | — |
| bundle 复用命中（F3） | **0 次 scp**、0 字节、1 轮声明 | — |

- 两种口径的**结果逐字段一致**（id/size/mtime/mtime 顺序），测试同时对 200 文件夹具做了新旧路径的逐项比对。
- 2000 文件的旧行为没有实跑（2000/4×100 ms ≈ 50 s，不值得占用测试时长）：它由同一份 200 文件夹具逐条循环实测后，按「每文件一次往返、并发 4」外推；请求数一栏两种口径都是实测。
- 这些数字只证明「注入 100 ms 下的工作量与同条件耗时」，不代表任何真实网络；真机耗时与 RTT 仍属 §7.2 未验证项。

### 真机 F5（Windows 客户端 → Linux 6.8 主机，单次 42 s）

主机参数只从环境变量读（仓库里没有真实主机/指纹字面量）：

```sh
PIDECK_E2E_REMOTE_HOST=… PIDECK_E2E_REMOTE_USER=… PIDECK_E2E_REMOTE_FINGERPRINT=… PIDECK_E2E_REMOTE_PORT=22   npx playwright test e2e/remoteFunctionalAcceptance.spec.ts
```

| 场景 | 观察到的产品结果 | 独立证据 |
| --- | --- | --- |
| F1 冷部署中取消 → 立即重试 | 取消后主进程 connect 以 `SSH_HOST_DISCONNECTED` 结算，用时 **327 ms**（会话预算 300 s）；重试完成一次真实冷部署并 ready | 取消时远端已有 `.staging-*`（入口已持锁）；取消后 `bundles/` 无本版本 sha、staging 清空、`.deploy*.lock` 无残留、`node` 入口进程 0 |
| F3 断开 → 重连 | ready，用时 **5.77 s**；`bundles/` 集合前后完全相同（2 个），无 staging | 复用命中不新增内容寻址目录 ⇒ 没有第二次上传 |
| F4 会话整表扫描 | 1530 条（1500 夹具 + 30 真实会话）全部出现在结果里，用时 **13.3 s** | 与远端 `ls` 的夹具条数核对；逐条 fixture id 命中 |

- **驱动方式**：这份 spec 走产品自己的 preload IPC（`remoteHosts.add/connect/disconnect`、`remoteSessions.scan`），不点设置页——本机 `out/renderer` 是早于本轮 renderer 改动的构建产物（只重建了 main+preload），用点击驱动会把「界面版本」混进结论；设置页点击路径仍由既有两份 acceptance spec 负责。
- **已知测试合同冲突（与本轮无关，需独立处理）**：`e2e/remoteHostAcceptance.spec.ts` 与 `e2e/remoteSessionAcceptance.spec.ts` 的「加主机」步骤仍在等「确认主机指纹」弹框并点「指纹正确，信任」，而产品自 `74682ad72` 起改为「添加即验证 + 立即连接」（首次信任在主进程完成，不再弹框）。两份 spec 必然停在那一步；本轮不改它们（存量测试合同冲突单独开任务重写），真机证据由上面的新 spec 提供。
- 扫描的 13.3 s 里约 5.8 s 是**切 root 重建 helper 会话**的固定成本（与 F3 的 warm 数值同量级），与 F4 无关：F4 省掉的是「每文件一次 RTT」。消除这次固定成本属于 root/会话模型，超出本轮范围。
- 本轮真机没有覆盖：F2 的故障注入（满载 + 重复 cancel + 慢读）、打包产物（`npm run pack`）路径、macOS 客户端、A/B 项目交替与 Git/终端场景（被上面的旧 spec 冲突挡住）。

### 本轮改动文件

- main（16）：`RemoteHostConnectionService`、`RemoteBootstrapSession`、`RemoteBootstrapDeployment`、`RemoteBootstrapTransfer`、`RemoteBootstrapContract`、`RemoteExtensionDeployment`、`RemoteControlClient`、`SshProcessLauncher`、`SshClientRuntime`、`RemoteHostConnectionTypes`、`RemoteHelperContract`、`RemoteHelperEntry`、`RemoteWorkspaceReader`、`RemoteProjectFileUpload`、`SshConnectionAttempt`、`sessions/RemoteSessionScanner`。
- 测试：新增 `remoteBootstrapCancellation`、`remoteConnectionCancellation`、`remoteControlClientCancelBudget`、`sshLauncherStdinBackpressure`、`remoteBootstrapReuse`、`remoteLatencyBaseline` 六个文件（`sshHelperCapabilityGate` 追加一条建议能力用例）；既有文件的适配只有两类——fake transport 补上新增的协议步骤/方法，冻结摘要与 helper 版本 pin 随源改动同步（`remoteBootstrapContract`、`remoteBootstrapDeployment`、`remoteBootstrapSession`、`remoteHelperEntry`、`remoteConfigContract`、`remoteSessionRootIsolation`、`remoteSessionScanner`、`remoteSessionScanIsolation`、`remoteSessionRootResolution`、`remoteSessionRegistration`、`remoteSessionRecordRemoval`、`remoteHostIdTransportBoundary`）。没有删除测试、没有放宽断言。
- 文档：本文件、`docs/remote-development-plan.md`（§4.2 增量 + helper 1.22.0）。

### 验证结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（`tsc --noEmit` 无输出）。运行期间工作区有并行 agent 的 renderer/i18n 改动，它们落地后本项才变成全绿；本任务未触碰那些文件。 |
| `node --test <16 个定向文件>` | 279 tests / 276 pass / 0 fail / 3 skipped（跳过项是既有的平台跳过：POSIX 专用 bootstrap 集成）。 |
| `node --test --test-concurrency=4 <184 个 remote*/ssh* 测试文件>` | 1977 tests / 1703 pass / 0 fail / 274 skipped（跳过项全部为既有平台/环境跳过）。 |
| `npx playwright test e2e/remoteFunctionalAcceptance.spec.ts`（真机，见下） | **1 passed（42.4 s）**：F1 取消 327 ms / 重试冷部署、F3 复用 5.77 s 且 bundle 集合不变、F4 1530 条 13.3 s。 |
| `biome format`（本任务文件） | 无差异。 |

## 7.2 未验证 / 待真机确认

已在本轮真机验证（见 §7.1「真机 F5」）：部署中取消 → 立即重试、复用命中不重传、1500+ 条会话整表扫描、取消后进程/staging/锁的独立检查。仍未验证：

1. F5 中其余场景：A/B 项目交替与配置/会话根的 root 切换、文件/Git 写已执行但回执丢失、pi runtime 意外退出恢复、退出/断开后的终端进程——既有 `remoteHostAcceptance` / `remoteSessionAcceptance` 被 §7.1 记录的旧 pin 弹框步骤挡住，本轮未跑通。
2. 100 ms **注入** RTT 的离线前后对比已完成（§7.1「F0 基线」），但没有真实广域网的 RTT 与 2000 会话列表实测。
3. 打包产物（`npm run pack`）下的远端链路未跑；本轮真机用的是 `npm run build:main` 的未打包产物。
4. 慢 Writable 下的真实内存峰值未压测；只有字节预算与等待者释放（有界性）证明。
5. macOS 客户端仍未验证；本轮矩阵是 Windows 客户端 → Linux 主机。
6. 旧 helper（< 1.22.0）只在握手诊断层面覆盖（`SSH_HELPER_CAPABILITY_MISSING_FS_STAT_MANY`），没有真机旧版本对照。
7. **既有 acceptance spec 的合同漂移（分两批）**：
   - 已修（本轮）：加主机步骤对上当前产品——不再等已取消的「确认主机指纹」弹框，改为断言**落盘**的 `verifiedEndpoint.hostKeyFingerprints[0]`；`1dd8ceb7e` 起候选列表默认收起，先展开「从 SSH config 导入」；提交按钮改为「保存|添加并连接」；就绪后先关掉模态进度框再断言行状态。`remoteHostAcceptance` 已能跑到「登记远端项目」之后的步骤。
   - 未修（独立任务）：`59a1fb351`（远端项目空态复用本地输入页并锁定 pi）之后，中栏不再渲染「远端项目」标题与文件工具栏；两份 spec 里 `getByText("远端项目")` 及其后依赖「登记后直接看到文件页」的断言仍需随该轮 UI 更新（可能需要在登记后点「浏览远端文件」）。这段属于该 UI 改动的配套迁移，不能由本轮验收收尾顺手臆造。