/**
 * `/models` 拉取结果（Pi 配置页与 DSH 自定义模型共用）。
 *
 * 容量字段只在 listing 或 pi-ai 内置目录给出时出现；未命中则省略，
 * 由用户手填，不再写入 128k/8k 这类猜的默认值。
 */
export type FetchedModel = {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	/** 仅 pi-ai 目录补全时出现；listing 通常不下发 */
	reasoning?: boolean;
	/** 仅 pi-ai 目录补全时出现，如 ["text","image"] */
	input?: string[];
};
