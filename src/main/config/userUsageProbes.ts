/**
 * 用户自定义用量查询探针（声明式，纯数据，无代码）。
 *
 * 文件位置：~/.pi/agent/usage-probes.json（与 models.json 同目录，AI/用户可直接读写）。
 * 结构见 UserUsageProbeFile。加载时逐条校验，非法条目跳过并返回错误信息供主进程打日志，
 * 不抛异常——一份写坏的配置绝不能拖垮内置的 opencode-go / DeepSeek 探测。
 *
 * 为什么是声明式 JSON 而不是 pi 扩展脚本：
 * - 用量查询跑在 PiDeck 主进程（net.fetch + 密钥脱敏），pi 扩展跑在 pi 进程，喂不进圆环面板；
 * - 声明式只允许 method/path/headers/JSON 路径取值，不存在任意代码执行风险；
 * - JSON 文件与 pi CLI 完全隔离，不影响用户在终端里用 pi。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { UsageProbeCandidate, UsageProbeParse } from "./providerUsageProbe";

/** 用户探针文件的顶层结构。 */
export type UserUsageProbeFile = {
	/** 探针列表；缺省/空数组 = 没有自定义探针。 */
	probes?: UserUsageProbe[];
};

/** 单条用户探针（与 UsageProbeCandidate 对应，字段都是可序列化的纯数据）。 */
export type UserUsageProbe = {
	/** 展示名（仅日志/自述用，不影响匹配）。 */
	name?: string;
	match?: {
		/** baseUrl 包含任一关键字即适用（小写匹配，可写域名或任意路径片段）。 */
		baseUrlContains?: string[];
		/** 可选：限定 api 类型。 */
		apiTypes?: string[];
	};
	request?: {
		/** 相对 baseUrl 的路径，如 "/user/balance"。 */
		path?: string;
		/** 方法，缺省 GET。 */
		method?: "GET" | "POST";
		/** POST 请求体（GET 忽略）。 */
		body?: unknown;
		/** 额外请求头；可用 {{apiKey}} 占位。 */
		headers?: Record<string, string>;
	};
	parse?: UserUsageProbeParse;
};

export type UserUsageProbeParse =
	| { kind: "periods" }
	| { kind: "balance"; valuePath: string; currencyPath?: string }
	| { kind: "credits"; totalPath?: string; usedPath?: string; remainingPath?: string };

export type UserUsageProbeLoadResult = {
	/** 校验通过的探针（转成内部候选结构）。 */
	candidates: UsageProbeCandidate[];
	/** 校验失败条目的人话描述（供日志，不含 key）。 */
	errors: string[];
};

/** 文件名（放在 pi 全局配置目录下）。 */
export const USER_USAGE_PROBES_FILE = "usage-probes.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asStringArray = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
	}
	return out;
};

/** 校验并转换单条 parse 配置。返回 undefined 表示非法。 */
function normalizeParse(input: UserUsageProbeParse | undefined): UsageProbeParse | undefined {
	if (!input || !isRecord(input)) return { kind: "periods" };
	const kind = input.kind;
	if (kind === "periods") return { kind: "periods" };
	if (kind === "balance") {
		if (typeof input.valuePath !== "string" || input.valuePath.trim() === "") return undefined;
		return {
			kind: "balance",
			valuePath: input.valuePath.trim(),
			...(typeof input.currencyPath === "string" && input.currencyPath.trim() !== ""
				? { currencyPath: input.currencyPath.trim() }
				: {}),
		};
	}
	if (kind === "credits") {
		const totalPath = typeof input.totalPath === "string" ? input.totalPath.trim() : undefined;
		const usedPath = typeof input.usedPath === "string" ? input.usedPath.trim() : undefined;
		const remainingPath = typeof input.remainingPath === "string" ? input.remainingPath.trim() : undefined;
		if (!totalPath && !usedPath && !remainingPath) return undefined;
		return {
			kind: "credits",
			...(totalPath ? { totalPath } : {}),
			...(usedPath ? { usedPath } : {}),
			...(remainingPath ? { remainingPath } : {}),
		};
	}
	return undefined;
}

/** 校验并转换单条用户探针。返回 null 表示非法（调用方记录错误）。 */
function normalizeProbe(
	probe: unknown,
	index: number,
): { candidate: UsageProbeCandidate } | { error: string } {
	if (!isRecord(probe)) return { error: `第 ${index + 1} 条探针不是对象` };

	const match = isRecord(probe.match) ? probe.match : {};
	const baseUrlContains = asStringArray(match.baseUrlContains);
	if (!baseUrlContains || baseUrlContains.length === 0) {
		return { error: `第 ${index + 1} 条探针缺少 match.baseUrlContains（至少一个 baseUrl 关键字）` };
	}

	const request = isRecord(probe.request) ? probe.request : {};
	const path = typeof request.path === "string" ? request.path.trim() : "";
	if (!path || !path.startsWith("/")) {
		return { error: `第 ${index + 1} 条探针缺少 request.path（必须以 / 开头的路径）` };
	}
	const method = request.method === "POST" ? "POST" : "GET";
	// 手动构建 Record<string, string>：Object.fromEntries 无法把「已过滤为字符串」的类型收窄透出。
	let headers: Record<string, string> | undefined;
	if (isRecord(request.headers)) {
		headers = {};
		for (const [key, value] of Object.entries(request.headers)) {
			if (typeof value === "string") headers[key] = value;
		}
	}

	const parse = normalizeParse(probe.parse as UserUsageProbeParse | undefined);
	if (parse === undefined) {
		return { error: `第 ${index + 1} 条探针的 parse 配置非法（balance 需 valuePath；credits 至少一个路径）` };
	}

	return {
		candidate: {
			path,
			method,
			...(request.body !== undefined ? { body: request.body } : {}),
			...(headers ? { headers } : {}),
			baseUrlContains,
			...(match.apiTypes ? { apiTypes: asStringArray(match.apiTypes) } : {}),
			parse,
		},
	};
}

/**
 * 读取并校验用户探针文件。文件不存在/损坏/为空都安全返回空列表 + 对应错误。
 * 每次调用都重新读盘：用量查询本身低频（渲染层 60s 去抖），换取「用户/AI 改完立刻生效」，
 * 避免缓存过期导致用户改了配置却仍提示不支持。
 */
export async function loadUserUsageProbes(configDir: string): Promise<UserUsageProbeLoadResult> {
	const filePath = join(configDir, USER_USAGE_PROBES_FILE);
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch {
		// 文件不存在：没有自定义探针，静默返回。
		return { candidates: [], errors: [] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			candidates: [],
			errors: [`${USER_USAGE_PROBES_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`],
		};
	}

	if (!isRecord(parsed) || !Array.isArray(parsed.probes)) {
		return { candidates: [], errors: [`${USER_USAGE_PROBES_FILE} 缺少 probes 数组`] };
	}

	const candidates: UsageProbeCandidate[] = [];
	const errors: string[] = [];
	for (let index = 0; index < parsed.probes.length; index += 1) {
		const result = normalizeProbe(parsed.probes[index], index);
		if ("error" in result) {
			errors.push(result.error);
		} else {
			candidates.push(result.candidate);
		}
	}
	return { candidates, errors };
}
