/**
 * 工具调用参数解析（跨进程共用纯函数）。
 *
 * 工具调用的 `args` 在 pi 侧可能是对象、JSON 字符串，或「JSON 字符串里再套一层 JSON
 * 字符串」（模型把参数序列化了两次）。main（会话文件修改汇总）与 renderer（时间线
 * chip / 工具行）必须同口径，否则同一处参数在两栏里解析结果不同、总有一边漏内容。
 *
 * 纯函数、无运行时依赖，可被 node 单测直接加载。
 */

/** unknown → 工具参数对象；非对象 / 非法 JSON 返回 undefined。 */
export function parseToolArgs(value: unknown): Record<string, unknown> | undefined {
	if (!value) return undefined;
	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		let parsed = JSON.parse(value) as unknown;
		if (typeof parsed === "string" && parsed.trim()) {
			try {
				parsed = JSON.parse(parsed);
			} catch {
				return undefined;
			}
		}
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}
