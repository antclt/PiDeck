/**
 * 用量探针响应取值工具（纯函数，可单测）。
 *
 * 从 providerUsageProbe 拆出：custom 专用解析器（providerUsageCustom）与
 * 声明式解析器共用同一套宽松取值逻辑，独立成文件避免循环依赖
 * （probe ↔ custom 都要用 getByPath/toNumber）。
 */

/**
 * 按点号/下标路径从响应体取值（宽松容错）。
 * 支持 "data.balance"、"balance_infos[0].total_balance"、"a[0].b.c" 等混合写法；
 * 路径任意一段缺失/类型不符返回 undefined，不抛异常（响应形状不可信）。
 */
export function getByPath(obj: unknown, path: string): unknown {
	if (!path) return undefined;
	const segments = path
		.split(/[.[\]]/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
	let current: unknown = obj;
	for (const segment of segments) {
		if (current == null) return undefined;
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
			current = current[index];
		} else if (typeof current === "object") {
			current = (current as Record<string, unknown>)[segment];
		} else {
			return undefined;
		}
	}
	return current;
}

/** 数值收窄：接受 number 或可解析的数字字符串（网关余额字段常见字符串），其余返回 undefined。 */
export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}
