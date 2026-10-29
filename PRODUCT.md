# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **单人开发者（主要）**：同时在本机多个项目目录里跑 pi 编码会话，需要在一个窗口里切项目、翻会话历史、看 Git 状态，而不是多开终端窗口。
- **Agent 重度玩家**：同时用多个后端（pi、DSH、ACP）、多模型、扩展/技能/提示词商店，愿意读文档、改配置、装插件。
- **小团队 / 工作室**：多人共用一套项目目录与配置规范，需要可追溯、可恢复、可导入的会话历史作为协作凭证。

## Product Purpose

把本地编码 Agent 装进桌面工作台。PiDeck 负责窗口、进程生命周期、项目与会话浏览、Git / 终端 / 设置；Agent 行为、工具调用、会话读写、模型调用交给后端。成功同时包含四件事：日常不再多开终端；成为 pi 生态默认的桌面端；让不熟 CLI 的人也能用上本地编码 Agent；扩展生态真的有人写、有人用。

## Positioning

不是 pi 的分支，也不复刻 pi。PiDeck 是轻量 Electron 外壳，通过 `pi --mode rpc` 启动多个 pi 进程，把多项目管理、会话界面、配置管理、工具编排整合成一个原生桌面应用；pi 的能力与会话文件仍由 pi 原生提供，PiDeck 不劫持、不改写。pi 是主路径，DSH（内置 host）与 ACP（外部 CLI）是完整支持，不是降级兜底。

## Operating Context

- 用户在本地已有多个代码仓库，Agent 直接在这些目录里工作。
- 会话来自 pi 原生 JSONL；同时可导入 Codex、Claude 的本地会话统一浏览与恢复。
- 桌面端长期同时管理：项目、会话时间线、文件抽屉、Git 面板、内置终端、内置浏览器。
- 用户会长时间停留在应用内（长会话、后台任务持续运行）。
- 发行渠道 GitHub + AtomGit，Windows / macOS / Linux 三平台安装包。

## Capabilities and Constraints

- 后端矩阵 `AgentBackend = pi | dsh | acp | imagegen | videogen`；pi 为主，DSH / ACP 为一等支持。
- 技术栈 Electron + React 19 + TypeScript + Vite。
- 三语：zh-CN、zh-TW、en；zh-TW 词典由 zh-CN 生成，不手改。
- 宿主边界固定：pi ↔ PiDeck 只经既有通道（认证、模型快照、standby 池、一次性补全、`/reload` 扩展、`pideck-cua` MCP），禁止扩成通用桥。
- 不直接改写 pi 正在使用的会话文件；编辑 / 删除走 `context_edit`，重发用 `deleted` 墓碑。
- 状态 experimental（0.9.x）。
- 未决：未确立无障碍标准；未确立品牌字体与图形规范（现有 `build/icon.*` 只是应用图标）。

## Brand Commitments

- 名称 PiDeck = pi desktop，对外定位就是「pi 的桌面端」，不另起品牌。
- 开源，MIT。
- 中文优先，但三语必须齐全且同步。
- 对外语气：直白、自嘲、带安利腔（见 README），后续沟通沿用。

## Evidence on Hand

- 真实截图：`docs/images/readme/hero.png`（工作台全景）、`docs/images/readme/setting.png`（设置页）。
- 版本与变更：`CHANGELOG.md` / `CHANGELOG.zh-CN.md`、`announcements.json`。
- 应用图标：`build/icon.svg|png|ico|icns`，另有 `build/icons/`、`build/pets/`。
- 星标历史图：`assets/star-history/`。
- 不存在且不得编造：用户评价、客户 logo、性能基准、定价页、部署案例。

## Product Principles

1. **真相源归后端**：pi 优先，DSH / ACP 各自原生；PiDeck 只做外壳，不复制 Agent 语义。
2. **本地优先**：项目路径、代码、消息、会话内容不出本机；遥测匿名、低频、可关。
3. **多项目是一等场景**：任何界面都要能同时服务 N 个项目，而不是围绕单个仓库设计。
4. **同一功能两个深度**：新手零配置可用，重度玩家能一路配到底，不为简化砍掉可配置项。
5. **会话可追溯**：历史必须可查、可恢复、可导入，且不因 PiDeck 的操作被破坏。
