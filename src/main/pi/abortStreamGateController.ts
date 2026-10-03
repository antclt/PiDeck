import { createStreamGateState, isStreamGateSealed, noteAbortSettled, openStreamGateForNewRun, sealStreamGate, type StreamGateState } from "./streamGate";

/** abort 升级需要的最小 RPC 客户端形状（AgentManager 注入 runtime.process.client）。 */
export interface AbortGateRpcClient {
	request(payload: unknown, timeoutMs: number): Promise<unknown>;
}

/** 宿主注入：RPC 客户端获取、日志与用户可见 notice（AgentManager 适配）。 */
export interface AbortGateHost {
	getRpcClient(agentId: string): AbortGateRpcClient | undefined;
	logInfo(message: string, meta?: Record<string, unknown>): void;
	logWarn(message: string, meta?: Record<string, unknown>): void;
	emitAbortSlowNotice(agentId: string): void;
}

/**
 * abort 流闸与升级（从 AgentManager 迁出，行为零变化）。
 *
 * abort 封印当前 generation；须等 abort settled（或超时兜底）后，再由 agent_start
 * 推进 generation 放行，防止残留 thinking/text delta 串台。
 * `recentlyAborted`、thinkingEmitter/messageFlush 清理等跨域编排仍在 AgentManager。
 */
export class AbortStreamGateController {
	/** agent 的 stream gate 状态（封印/等待 settled/放行）。 */
	private readonly gates = new Map<string, StreamGateState>();
	/** abort 后等待 agent_settled 的超时定时器；避免 pi 漠发 settled 导致永久封印。 */
	private readonly settledFallbackTimers = new Map<string, NodeJS.Timeout>();
	/**
	 * 进行中的 abort 升级上下文。pi 的 abort RPC 语义是「中止并等 idle 才响应」，
	 * ack 迟到是正常路径；升级（补 abort_bash / 二次 abort）必须感知 ack 状态，
	 * 否则 WSL 慢链路下 1.5s 兜底会对正在收尾的 pi 补刀（老版本 pi 有崩溃史）。
	 */
	private readonly pendingEscalations = new Map<string, { hadActiveTool: boolean; acked: boolean; failed: boolean }>();
	/** abort settled 兜底超时：覆盖多数管道残留，同时不让“立刻重发”永久卡死。 */
	private static readonly ABORT_SETTLED_FALLBACK_MS = 1500;
	/** abort 升级验证窗口：abort_bash + 二次 abort 后仍 running 则提示用户。 */
	private static readonly ABORT_ESCALATION_VERIFY_MS = 4000;

	constructor(private readonly host: AbortGateHost) {}

	/** 取/建 agent 的 stream gate 状态。 */
	private getGate(agentId: string): StreamGateState {
		let gate = this.gates.get(agentId);
		if (!gate) {
			gate = createStreamGateState();
			this.gates.set(agentId, gate);
		}
		return gate;
	}

	/** abort 时封印当前 generation。 */
	seal(agentId: string): void {
		const next = sealStreamGate(this.getGate(agentId));
		this.gates.set(agentId, next);
	}

	/** agent_start 时尝试推进 generation；若仍在等 abort settled，则只记 pending。 */
	openForNewRun(agentId: string): void {
		const next = openStreamGateForNewRun(this.getGate(agentId));
		this.gates.set(agentId, next);
	}

	/** abort 后的 agent_settled：结束 waiting，必要时解封 pending start。 */
	noteAbortSettled(agentId: string): void {
		this.clearSettledFallback(agentId);
		const next = noteAbortSettled(this.getGate(agentId));
		this.gates.set(agentId, next);
	}

	/** 当前 generation 是否已封印，封印期间所有流式事件应丢弃。 */
	isSealed(agentId: string): boolean {
		return isStreamGateSealed(this.getGate(agentId));
	}

	/** settled 兜底定时器是否在等（agent_settled 判定用，见 AgentManager settled 分支）。 */
	hasSettledFallback(agentId: string): boolean {
		return this.settledFallbackTimers.has(agentId);
	}

	/**
	 * pi 偶发不发 agent_settled 时的兜底：超时后按 settled 处理，
	 * 避免用户立刻重发时新一轮永远无法接收流式事件。
	 * 同时触发 abort 升级检查：若 pi 仍未停稳，补发 abort_bash / 二次 abort。
	 */
	scheduleSettledFallback(agentId: string): void {
		this.clearSettledFallback(agentId);
		const timer = setTimeout(() => {
			this.settledFallbackTimers.delete(agentId);
			// 仅在仍 waiting 时生效；正常 settled 路径会先 clear 定时器。
			if (this.getGate(agentId).waitingForAbortSettled) {
				this.noteAbortSettled(agentId);
			}
			// 工具执行中 abort 偶发不被 pi 及时处理（长 bash/扩展工具阻塞），
			// 若不升级，agent 会继续跑到工具结束，用户看到“停止不了”。
			void this.escalateIfStillRunning(agentId);
		}, AbortStreamGateController.ABORT_SETTLED_FALLBACK_MS);
		timer.unref?.();
		this.settledFallbackTimers.set(agentId, timer);
	}

	/**
	 * abort 升级：兜底窗口已过但 pi 仍在流式/执行，按 ack 状态决定是否补命令。
	 * pi 的 abort RPC 语义是「中止当前操作并等到会话空闲才响应」（上游 rpc.md），
	 * 因此 ack 迟到是正常路径，不代表卡死；对正在收尾 abort 的 pi 补二次中止，
	 * 在老版本 pi 上有 unhandled rejection 直接杀进程的崩溃史（上游 #2716），
	 * WSL 慢链路下 1.5s 兜底几乎必误触发（Issue #218 WSL 终止必挂）。
	 *
	 * 策略：
	 * - bash 工具确实在执行 → 补 abort_bash（升级的本意：解卡被 bash 阻塞的 abort）；
	 * - abort RPC 已失败/超时（pi 可能没收到）→ 补二次 abort；
	 * - 其余（ack pending / acked 且无工具）→ 不补刀，等 pi 自然 settle。
	 * - 仍卡死则通过 notice 明确告知用户（stop 慢是可见问题，不能只写日志）
	 */
	private async escalateIfStillRunning(agentId: string): Promise<void> {
		const client = this.host.getRpcClient(agentId);
		if (!client) return;
		try {
			const response = (await client.request({ type: "get_state" }, 5_000).catch(() => undefined)) as { success?: boolean; data?: { isStreaming?: boolean } } | undefined;
			const isStreaming = response?.success && Boolean(response.data?.isStreaming);
			if (!isStreaming) return; // pi 已停，无需升级
			const escalation = this.pendingEscalations.get(agentId);
			const shouldSendAbortBash = escalation?.hadActiveTool === true;
			const shouldResendAbort = !escalation || escalation.failed;
			if (!shouldSendAbortBash && !shouldResendAbort) {
				// ack pending / acked 且无工具在跑：pi 正在按语义收敛到 idle，不补刀。
				this.host.logInfo("Abort escalation skipped: abort RPC ack pending/acked, waiting for idle", { agentId, acked: escalation?.acked === true });
				return;
			}
			this.host.logWarn("Abort escalation: pi still streaming after abort", { agentId, abortBash: shouldSendAbortBash, resendAbort: shouldResendAbort });
			if (shouldSendAbortBash) {
				await client.request({ type: "abort_bash" }, 5_000).catch(() => undefined);
			}
			if (shouldResendAbort) {
				await client.request({ type: "abort" }, 5_000).catch(() => undefined);
			}
			// 第二轮验证：仍未停则通知用户，提示可重启会话。
			const verifyTimer = setTimeout(() => {
				this.host.logWarn("Abort escalation: still running after second attempt", { agentId });
				this.host.emitAbortSlowNotice(agentId);
			}, AbortStreamGateController.ABORT_ESCALATION_VERIFY_MS);
			verifyTimer.unref?.();
		} catch {
			// RPC 失败（进程退出等）不再升级；agent 生命周期由 exit 路径接管。
		}
	}

	/** 记录 abort 升级上下文（abort RPC 发出时）：abort 时是否有工具在执行 + ack 状态。 */
	beginEscalation(agentId: string, hadActiveTool: boolean): void {
		this.pendingEscalations.set(agentId, { hadActiveTool, acked: false, failed: false });
	}

	/** abort RPC 成功 ack（迟到是正常路径，仅更新升级判据）。 */
	markAbortAcked(agentId: string): void {
		const escalation = this.pendingEscalations.get(agentId);
		if (escalation) escalation.acked = true;
	}

	/** abort RPC 失败/超时（升级时允许补二次 abort）。 */
	markAbortFailed(agentId: string): void {
		const escalation = this.pendingEscalations.get(agentId);
		if (escalation) escalation.failed = true;
	}

	/** agent_start：新 run 开始，升级上下文随之失效。 */
	clearEscalation(agentId: string): void {
		this.pendingEscalations.delete(agentId);
	}

	/** agent 关闭/重建时清理 gate/兜底定时器/升级上下文，避免泄漏到新生命周期。 */
	clearAgent(agentId: string): void {
		this.clearSettledFallback(agentId);
		this.gates.delete(agentId);
		this.pendingEscalations.delete(agentId);
	}

	/** 当前持有 gate 的 agent id 快照（stopAll 遍历清闸用）。 */
	gateAgentIds(): string[] {
		return [...this.gates.keys()];
	}

	private clearSettledFallback(agentId: string): void {
		const timer = this.settledFallbackTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.settledFallbackTimers.delete(agentId);
		}
	}
}
