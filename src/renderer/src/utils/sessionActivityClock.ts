import type { AgentRuntimeState } from "../../../shared/types";

/**
 * 侧栏「计时点」推进规则——相对时间（刚刚 / n分钟 / n小时 / n天 / n个月）的基准时刻。
 *
 * 为什么不能拿 catalog.updatedAt（会话文件 mtime）当基准：流式期间每写一条消息 mtime 就变，
 * 侧栏每 3s 轮询一次就把计时器重置成「刚刚」，读不出「这轮已经跑了多久」，也读不出
 * 「我上次说话 / 它上次答完是多久前」——计时器等于没有。
 *
 * 产品定义（用户要求）：一次计时点 = 「用户最后一条输入」或「上一轮 turn 结束」。
 * 两个边界都能从 runtime 快照的边沿认出来：
 * - 本轮开始：pi/ACP 有权威 `isTurnActive`（agent_start → true）；缺该字段的后端
 *   （DSH/生图等）退回 Agent 运行状态 starting/running——那也发生在用户刚发出输入之后。
 * - 本轮结束：`isTurnActive === false`（agent_end），或状态回落到 idle/error/closed。
 * 中间态（流式 token、工具调用、自动重试收尾、标题回写、catalog 刷新）一律不推进，
 * 否则还是会被无限重置。
 */
export type SessionTurnActivityState = Pick<AgentRuntimeState, "isTurnActive">;

/** 本轮是否正在进行：优先权威回合计边界，缺省退回 Agent 运行状态。 */
export function isSessionTurnRunning(state: SessionTurnActivityState | undefined, status: string | undefined): boolean {
	// 终态优先：进程已关闭/报错时即使残留 isTurnActive=true 也不再算「在跑」，
	// 否则停止按钮按下后计时器会停在上一个回合开始的时刻一直涨。
	if (status === "closed" || status === "error" || status === "detached") return false;
	if (typeof state?.isTurnActive === "boolean") return state.isTurnActive;
	return status === "running" || status === "starting";
}

/**
 * 发送 IPC 返回后，能否把 runtime status 补写成 running。
 *
 * ACP 的 `sessions.sendPrompt` 要等整个回合结束才返回（pi/DSH 都是派发即返回）：
 * 返回时 manager 已经推过 idle，再写 running 会把刚结束的回合重新标成运行中。
 * 紧接着预测 ghost 按 isTurnActive=false 出现，用户 Tab 采纳后发送却被判忙碌、
 * 排进 followUp 队列（输入框上方多一条「发送中」）。ACP 的 status 只由 runtime
 * 事件维护，发送结果不再补写。
 */
export function shouldMarkRuntimeRunningAfterSend(input: { accepted: boolean; backend?: string }): boolean {
	if (!input.accepted) return false;
	return input.backend !== "acp";
}

/**
 * 边沿判定：返回新的计时点时间戳，`undefined` = 保持既有计时点（不写 atom）。
 *
 * 只有「本轮开始 ⇄ 本轮结束」的跃变才是边界；首次观测到一个空闲会话不算边界
 * （否则应用启动时所有历史行都会被重置成「刚刚」）。
 */
export function nextSessionActivityAnchor(input: { previousRunning: boolean; running: boolean; now: number }): number | undefined {
	return input.previousRunning === input.running ? undefined : input.now;
}
