/** DSH 0.2 preset plane：只引入官方预设声明，不启动 dsh-web 的浏览器/HTTP 服务。 */
import { join } from "node:path";

/** 每个会话自己的工具由预设持有；host 只保留共享 registry/backends。 */
export const dshWebAgentPlaneDisabledIds = [
	"tool-plugin-manager",
	"tool-bash",
	"tool-pwsh",
	"tool-jobs",
	"tool-fs",
	"tool-fs-search",
	"skill-filesystem",
	"tool-skill",
	"command-goal",
	"tool-goal",
	"plan-mode",
	"compaction-basic",
	"command-compact",
	"tool-result-pruner",
	"tool-subagent-control",
	"tool-subagent-list-agents",
	"tool-subagent",
	"tool-subagent-fork",
	"workflow-ptc",
	"tool-workflow",
	"tool-ralph",
	"agent-instructions",
	"tool-todo",
	"tool-web",
] as const;

/** 与 dsh-web-app 的 agent-plane 禁用层逐项对齐。 */
export function dshWebAgentPlaneDisableRows(): Array<{ id: string; disabled: true }> {
	return dshWebAgentPlaneDisabledIds.map((id) => ({ id, disabled: true }));
}

/** 新版默认值保存为此行的 selectedDefault；default 是部署兜底。 */
export function agentPresetsRow() {
	return {
		id: "agent-preset-registry",
		name: "@deepseek-ai/dsh-agent-preset-registry",
		config: { default: "standard" },
	};
}

/** 只取 bundle 声明中的 presets 文件；不手写官方工具表、隔离组或 persona。 */
export function shippedPresetPatchPaths(webPackageDir: string, patchFiles: readonly string[]): string[] {
	const presets = patchFiles.filter((file) => /^\.\/presets\/[a-z0-9-]+\.patch\.yml$/.test(file));
	if (presets.length === 0) throw new Error("DSH web bundle declares no preset patches");
	return presets.map((file) => join(webPackageDir, file));
}

/** delegation 行需要 host 作用域的模型选择服务。 */
export function dshSubagentModelSelectionSettingsRow() {
	return { id: "subagent-model-selection-settings", name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings" };
}
