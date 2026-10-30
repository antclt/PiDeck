# AI 协助（issue / PR 自动应答与评审）

> 落地文件：`.github/workflows/ai-assist.yml`（唯一入口，规则改动都在这里和本文）。
> 定位：**只评论，不写代码、不开 PR、不合并**。合并仍走 branch protection + auto-merge。

## 它能做什么

| 触发 | 行为 |
|---|---|
| issue / PR 评论（含 PR 行内评论）里 `@claude` | 读 AGENTS.md 与对应 docs，就问题本身作答（给结论 + 文件:行证据） |
| 新 PR（非 draft）或标记 ready for review | 自动评审，固定四段输出：结论 / 违反 AGENTS.md 的项 / 风险点 / 该跑的门禁命令 |

回答一律中文、先结论后依据、不写客套话——这些约束写在 workflow 的 `prompt` 里，
改口径要改 workflow，不要只改本文。

## 一次性配置（不做就一直跳过，不会失败）

1. Repository → Settings → Secrets and variables → Actions → **New repository secret**
   名称 `ANTHROPIC_API_KEY`，值填 Anthropic 官方或**兼容中转**的 key。
2. 若用中转站（Anthropic 兼容端点）：再加一个 **variable** `ANTHROPIC_BASE_URL`，
   值形如 `https://your-relay.example.com`（不带 `/v1`）。workflow 已把它透传为同名环境变量。
3. 用一个测试 issue 验证：新建 issue，正文写 `@claude 这个仓库发版流程是什么？`，
   20 秒内应在 issue 下出现 👀 反应，随后一条中文回答。

> 还没准备 key 也可以先合入 workflow：两个 job 的每个 step 都有 `ANTHROPIC_API_KEY == ''`
> 判据，缺 key 时只打一条 notice 就结束。

## 费用与关停

- 每次 @claude 一轮上限 `--max-turns 6`，PR 评审 `--max-turns 8`；同一 issue/PR 靠
  `concurrency` 串行，不会并发烧钱。
- **临时关停**：Settings → Actions → 左侧选 `AI Assist` → `Disable workflow`（不删文件）。
- **彻底移除**：删掉 secret 即可（workflow 还在但永远跳过），或直接删本文件与 yml。

## 安全边界（改 workflow 前必读）

1. **禁止 `pull_request_target`**。公开仓库上它会把写权限 token + secrets 交给 fork PR 的
   代码，等于把仓库交给陌生人。现在用 `pull_request`：同仓分支才有 secrets，
   fork PR 天然拿不到 → step 判据直接跳过，评审只对自家分支生效。
2. **issue 正文/评论是不可信输入**（prompt injection 的标准投递口）。当前配置的兜底是
   「只能评论」：token 权限只有 `issues: write` / `pull-requests: write` / `contents: read`，
   即使模型被诱导也 push 不了、改不了 workflow。
3. **谁都能 @ 但只认协作者**：`issue_comment` 在公开仓库对所有人开放，workflow 里按
   `author_association ∈ {OWNER, MEMBER, COLLABORATOR}` 过滤，外部用户 @claude 不触发。

## 换模型 / 换方案

- **Copilot 原生**（零 YAML）：Settings → Copilot → 开启 coding agent / code review，
  仓库无需 workflow；缺点是模型与成本不可控，且不读本仓库的「门禁」约定。
- **自建（用自家 magpie 或任意 OpenAI 兼容端点）**：GitHub 托管 runner 连不到本机服务，
  需要自托管 runner + 一个 `gh issue comment` 小脚本；收益是完全可换模型，
  代价是自维护 prompt 与限流。
- 现状取舍：先用官方 action 验证「噪音率」，再决定要不要上「issue → PR」那一层。
