/**
 * Provider usage/balance 探测（纯函数，可单测）。
 *
 * 设计目标：可扩展——新增 provider 只在此处增补「候选端点 + 响应解析」，不发散到 UI/IPC。
 * 内置策略：
 *   - opencode-go（baseUrl 含 opencode.ai/zen）：GET /usage →
 *     { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
 *   - DeepSeek（baseUrl 含 api.deepseek.com）：GET /user/balance →
 *     { balance_infos: [{ currency, total_balance }] }（total_balance 可能是数字或字符串）
 *
 * 除内置候选外，ConfigManager 还会合并用户自定义探针（~/.pi/agent/usage-probes.json），
 * 两者共用同一套候选结构与解析器。
 */
import type { ProviderUsageKind, ProviderUsagePeriod } from "../../shared/types/providerUsage";

export type UsageProbeParse =
	/** 三档百分比（默认；不填 parse 即此形态）。 */
	| { kind: "periods" }
	/** 剩余额度：valuePath 必填，currencyPath 可选。 */
	| { kind: "balance"; valuePath: string; currencyPath?: string }
	/** 额度点数：三个路径至少给一个；remaining 缺省由 total-used 反推。 */
	| { kind: "credits"; totalPath?: string; usedPath?: string; remainingPath?: string };

export type UsageProbeCandidate = {
	/** 相对 baseUrl 的路径（如 "/usage"），探测时会先拼版本化 baseUrl。 */
	path: string;
	/** HTTP 方法；缺省 GET（绝大多数用量/余额端点是 GET）。 */
	method?: "GET" | "POST";
	/** POST 请求体（JSON 序列化）；GET 忽略。 */
	body?: unknown;
	/**
	 * 额外请求头；值里可用 {{apiKey}} 占位，发送前替换成真实 key。
	 * 未显式给出 Authorization 时，自动补 Bearer {apiKey}。
	 */
	headers?: Record<string, string>;
	/** 判定该 provider 适用此候选的条件：baseUrl 包含任一关键字（小写匹配）。 */
	baseUrlContains?: string[];
	/** 判定适用的 api 类型（normalizeApiType 归一化后；缺省任意）。 */
	apiTypes?: string[];
	/** 响应解析规格；缺省走 periods（opencode-go 兼容）。 */
	parse?: UsageProbeParse;
};

export type UsageProbeResponse = {
	/** 探测候选是否命中且解析成功。 */
	matched: boolean;
	/** 解析出的展示形态。 */
	kind?: ProviderUsageKind;
	/** kind=periods 的三档用量。 */
	periods?: Partial<Record<"rolling" | "weekly" | "monthly", ProviderUsagePeriod>>;
	/** kind=balance 的剩余额度。 */
	balance?: { value: number; currency?: string };
	/** kind=credits 的额度点数。 */
	credits?: { total?: number; used?: number; remaining?: number };
	/** 未命中或解析失败时保留的原始文本（脱敏后），供 UI 兜底展示。 */
	raw?: string;
};

/** 候选端点表：新增 provider 适配器时在此注册（用户探针会追加在之后）。 */
export const USAGE_PROBE_CANDIDATES: UsageProbeCandidate[] = [
	// opencode-go Zen：/v1/usage 直接给出三档占用百分比 + 重置时间。
	{
		path: "/usage",
		baseUrlContains: ["opencode.ai/zen"],
	},
	// DeepSeek：/user/balance 给出余额信息（total_balance 在部分部署里是字符串，解析器已兼容）。
	{
		path: "/user/balance",
		baseUrlContains: ["api.deepseek.com"],
		parse: {
			kind: "balance",
			valuePath: "balance_infos[0].total_balance",
			currencyPath: "balance_infos[0].currency",
		},
	},
];

/** 判断候选是否适用于给定 baseUrl / apiType。 */
export function candidateApplies(
	candidate: UsageProbeCandidate,
	baseUrl: string,
	apiType: string,
): boolean {
	if (candidate.baseUrlContains) {
		const lower = baseUrl.toLowerCase();
		const hit = candidate.baseUrlContains.some((needle) => lower.includes(needle));
		if (!hit) return false;
	}
	if (candidate.apiTypes && !candidate.apiTypes.includes(apiType)) return false;
	return true;
}

/** 候选适用 provider 的探测 URL 列表（含版本化 baseUrl 与原样 baseUrl 两条尝试路径）。 */
export function usageProbeUrls(
	candidate: UsageProbeCandidate,
	baseUrl: string,
	ensureVersionPath: (url: string) => string,
): string[] {
	const u = baseUrl.replace(/\/+$/, "");
	const versioned = ensureVersionPath(baseUrl);
	const primary = `${versioned.replace(/\/+$/, "")}${candidate.path}`;
	const bare = `${u}${candidate.path}`;
	const urls = [primary, bare];
	return [...new Set(urls)];
}

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

/** 组装请求头：无自定义 Authorization 时自动补 Bearer；headers 里的 {{apiKey}} 替换成真实 key。 */
export function buildProbeHeaders(
	candidateHeaders: Record<string, string> | undefined,
	apiKey: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	const entries = Object.entries(candidateHeaders ?? {});
	const hasAuth = entries.some(([key]) => key.toLowerCase() === "authorization");
	// 未显式提供鉴权头时按惯例补 Bearer；apiKey 为空则省略（无 key 会在上层快速失败）。
	if (!hasAuth && apiKey) out.Authorization = `Bearer ${apiKey}`;
	for (const [key, value] of entries) {
		if (typeof value !== "string") continue;
		out[key] = value.replace(/\{\{\s*apiKey\s*\}\}/gi, apiKey);
	}
	return out;
}

/** 解析 /usage 类响应体：三种形态都接受（宽松容错，解析不出则整体回退 raw）。 */
export function parseUsageResponseBody(
	body: unknown,
	raw: string,
	parse: UsageProbeParse = { kind: "periods" },
): UsageProbeResponse {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { matched: false, raw };
	}

	// 余额形态：valuePath 取数值，currencyPath 可选。
	if (parse.kind === "balance") {
		const value = toNumber(getByPath(body, parse.valuePath));
		if (value === undefined) return { matched: false, raw };
		const currency = getByPath(body, parse.currencyPath ?? "");
		return {
			matched: true,
			kind: "balance",
			balance: {
				value,
				...(typeof currency === "string" && currency.trim() !== "" ? { currency: currency.trim() } : {}),
			},
		};
	}

	// 额度点数形态：三个路径至少命中一个；remaining 由 total-used 反推。
	if (parse.kind === "credits") {
		const total = parse.totalPath ? toNumber(getByPath(body, parse.totalPath)) : undefined;
		const used = parse.usedPath ? toNumber(getByPath(body, parse.usedPath)) : undefined;
		const remaining = parse.remainingPath ? toNumber(getByPath(body, parse.remainingPath)) : undefined;
		if (total === undefined && used === undefined && remaining === undefined) {
			return { matched: false, raw };
		}
		return {
			matched: true,
			kind: "credits",
			credits: {
				...(total !== undefined ? { total } : {}),
				...(used !== undefined ? { used } : {}),
				...(remaining !== undefined
					? { remaining }
					: total !== undefined && used !== undefined
						? { remaining: total - used }
						: {}),
			},
		};
	}

	// periods（默认）：只关心 rolling/weekly/monthly 三个档位。
	const usage = (body as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
		return { matched: false, raw };
	}
	const source = usage as Record<string, unknown>;
	const periods: UsageProbeResponse["periods"] = {};
	let any = false;
	for (const key of ["rolling", "weekly", "monthly"] as const) {
		const entry = source[key];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const item = entry as Record<string, unknown>;
		const parsed: { percent?: number; resetsAt?: string; status?: string } = {};
		if (typeof item.percent === "number") { parsed.percent = item.percent; any = true; }
		if (typeof item.resetsAt === "string") { parsed.resetsAt = item.resetsAt; any = true; }
		if (typeof item.status === "string" && item.status.length > 0) { parsed.status = item.status; }
		if (Object.keys(parsed).length > 0) periods[key] = parsed;
	}
	if (!any) return { matched: false, raw };
	return { matched: true, kind: "periods", periods };
}
