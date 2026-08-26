/**
 * 生成进行中切换模型的「待生效」展示推导。
 *
 * pi 不支持运行中 set_model：本轮仍用旧模型，选择只写入会话记录。
 * 本轮结束后再套到 Agent。新加、不在启动快照里的模型不走这条路径（走重启确认）。
 */

export type ModelPendingRef = {
	provider: string;
	modelId: string;
	modelName?: string;
};

export type ModelPending = {
	from: ModelPendingRef;
	to: ModelPendingRef;
};

export function formatModelRef(ref: Pick<ModelPendingRef, "provider" | "modelId" | "modelName">): string {
	const name = ref.modelName || ref.modelId || "-";
	return ref.provider ? `${ref.provider}/${name}` : name;
}

export type ModelDisplayResult = {
	from?: ModelPendingRef;
	to?: ModelPendingRef;
	pending: boolean;
};

export function computeModelDisplay(
	current: ModelPendingRef | undefined,
	pending: ModelPending | undefined,
): ModelDisplayResult {
	if (pending) {
		return { from: pending.from, to: pending.to, pending: true };
	}
	return { from: current, pending: false };
}

export type ComposerLiveModelSource = {
	provider?: string;
	modelId?: string;
	modelName?: string;
};

/**
 * 底栏/选择器当前模型：只在 runtime 仍 live（starting/idle/running）时优先 state。
 * 已关闭/解绑残留的 state.model 不能盖住用户刚写入 catalog 的 record.model，
 * 否则「Agent 没启动时改模型」看起来像没改、发送后又跳回去。
 */
export function resolveComposerLiveModel(input: {
	state?: ComposerLiveModelSource;
	record?: { provider?: string; modelId?: string };
	fallback?: ComposerLiveModelSource;
	isLive: boolean;
}): ModelPendingRef {
	const liveState = input.isLive ? input.state : undefined;
	return {
		provider: liveState?.provider ?? input.record?.provider ?? input.fallback?.provider ?? "",
		modelId: liveState?.modelId ?? input.record?.modelId ?? input.fallback?.modelId ?? "",
		modelName: liveState?.modelName ?? input.record?.modelId ?? input.fallback?.modelName,
	};
}
