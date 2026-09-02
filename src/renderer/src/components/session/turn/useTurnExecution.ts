import { useCallback, useEffect, useRef, useState } from "react";

export type TurnExecutionState = {
	/** 思考/工具/中间回答步骤是否可见（run 级唯一折叠开关）。 */
	stepsVisible: boolean;
	/** 用户意图：设为指定开合态（勿用「toggle + Radix onOpenChange」以免连点/回调把状态打反）。 */
	setStepsVisibleFromUser: (open: boolean) => void;
	toggleSteps: () => void;
};

/**
 * run 级执行过程折叠状态（一个开关控制全部思考/工具/中间回答步骤）。
 *
 * 行为：
 * - 非 live（只看历史/会话空闲）挂载时一律折叠：已完成轮只留最终回答；
 *   无最终回答的中断轮（stop/steer 打断）同样收起（旧实现把设置①误用于
 *   静止历史，导致只看历史时中断轮整段展开）；
 * - 手动开合永远最高优先：流式上升沿不会覆盖用户已折叠的状态；
 * - 流式上升沿：设置①（expandInterimDuringStream）开启且无手动 override 时展开；
 * - 新一轮信号：非最新轮强制收起（含手动展开的），节省渲染资源；
 * - 自动收起信号：最新轮结束且用户 1.5s 无操作后，timeline 发来 autoCollapseTick；
 *   若执行过程仍打开，则收起并回调 onAutoCollapsed，由 timeline 把本轮起始消息
 *   拉到视口中上方。这样「结束即展开」的旧行为被替换为「先复盘，再安静收起」。
 */
export function useTurnExecution(opts: {
	runId?: string;
	agentRunning?: boolean;
	isComplete: boolean;
	/** 本轮是否存在最终回答：决定自动收起行为——无最终回答的 run 不自动收起
	 * （中间回答是唯一输出，避免折叠后整轮只剩空壳），但新一轮信号仍会强制收起。 */
	hasFinalAnswer?: boolean;
	/** 是否时间线上最新一轮。非最新轮不自动展开/收起。 */
	isLatestRun?: boolean;
	/** 设置①：流式对话时展开中间过程。默认关。 */
	expandInterimDuringStream?: boolean;
	/** 设置②：新一轮开始时收起上一轮。默认开。 */
	collapsePrevRunsOnNewTurn?: boolean;
	/** 新一轮开始信号（session 级单调递增）。变化时非最新轮被强制收起。 */
	newTurnCollapseTick?: number;
	/** 最新轮结束后的自动收起信号（timeline 侧 1.5s idle 计时）。 */
	autoCollapseTick?: number;
	/** 自动收起真正发生后回调（timeline 据此做「拉到中上方」定位）。 */
	onAutoCollapsed?: () => void;
}): TurnExecutionState {
	const [stepsVisible, setStepsVisible] = useState(() => {
		// 非 live（agentRunning=false：只看历史/会话空闲）一律折叠。
		// 历史已完成、有最终回答的轮自然折叠；无最终回答的中断轮（stop/steer
		// 打断，中间回答是其唯一输出）也不例外——只读历史时默认收起，
		// 而不是把设置①（流式展开）误用于静止的历史轮次。
		if (!opts.agentRunning) return false;
		// 仅 live 流式轮遵循设置①：流式中展开中间过程，结束后由
		// 自动收起信号 / 新一轮信号收掉。
		return Boolean(opts.expandInterimDuringStream);
	});
	const userOverrideRef = useRef(false);
	const wasRunningRef = useRef(Boolean(opts.agentRunning));
	const stepsVisibleRef = useRef(stepsVisible);
	const lastAutoCollapseTickRef = useRef(0);
	const lastRunIdRef = useRef(opts.runId);

	useEffect(() => {
		stepsVisibleRef.current = stepsVisible;
	}, [stepsVisible]);

	useEffect(() => {
		if (lastRunIdRef.current === opts.runId) return;
		lastRunIdRef.current = opts.runId;
		lastAutoCollapseTickRef.current = 0;
	}, [opts.runId]);

	// 流式上升沿展开。只处理「开始跑」这一个边沿，busy 抖动不会把用户手动折叠的
	// 轮次重新撑开；下降沿不再自动展开（旧「结束展开」已由 1.5s 自动收起取代）。
	useEffect(() => {
		const running = Boolean(opts.agentRunning);
		if (
			running &&
			!wasRunningRef.current &&
			!userOverrideRef.current &&
			opts.expandInterimDuringStream
		) {
			setStepsVisible(true);
		}
		wasRunningRef.current = running;
	}, [opts.agentRunning, opts.expandInterimDuringStream]);

	// 新一轮信号：非最新轮强制收起（含手动展开的——本轮已结束，新消息发出后收掉）。
	useEffect(() => {
		if (!opts.collapsePrevRunsOnNewTurn) return;
		if (opts.isLatestRun === false && (opts.newTurnCollapseTick ?? 0) > 0) {
			userOverrideRef.current = false;
			setStepsVisible(false);
		}
	}, [
		opts.collapsePrevRunsOnNewTurn,
		opts.isLatestRun,
		opts.newTurnCollapseTick,
	]);

	// timeline 侧 1.5s idle 后发来的自动收起信号。仅最新轮、仍有最终回答且执行过程
	// 当前可见时收起；已经手动折叠/从未展开的轮次不回调，timeline 不会错误滚动。
	useEffect(() => {
		const tick = opts.autoCollapseTick ?? 0;
		if (tick <= 0 || tick === lastAutoCollapseTickRef.current) return;
		lastAutoCollapseTickRef.current = tick;
		if (opts.isLatestRun === false || !opts.hasFinalAnswer) return;
		if (!stepsVisibleRef.current) return;
		userOverrideRef.current = false;
		setStepsVisible(false);
		opts.onAutoCollapsed?.();
	}, [
		opts.autoCollapseTick,
		opts.hasFinalAnswer,
		opts.isLatestRun,
		opts.onAutoCollapsed,
	]);

	const setStepsVisibleFromUser = useCallback((open: boolean) => {
		userOverrideRef.current = true;
		setStepsVisible(open);
	}, []);

	const toggleSteps = useCallback(() => {
		userOverrideRef.current = true;
		setStepsVisible((prev) => !prev);
	}, []);

	return { stepsVisible, setStepsVisibleFromUser, toggleSteps };
}
