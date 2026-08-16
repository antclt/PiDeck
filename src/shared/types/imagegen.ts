import type { ImageContent } from "./session";

/**
 * 生图请求：复用 pi 已配置的模型供应商（models.json / auth.json），
 * 不额外维护生图配置——用户在模型页配好 baseUrl/apiKey 后即可用于生图。
 */
export type ImageGenRequest = {
	/** 供应商名（对应 models.json providers 的 key） */
	provider: string;
	/** 生图模型 id（用户在下拉里选中的模型） */
	model: string;
	/** 提示词 */
	prompt: string;
	/** 可选：所属会话 id。提供时生图结果会以 user+assistant 消息落盘到该会话的 pi 文件。 */
	sessionId?: string;
};

/**
 * 生图失败错误码（主进程只回结构化错误码，文案由渲染层 i18n 映射，避免跨层硬编码）。
 */
export type ImageGenErrorCode =
	/** 供应商缺少 baseUrl/apiKey（去模型页补配） */
	| "notConfigured"
	/** API Key 无效（401/403） */
	| "invalidKey"
	/** baseUrl 不对（404/405 等） */
	| "badBaseUrl"
	/** 网络不可达/代理问题 */
	| "network"
	/** 服务端返回其他错误（detail 携带状态码） */
	| "http"
	/** 响应里没有图片数据 */
	| "empty";

/** 生图结果：ok=true 时 image 为可直接进附件栏的 base64 图片 */
export type ImageGenResult =
	| { ok: true; image: ImageContent }
	| { ok: false; error: ImageGenErrorCode; detail?: string };

/**
 * 生图消息的渲染元数据（存在 ChatMessage.meta.imageGen）：
 * 生图结果以「消息」形式上屏，同一条 assistant 消息随生成进度在
 * generating（点阵动画）→ complete（图片清晰过渡）→ error 之间切换。
 */
export type ImageGenMeta = {
	status: "generating" | "complete" | "error";
	/** 触发生图的提示词（渲染层展示引用） */
	prompt: string;
	/** 失败时的详细错误文案（已 i18n），status=error 时展示 */
	errorDetail?: string;
};
