/**
 * 后端拒绝运行中模型切换时的 fallback 展示推导。
 *
 * 支持 live selection 的后端直接更新 runtime，不会设置 pending；只有 busy/error
 * 路径才会把选择保留到后续空闲时重试。
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
