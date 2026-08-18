/**
 * 会话进行态指示器判定（pi / DSH 共用）。
 *
 * 业务规则：状态条必须跟「此刻屏幕上在发生什么」对齐，不能用粘滞的
 * runtime.isStreaming / 残留 liveThinkingId。优先级：
 * 1. 正在跑工具卡 → executing
 * 2. live 正文或思考仍在推流 → responding
 * 3. 发送预热 / runtime starting，且还没有字和工具 → starting
 * 4. 其余空窗（等首 token、工具与正文之间、压缩）→ waiting
 *
 * 边界：activating 刚结束、首字已到时优先 responding，避免「预热」盖住已出的字。
 */
export type RespondingKind = "starting" | "executing" | "responding" | "waiting";

export function deriveRespondingKind(input: {
	isStarting?: boolean;
	isExecutingTool?: boolean;
	liveTextStreaming?: boolean;
	liveThinkingStreaming?: boolean;
}): RespondingKind {
	if (input.isExecutingTool) return "executing";
	if (input.liveTextStreaming || input.liveThinkingStreaming) return "responding";
	if (input.isStarting) return "starting";
	return "waiting";
}
