/**
 * subagentStatus — pi-subagents 状态探测与展示映射纯函数。
 *
 * 供两处消费：
 * - ToolCallComponents：时间线工具卡从 Agent/get_subagent_result 结果文本
 *   探测失败终态（插件失败时返回普通文本结果，无 isError 标记）。
 * - SessionWidgetsCard：面板行图标种类与状态文案 key 映射。
 *
 * 全部纯函数，tests/sessionSubagentStatus.test.mjs 覆盖。
 */

/** 可被识别的失败类终态（与插件 AgentRecord.status 对齐）。 */
export type SubagentFailureStatus = "error" | "stopped" | "aborted";

/**
 * 从工具结果文本探测子代理终态。
 *
 * 插件 Agent/get_subagent_result 的输出头部固定包含
 * `Type: xxx | Status: <status> | ...`；运行中为 Status: running，
 * 正常完成为 Status: completed/steered——均不视为失败。
 * 返回 undefined = 未探测到失败。
 */
export function detectSubagentFailure(
	text: string,
): SubagentFailureStatus | undefined {
	if (!text) return undefined;
	const match = /Status:\s*(error|stopped|aborted)\b/i.exec(text);
	if (!match) return undefined;
	return match[1].toLowerCase() as SubagentFailureStatus;
}

/** 面板行图标种类：组件据此映射到具体 JSX。 */
export type SubagentIconKind =
	| "completed"
	| "active"
	| "error"
	| "stopped"
	| "aborted"
	| "steered"
	| "neutral";

/** 状态 → 图标种类。未知状态回退 neutral（空心圆）。 */
export function subagentIconKind(status: string): SubagentIconKind {
	switch (status) {
		case "completed": return "completed";
		case "running":
		case "queued": return "active";
		case "error": return "error";
		case "stopped": return "stopped";
		case "aborted": return "aborted";
		case "steered": return "steered";
		default: return "neutral";
	}
}

/** 状态 → i18n key 后缀（完整 key 为 `sessionSubagents.status.<suffix>`）。 */
export function subagentStatusLabelSuffix(
	status: string,
): "completed" | "running" | "queued" | "error" | "stopped" | "aborted" | "steered" | "unknown" {
	switch (status) {
		case "completed": return "completed";
		case "running": return "running";
		case "queued": return "queued";
		case "error": return "error";
		case "stopped": return "stopped";
		case "aborted": return "aborted";
		case "steered": return "steered";
		default: return "unknown";
	}
}

/** 终态判断：不再可能翻转为运行态。 */
export function isTerminalSubagentStatus(status: string): boolean {
	return (
		status === "completed" ||
		status === "error" ||
		status === "stopped" ||
		status === "aborted" ||
		status === "steered"
	);
}

/** 失败类终态（含 stopped/aborted），用于默认展开等展示决策。 */
export function isFailureSubagentStatus(status: string): boolean {
	return status === "error" || status === "stopped" || status === "aborted";
}
