/**
 * 模型规格匹配结果（context / 输出上限 / 推理 / 视觉）。
 *
 * 数据按模型 id 匹配，与中转站 baseUrl 无关。来源只有两级：
 * 1. listing：端点 `/models` 已返回容量
 * 2. pi-ai：安装的 `@earendil-works/pi-ai` 内置目录
 * 都没有则字段保持空，不再用 OpenRouter/models.dev sqlite 或保守默认值。
 */

export type ModelSpec = {
	/** 上下文窗口（token 数） */
	contextWindow?: number;
	/** 建议单次输出上限（token 数） */
	maxTokens?: number;
	/** 推理模型（仅当目录明确支持时置 true） */
	reasoning?: boolean;
	/** 支持图片输入 */
	images?: boolean;
	/** 命中来源 */
	source: "listing" | "pi-ai";
	/** 匹配到的规范模型 id */
	matchedId?: string;
};
