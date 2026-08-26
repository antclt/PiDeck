import type { ThinkingLevelMap } from "./modelSpecs";

/**
 * `/models` 拉取结果（Pi 配置页与 DSH 自定义模型共用）。
 *
 * 容量字段只在 listing 或 pi-ai 内置目录给出时出现；未命中则省略，
 * 由用户手填，不再写入 128k/8k 这类猜的默认值。
 * reasoning / input / thinkingLevelMap 可由端点 /models 实报，
 * 也可由 pi-ai 目录补全；两者都缺时由渲染层自适应模板兜底开放思考档位。
 */
export type FetchedModel = {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	/** 端点 /models 或 pi-ai 目录实报时出现；listing 通常不下发 */
	reasoning?: boolean;
	/** 端点 /models 或 catalog/capability 解析出现，Pi 的规范档位 → provider wire 值映射。 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** 端点 /models 或 pi-ai 目录补全时出现，如 ["text","image"] */
	input?: string[];
};

/**
 * 真实 pi 探测 provider/model 的结果（用 pi --mode json --print 做一次最小调用）。
 * 字段与旧 net.fetch 测试结果对齐，渲染层测试结果卡片可直接复用。
 */
export type PiModelProbeResult = {
	success: boolean;
	model?: string;
	snippet?: string;
	tokens?: { input?: number; output?: number };
	latencyMs?: number;
	error?: string;
};
