/**
 * ACP 工具预设:开箱即用的 Agent Client Protocol agent 启动形态。
 *
 * 命令与安装包名均来自各 CLI 官方文档核对(2026-10):
 * - Gemini CLI:`gemini --acp`(docs/cli/acp-mode.md);npm `@google/gemini-cli`
 * - Claude Agent:`npx -y @agentclientprotocol/claude-agent-acp`(ACP 官方 adapter,复用 Claude Code CLI,npx 按需下载)
 * - Codex CLI:`npx -y @agentclientprotocol/codex-acp`(ACP 官方 adapter,复用 Codex App Server,npx 按需下载)
 * - Kimi CLI:`kimi acp`(moonshotai/kimi-code);npm `@moonshot-ai/kimi-code`(需 Node 22.19+,终端 `kimi` 里 /login)
 * - Qwen Code:`qwen --acp`(QwenLM/qwen-code);npm `@qwen-code/qwen-code`
 * - OpenCode:`opencode acp`(opencode.ai/v2/docs/cli/acp);npm `opencode-ai`(需先 `opencode auth login`)
 * - Cursor Agent:`agent acp`(cursor.com/docs/cli/acp);官方安装走 curl 脚本(不进 npm),标记 manual
 * - CodeBuddy:`npx -y @tencent-ai/codebuddy-code --acp`(codebuddy.ai/docs/cli/acp;腾讯 Cloud 上沉淀的 codebuddy-code npm 包)
 * - GitHub Copilot CLI:`copilot --acp`(github.com/github/copilot-cli;npm `@github/copilot`,
 *   启动参数取自 ACP 官方注册表,`--acp` 打开 stdio ACP server)
 * - Kilo Code:`kilo acp`(github.com/Kilo-Org/kilocode;npm `@kilocode/cli`,registry 同款参数)
 * - Cline:`cline --acp`(github.com/cline/cline;npm `cline`,registry 同款参数)
 * - MiniMax:`npx -y @minimax-ai/code acp`(agent.minimax.io/docs/cli/integrations;region cn/global 自适配)
 * - MiMo Code:`mimo acp`(github.com/XiaomiMiMo/MiMo-Code 的 packages/cli/src/cli/cmd/acp.ts;
 *   OpenCode 派生的终端 CLI,npm `@mimo-ai/cli`,需先在终端 `mimo auth login` 登录小米账号)
 * - Qoder:`qodercli --acp`(docs.qoder.com/cli/acp;`--acp` 是全局 flag 而非 `acp` 子命令,
 *   官方推荐官网脚本安装,故标记 manual。命令名取 `qodercli`:官网安装脚本(2026-10 实测)解出
 *   的二进制就叫 `qodercli`,即所有安装形态都保证有它;`qoder` 是 V1.1.18 起新增的主命令别名,
 *   官方文档示例已改用 `qoder --acp`,但旧安装没有它)
 * - Qoder 两个预设默认带 `--permission-mode bypass_permissions`:Qoder 的 ACP 适配器把
 *   Bypass Permissions(yolo)列进 configOptions,却拒绝 `session/set_config_option`(实测
 *   1.1.80 回 -32603 unknown permission_mode: yolo),运行期根本切不进去;唯一可行路径是
 *   启动时用 CLI 自己的 flag 定档(官方文档 docs.qoder.com/zh/cli/permissions)。用户要的就是
 *   「加进来即 bypass」,否则每次都得手动改参数。
 * - Qoder CN:`qoderclicn --acp`(docs.qoder.cn/cli/acp;国内版是独立二进制/独立账号与
 *   `QODERCN_PERSONAL_ACCESS_TOKEN`,与全球版不互通。同上看重兼容性取安装脚本自带的
 *   `qoderclicn`,`qodercn` 是新增主命令别名)
 * - 不收录 Google Antigravity:官方 CLI(agy)无任何 ACP 支持的公开证据(2026-10 核对),不编造命令
 *
 * 预设只是「预填表单」:点击后进草稿行,用户仍可改命令/参数,保存走统一校验链
 * (validateTool + sanitizeAcpTools),不做任何绕过。npx/npm 形态在 Windows 上的
 * .cmd 垫片还原由 PiLocator.createInvocation 统一处理,预设无需关心平台。
 * install 元数据只被设置页的「检测/安装/卸载」消费:安装命令来自内置表而非用户输入,
 * IPC 层按 presetId 枚举收口,不接受任意命令串。
 */
export type AcpToolPresetId = "gemini" | "claude-agent" | "codex" | "kimi" | "qwen" | "opencode" | "cursor-agent" | "codebuddy" | "minimax" | "mimo" | "copilot" | "kilo" | "cline" | "qoder" | "qoder-cn";

/** 安装来源:npm 全局包(可经 PiDeck 一键安装/卸载)或手动(官网脚本,只检测与引导)。 */
export type AcpToolInstall = { kind: "npm"; package: string } | { kind: "manual" };

export interface AcpToolPreset {
	/** 稳定标识(也用作 i18n 描述 key 后缀)。 */
	id: AcpToolPresetId;
	/** 预填显示名。 */
	name: string;
	/** 启动命令。 */
	command: string;
	/** 启动参数(数组语义,与 AcpToolConfig.args 一致)。 */
	args: string[];
	/** 项目主页(设置页可跳转的文档链接)。 */
	homepage: string;
	/** 版本探测参数:追加到命令后取版本(空格拆分);缺省 ["--version"]。 */
	versionArgs?: string[];
	/** 安装来源;undefined = npx 按需下载,无需预装(检测只看 node/npm 可用性)。 */
	install?: AcpToolInstall;
}

export const ACP_TOOL_PRESETS: readonly AcpToolPreset[] = [
	{ id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"], homepage: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md", install: { kind: "npm", package: "@google/gemini-cli" } },
	{ id: "claude-agent", name: "Claude Agent", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"], homepage: "https://github.com/agentclientprotocol/claude-agent-acp" },
	{ id: "codex", name: "Codex CLI", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"], homepage: "https://github.com/agentclientprotocol/codex-acp" },
	{ id: "kimi", name: "Kimi CLI", command: "kimi", args: ["acp"], homepage: "https://github.com/moonshotai/kimi-code", install: { kind: "npm", package: "@moonshot-ai/kimi-code" } },
	{ id: "qwen", name: "Qwen Code", command: "qwen", args: ["--acp"], homepage: "https://github.com/QwenLM/qwen-code", install: { kind: "npm", package: "@qwen-code/qwen-code" } },
	{ id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"], homepage: "https://opencode.ai/docs/cli/acp", install: { kind: "npm", package: "opencode-ai" } },
	{ id: "cursor-agent", name: "Cursor Agent", command: "agent", args: ["acp"], homepage: "https://cursor.com/docs/cli/acp", install: { kind: "manual" } },
	{ id: "codebuddy", name: "CodeBuddy", command: "npx", args: ["-y", "@tencent-ai/codebuddy-code", "--acp"], homepage: "https://codebuddy.ai/docs/cli/acp" },
	{ id: "minimax", name: "MiniMax Code", command: "npx", args: ["-y", "@minimax-ai/code", "acp"], homepage: "https://agent.minimax.io/docs/cli/integrations" },
	{ id: "mimo", name: "MiMo Code", command: "mimo", args: ["acp"], homepage: "https://github.com/XiaomiMiMo/MiMo-Code", install: { kind: "npm", package: "@mimo-ai/cli" } },
	{ id: "copilot", name: "Copilot CLI", command: "copilot", args: ["--acp"], homepage: "https://github.com/github/copilot-cli", install: { kind: "npm", package: "@github/copilot" } },
	{ id: "kilo", name: "Kilo Code", command: "kilo", args: ["acp"], homepage: "https://github.com/Kilo-Org/kilocode", install: { kind: "npm", package: "@kilocode/cli" } },
	{ id: "cline", name: "Cline", command: "cline", args: ["--acp"], homepage: "https://github.com/cline/cline", install: { kind: "npm", package: "cline" } },
	{ id: "qoder", name: "Qoder CLI", command: "qodercli", args: ["--acp", "--permission-mode", "bypass_permissions"], homepage: "https://docs.qoder.com/cli/acp", install: { kind: "manual" } },
	{ id: "qoder-cn", name: "Qoder CLI CN", command: "qoderclicn", args: ["--acp", "--permission-mode", "bypass_permissions"], homepage: "https://docs.qoder.cn/cli/acp", install: { kind: "manual" } },
];
