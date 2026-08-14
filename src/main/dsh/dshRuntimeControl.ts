/**
 * DSH 运行态控制：把「回合是否还在跑 / 停止后是否还吃迟到流」收成纯函数。
 *
 * 根因：渲染层 sendPrompt 接受后会把 runtime.status 钉成 running；
 * DSH tab.status 一直是 idle，也不会在 turn/end 回写 idle。
 * abort 只清 isStreaming，迟到的 assistant/chunk / turn/start 又能把流拉起来，
 * composer 的 isBusy = status===running || isStreaming 就停不下来。
 */

export type DshControlStatus = "idle" | "running";

export type DshControlState = {
	status: DshControlStatus;
	isStreaming: boolean;
	/** 每次用户 abort 递增；mux 帧必须带着当时的世代，否则当迟到流丢掉。 */
	cancelGeneration: number;
	cancelled: boolean;
};

export type DshControlEventKind =
	| "turn/start"
	| "turn/end"
	| "assistant/chunk"
	| "assistant/message"
	| "other";

export function classifyDshControlEvent(type: string | undefined): DshControlEventKind {
	if (type === "turn/start") return "turn/start";
	if (type === "turn/end") return "turn/end";
	if (type === "assistant/chunk") return "assistant/chunk";
	if (type === "assistant/message") return "assistant/message";
	return "other";
}

/** 用户点停止：抬世代、清流式，等 turn/end 再真正解除 cancelled。 */
export function beginDshCancel(prev: DshControlState): DshControlState {
	return {
		status: "idle",
		isStreaming: false,
		cancelGeneration: prev.cancelGeneration + 1,
		cancelled: true,
	};
}

/**
 * 一帧 mux 事件对控制态的影响。
 * `eventGeneration` 是泵在读到该帧时快照的 cancelGeneration。
 */
export function applyDshControlEvent(
	prev: DshControlState,
	type: string | undefined,
	eventGeneration: number,
): { next: DshControlState; ignoreStream: boolean } {
	// 停止之后才到的旧帧：禁止重新点亮 streaming/running；turn/end 仍用来收口 cancelled。
	if (eventGeneration !== prev.cancelGeneration) {
		const kind = classifyDshControlEvent(type);
		if (kind === "turn/end" && prev.cancelled) {
			return {
				next: {
					...prev,
					status: "idle",
					isStreaming: false,
					cancelled: false,
				},
				ignoreStream: true,
			};
		}
		return { next: prev, ignoreStream: true };
	}

	const kind = classifyDshControlEvent(type);
	if (kind === "turn/start") {
		return {
			next: {
				...prev,
				status: "running",
				isStreaming: true,
				cancelled: false,
			},
			ignoreStream: false,
		};
	}
	if (kind === "assistant/chunk") {
		if (prev.cancelled) {
			return { next: { ...prev, isStreaming: false, status: "idle" }, ignoreStream: true };
		}
		return {
			next: { ...prev, status: "running", isStreaming: true },
			ignoreStream: false,
		};
	}
	if (kind === "assistant/message" || kind === "turn/end") {
		return {
			next: {
				...prev,
				status: "idle",
				isStreaming: false,
				cancelled: false,
			},
			ignoreStream: false,
		};
	}
	return { next: prev, ignoreStream: false };
}
