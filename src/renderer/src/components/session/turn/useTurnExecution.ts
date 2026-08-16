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
 * 行为（2026-12 与用户确认的版本）：
 * - 手动开合（setStepsVisibleFromUser/toggleSteps）记 override，**永远最高优先**：
 *   流式上升沿、结束展开信号都不会覆盖手动状态；
 * - 初始状态：历史已完成且有最终回答的轮始终折叠；进行中/无最终回答的轮
 *   默认折叠，仅设置①（expandInterimDuringStream）开启时才默认展开；
 * - agentRunning 上升沿：仅「设置①开启且无手动 override」时展开（新一轮流式实时滚出）；
 * - agent 停转且有最终回答（本轮结束）：展开执行过程（工具调用/思考可见，2026-12
 *   兼容期要求「会话结束展开工具调用」，取代旧的 1.5s 自动收起）——仅最新轮、无 override；
 * - 新一轮信号（newTurnCollapseTick 变化）：设置②（collapsePrevRunsOnNewTurn）开启时
 *   非最新轮强制收起（含手动展开的，清 override）。
 */
export function useTurnExecution(opts: {
	agentRunning?: boolean;
	isComplete: boolean;
	/** 本轮是否存在最终回答：无最终回答的 run 不自动展开。 */
	hasFinalAnswer?: boolean;
	/** 是否时间线上最新一轮。非最新轮不自动展开。 */
	isLatestRun?: boolean;
	/** 设置①：流式对话时展开中间过程。默认关。 */
	expandInterimDuringStream?: boolean;
	/** 设置②：新一轮开始时收起上一轮。默认开。 */
	collapsePrevRunsOnNewTurn?: boolean;
	/** 新一轮开始信号（session 级单调递增）。变化时非最新轮被强制收起。 */
	newTurnCollapseTick?: number;
}): TurnExecutionState {
	const [stepsVisible, setStepsVisible] = useState(() => {
		// 历史已完成且有最终回答的轮：始终折叠（时间线只留最终回答）。
		if (opts.isComplete && !opts.agentRunning && opts.hasFinalAnswer) return false;
		// 进行中/无最终回答（中断）的轮：默认折叠；设置①开启时才默认展开。
		return Boolean(opts.expandInterimDuringStream);
	});
	const userOverrideRef = useRef(false);
	const wasRunningRef = useRef(Boolean(opts.agentRunning));

	// 仅在「开始跑」上升沿按设置①展开。若写成「只要 agentRunning 就展开」，
	// 流式中用户收起后会被 busy 抖动（tool/streaming 边沿）重新撑开。
	// 手动 override 最高优先：不清 override、不撑开手动折叠过的轮次。
	useEffect(() => {
		const running = Boolean(opts.agentRunning);
		if (running && !wasRunningRef.current && !userOverrideRef.current) {
			if (opts.expandInterimDuringStream) {
				setStepsVisible(true);
			}
		}
		wasRunningRef.current = running;
	}, [opts.agentRunning, opts.expandInterimDuringStream]);

	// 结束展开：以「agent 停转」为准（不用 run.endedAt>0，流式中也会有时间戳）。
	// 只在「运行中 → 停转」的边沿触发——历史会话挂载（从未 running）不展开，
	// 保持「历史轮始终折叠」的初始语义。手动 override 最高优先。
	useEffect(() => {
		const running = Boolean(opts.agentRunning);
		const justFinished = wasRunningRef.current && !running;
		wasRunningRef.current = running;
		if (!justFinished || userOverrideRef.current) return;
		if (!opts.hasFinalAnswer) return;
		if (opts.isLatestRun === false) return;
		// 本轮结束：展开执行过程（工具调用/思考/中间回答可见），供用户复盘；
		// 不回调滚动：对准最终回答会主动解锁跟底、点亮回底按钮，
		// 并把视口从最新位置拽回本轮回答开头（用户体感「发了新消息还停在上一条」）。
		setStepsVisible(true);
	}, [opts.agentRunning, opts.hasFinalAnswer, opts.isLatestRun]);

	// 新一轮信号：设置②开启时，非最新轮强制收起（含手动展开的——本轮已结束，
	// 用户展开它多半是在对照，新消息发出后收掉以节省渲染资源）。
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
