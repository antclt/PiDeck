# 发布批次 test-shape 例外账本

> 状态：2026-10-30 正式发版前清点。`npm run check:test-shape` 的基线从 390 增至 407；
> 本文只记录本次新增的 19 个只读源码测试及其理由，**不改变**“新测试优先运行时断言”的规则。
> 后续批次应优先把它们迁移为运行时/组件测试，迁移后从基线移除。

## 为什么保留

这些文件验证的是**装配/结构契约**：JSX 区块是否存在、IPC/通道是否接线、常量/类名是否与
设计系统或安全边界一致。当前仓库没有可复用的 React DOM 测试宿主；为它们引入整套
renderer harness 会显著扩大发布批次，且无法比现有运行时/E2E 更可靠地证明行为。

## 清单与覆盖

| 文件 | 类型 | 现有行为证据 |
|---|---|---|
| `addHostDialogCredentials` | SSH 表单结构 | 真机 SSH 连接/诊断 E2E；`remoteHostIpc` 运行时测试 |
| `connectionsEmptyState` / `connectionsTabStatus` / `connectionsWslSection` | 连接页 UI 装配 | 连接页 E2E；`remoteHostIpc` / `wslHostIpc` 运行时测试 |
| `feishuAttachmentFiles` / `feishuMessageQueue` | 飞书 UI/队列接线 | `feishu*` 运行时测试（消息/附件/卡片链路） |
| `gitGraphCapabilityGating` | GitGraph 能力门控 | `gitGraphCapabilityGating` 同文件 + 本地 Git E2E；远端 Git G1–G5e 真机 |
| `remoteDirectoryBrowser` / `remoteGitHostComposition` / `remoteHostRemoveUi` | 远端面板/宿主组合 | T9 真机文件管理、远端 Git 10/10；`remoteGitHostComposition` 运行时覆盖 |
| `remoteProjectComposerEntry` / `remoteProjectNewSessionEntry` / `remoteSessionConnectionNotice` / `sessionRemoteHostBadge` | 远端入口/徽章 JSX | T9 真机会话/文件流程；`remoteProjectIpc` / `remoteSession*` 运行时测试 |
| `sidebarMoreActions` / `sidebarSearchProjectReveal` | 侧栏动作/定位 JSX | 侧栏运行时测试与 E2E |
| `wslPerSessionSpawn` / `wslProjectAddContract` / `wslRuntimeIdentity` | WSL 会话/登记/身份接线 | `wslHostIpc` / `wslProjectEnvironment` 运行时测试；WSL 定向 16 例 |

## 发版口径

- 这些测试**不是**发布门禁的“行为通过”证据；行为证据以运行时单测和真机 E2E 为准。
- 任何新增测试仍不得走此账本；只有确实无法运行时验证的结构契约才允许登记，并必须说明覆盖来源。
- 全量 `npm test` 当前 **14928 tests / 14643 pass / 0 fail**（含上述文件的源码断言）。
