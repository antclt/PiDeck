/**
 * 纯数据结构的深比较 / 深拷贝工具。
 *
 * 只处理 JSON 风格数据（原始值 / 数组 / 普通对象），不处理函数、Map、Date 等；
 * 用途是「草稿 vs 基准快照」的脏检测与快照克隆。改回原值后能自动摘掉脏标记，
 * 避免用「touched 集合」记录改动时产生的假脏（改过又改回仍被判定已修改）。
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** 深比较两个值结构是否相等（数组/对象逐项递归）。
 *  原始值用数值相等语义：0 与 -0 视为相等，NaN 与 NaN 视为相等（=== 对两者都不成立）。 */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) {
		return true;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i += 1) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const keysA = Object.keys(a);
		const keysB = Object.keys(b);
		if (keysA.length !== keysB.length) return false;
		for (const key of keysA) {
			if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
			if (!deepEqual(a[key], b[key])) return false;
		}
		return true;
	}
	return false;
}

/** 深拷贝（保留 undefined 字段，避免与深比较的键集合语义产生偏差）。 */
export function deepClone<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => deepClone(item)) as unknown as T;
	}
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			out[key] = deepClone(value[key]);
		}
		return out as T;
	}
	return value;
}
