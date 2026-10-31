import { isLiveHostState } from "../../../../../shared/projectCapabilities";
import type { RemoteHostConnectionPhase, RemoteHostConnectionState, RemoteHostDiagnosticEntry } from "../../../../../shared/types/remoteHost";

/**
 * 连接进度屏的纯推导层（照 ZCode `RemoteConnectionConnectingStep` 的阶段轨思路）。
 *
 * 输入只有两样：主进程推送的**主机状态**与脱敏**诊断历史**（阶段 + 状态 + 稳定码）。
 * 这里不读日志文本、不猜命令，也不把「还在连」显示成「已连上」。四个阶段是用户能理解的
 * 粒度；openssh/authenticate、platform/node 这些内部阶段只用于归并，不直接上屏。
 */

export type RemoteConnectionStepKey = "channel" | "environment" | "helper" | "agent";
export type RemoteConnectionStepStatus = "pending" | "active" | "complete" | "failed";
export type RemoteConnectionProgressPhase = "idle" | "running" | "ready" | "failed";

export type RemoteConnectionStepView = { key: RemoteConnectionStepKey; status: RemoteConnectionStepStatus };

export type RemoteConnectionProgress = {
	phase: RemoteConnectionProgressPhase;
	steps: RemoteConnectionStepView[];
	/** 失败时停住的那一步；非失败为 undefined。 */
	failedStep?: RemoteConnectionStepKey;
	/** 失败码：只接受主进程既有的稳定码形状。 */
	code: string | null;
};

export const REMOTE_CONNECTION_STEPS: readonly RemoteConnectionStepKey[] = ["channel", "environment", "helper", "agent"];

const STEP_BY_PHASE: Record<RemoteHostConnectionPhase, RemoteConnectionStepKey> = {
	openssh: "channel",
	authenticate: "channel",
	platform: "environment",
	node: "environment",
	helper: "helper",
	pi: "agent",
};

/** 状态本身给出的「至少到哪一步」：即使诊断历史被截断，也不会把已完成的阶段退回 pending。 */
const STEP_FLOOR_BY_STATE: Partial<Record<RemoteHostConnectionState, RemoteConnectionStepKey>> = {
	connecting: "channel",
	probing: "environment",
	bootstrapping: "helper",
	ready: "agent",
	degraded: "agent",
	reconnecting: "channel",
};

const RUNNING_STATES: readonly RemoteHostConnectionState[] = ["connecting", "probing", "bootstrapping", "reconnecting"];
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function stepIndexOf(step: RemoteConnectionStepKey): number {
	return REMOTE_CONNECTION_STEPS.indexOf(step);
}

function readCode(value: unknown): string | null {
	return typeof value === "string" && STABLE_CODE.test(value) ? value : null;
}

/** 是否处于「正在连」：用于决定进度屏要不要继续轮询诊断。 */
export function isRemoteConnectionInFlight(state: RemoteHostConnectionState | undefined): boolean {
	return state !== undefined && RUNNING_STATES.includes(state);
}

/**
 * 把状态 + 诊断历史折叠成四步进度。
 *
 * - ready/degraded：全部完成（degraded 仍可读写，不显示成失败）；
 * - connecting/probing/bootstrapping/reconnecting：停在那一步，之前完成、之后 pending；
 * - needs-attention 或带失败码：失败在「最后到达的那一步」，前面的步骤保留完成态；
 * - disconnected 且没有失败码：idle（用户取消或还没开始），而不是假装失败。
 */
export function resolveRemoteConnectionProgress(input: { state: RemoteHostConnectionState | undefined; entries?: readonly RemoteHostDiagnosticEntry[]; errorCode?: string | null }): RemoteConnectionProgress {
	const state = input.state;
	const entries = input.entries ?? [];
	let furthest = -1;
	for (const entry of entries) {
		const step = STEP_BY_PHASE[entry.phase];
		if (step !== undefined) furthest = Math.max(furthest, stepIndexOf(step));
	}
	const floor = state === undefined ? undefined : STEP_FLOOR_BY_STATE[state];
	if (floor !== undefined) furthest = Math.max(furthest, stepIndexOf(floor));

	// 调用方给了错误码就以它为准：若是自由文本，宁可不显示码，也不拿上一条无关诊断顶替。
	const code = readCode(input.errorCode ?? entries.at(-1)?.code);
	const failed = input.errorCode !== undefined && input.errorCode !== null ? true : state === "needs-attention" || (state === "offline" && entries.length > 0);
	// 失败必须至少落到某一步：没拿到任何阶段证据时，用状态地板兜底到 channel，避免「全都 pending 但报失败」。
	const failedIndex = failed ? Math.max(furthest, 0) : -1;

	if (failed && failedIndex >= 0) {
		return {
			phase: "failed",
			steps: REMOTE_CONNECTION_STEPS.map((key, index) => ({ key, status: index < failedIndex ? "complete" : index === failedIndex ? "failed" : "pending" })),
			failedStep: REMOTE_CONNECTION_STEPS[failedIndex],
			code,
		};
	}

	if (state !== undefined && isLiveHostState(state)) {
		return { phase: "ready", steps: REMOTE_CONNECTION_STEPS.map((key) => ({ key, status: "complete" })), code: null };
	}

	if (state !== undefined && isRemoteConnectionInFlight(state)) {
		const activeIndex = Math.max(furthest, 0);
		return {
			phase: "running",
			steps: REMOTE_CONNECTION_STEPS.map((key, index) => ({ key, status: index < activeIndex ? "complete" : index === activeIndex ? "active" : "pending" })),
			code: null,
		};
	}

	return { phase: "idle", steps: REMOTE_CONNECTION_STEPS.map((key) => ({ key, status: "pending" })), code: null };
}
