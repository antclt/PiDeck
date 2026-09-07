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

/**
 * 引导页（无 record、未启动 Agent）的默认模型展示决策。
 *
 * 不变量：必须与主进程 `resolveLaunchDefaultOptions` 的来源次序一致
 * （点选 welcomeModel > 显式默认 > enabledModels > 上次使用），否则「底栏/选择器
 * 显示的默认」与「首次发送真实套用的默认」会分叉——用户表现为「页面切了但发送后
 * 变回去」。历史上展示层只建模了「显式默认」一级（defaultModelConfigured 为 true
 * 时直接屏蔽点选），而创建解析有四级来源，这就是「配了默认模型就切不动」的根因。
 *
 * 收拢为单一函数的原因：该规则曾在 ComposerPickerHost 与 ComposerComponents 各写
 * 一份（两份都带同一个闸门），任何一侧改动都容易漏改另一侧。
 *
 * DSH 不适用 pi 模型配置（模型路由由 host settings 决定），一律用解析结果。
 */
export function resolveGuideDisplayModel(input: {
	isDsh: boolean;
	/** 引导页点选（已经过 isWelcomeModelLost 校验，失效时为 undefined）。 */
	welcomeModel?: { provider: string; modelId: string };
	/** 主进程解析出的预选默认（显式默认 / 切换列表 / 上次使用的折叠结果）。 */
	defaultModel?: ComposerLiveModelSource;
}): ComposerLiveModelSource | undefined {
	if (input.isDsh) return input.defaultModel;
	return input.welcomeModel ?? input.defaultModel;
}
