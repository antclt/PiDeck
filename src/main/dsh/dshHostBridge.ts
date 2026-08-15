/**
 * DSH v2 传输桥协议（纯函数，可单测）。
 *
 * 形态（docs/dsh-agent-backend-plan.md §3.2 形态 b）：utilityProcess 承载 DSH host，
 * 主进程侧 `AbstractApiClient` 子类覆写 `doFetch`，把 fetch 请求/响应/SSE 流
 * 经 MessagePort（utilityProcess.postMessage / parentPort）桥接。
 *
 * 协议（所有消息带 `id` 关联一次 fetch 调用）：
 * - main → host：{ type: "fetch-request", id, method, path, headers?, body? }
 * - main → host：{ type: "fetch-abort", id }（外部 AbortSignal 触发）
 * - host → main：{ type: "fetch-response", id, status, headers?, body? }（unary 一次性）
 * - host → main：{ type: "fetch-stream-start", id, status, headers? }（SSE 流开始）
 * - host → main：{ type: "fetch-chunk", id, data }（流帧，文本）
 * - host → main：{ type: "fetch-end", id }（流结束）
 * - host → main：{ type: "fetch-error", id, message }（传输错误）
 *
 * body 一律字符串（JSON/SSE 文本）；字节载荷（图片附件等）一期不支持，
 * 由 attachment-local 行禁用兜底。
 */

export type DshFetchMessage =
	| { type: "fetch-request"; id: string; method: string; path: string; headers?: Record<string, string>; body?: string }
	| { type: "fetch-abort"; id: string }
	| { type: "fetch-response"; id: string; status: number; headers?: Record<string, string>; body?: string }
	| { type: "fetch-stream-start"; id: string; status: number; headers?: Record<string, string> }
	| { type: "fetch-chunk"; id: string; data: string }
	| { type: "fetch-end"; id: string }
	| { type: "fetch-error"; id: string; message: string };

/** 构造 fetch-request 消息（URL 拆成 path + query，headers 只保留字符串值）。
 *  E12：桥只承载 host 内部 ApiProxy 端点（http://dsh.internal）；外部 origin 是
 *  调用方误用，显式拒绝而不是静默重写成内部路径（host 侧重基会吞掉外部 URL）。 */
export function marshalFetchRequest(
	id: string,
	url: URL,
	init?: { method?: string; headers?: Record<string, string>; body?: string },
): DshFetchMessage {
	if (url.origin !== "http://dsh.internal") {
		throw new Error(`DSH bridge: unexpected origin "${url.origin}" (only http://dsh.internal is bridged)`);
	}
	return {
		type: "fetch-request",
		id,
		method: init?.method ?? "GET",
		path: `${url.pathname}${url.search}`,
		...(init?.headers && Object.keys(init.headers).length > 0
			? { headers: init.headers }
			: {}),
		...(init?.body !== undefined ? { body: init.body } : {}),
	};
}

/** 校验桥消息形状；未知/畸形消息返回 undefined（两侧都应静默跳过）。 */
export function parseDshFetchMessage(value: unknown): DshFetchMessage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const message = value as Record<string, unknown>;
	if (typeof message.type !== "string" || typeof message.id !== "string") return undefined;
	switch (message.type) {
		case "fetch-request": {
			if (typeof message.method !== "string" || typeof message.path !== "string") return undefined;
			return {
				type: "fetch-request",
				id: message.id,
				method: message.method,
				path: message.path,
				...(isStringRecord(message.headers) ? { headers: message.headers } : {}),
				...(typeof message.body === "string" ? { body: message.body } : {}),
			};
		}
		case "fetch-abort":
			return { type: "fetch-abort", id: message.id };
		case "fetch-response": {
			if (typeof message.status !== "number") return undefined;
			return {
				type: "fetch-response",
				id: message.id,
				status: message.status,
				...(isStringRecord(message.headers) ? { headers: message.headers } : {}),
				...(typeof message.body === "string" ? { body: message.body } : {}),
			};
		}
		case "fetch-stream-start": {
			if (typeof message.status !== "number") return undefined;
			return {
				type: "fetch-stream-start",
				id: message.id,
				status: message.status,
				...(isStringRecord(message.headers) ? { headers: message.headers } : {}),
			};
		}
		case "fetch-chunk":
			return typeof message.data === "string"
				? { type: "fetch-chunk", id: message.id, data: message.data }
				: undefined;
		case "fetch-end":
			return { type: "fetch-end", id: message.id };
		case "fetch-error":
			return typeof message.message === "string"
				? { type: "fetch-error", id: message.id, message: message.message }
				: undefined;
		default:
			return undefined;
	}
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.entries(value).every(([key, item]) => typeof key === "string" && typeof item === "string");
}
