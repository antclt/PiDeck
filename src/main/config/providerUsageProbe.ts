/**
 * Provider usage/balance 探测（纯函数，可单测）。
 *
 * 设计目标：可扩展——新增 provider 只在此处增补「候选端点 + 响应解析」，不发散到 UI/IPC。
 * 当前内置策略（OpenAI 兼容 / 网关类 provider，opencode-go 首个接入）：
 *   GET {版本化 baseUrl}/usage，带 Bearer 鉴权。
 * OpenAI /v1/usage 类端点无公开标准，各网关自定义；按 provider 特征匹配：
 *   - opencode-go（baseUrl 含 opencode.ai/zen）：/usage 返回
 *     { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
 */
export type UsageProbeCandidate = {
	/** 相对 baseUrl 的路径（如 "/usage"），探测时会先拼版本化 baseUrl。 */
	path: string;
	/** 判定该 provider 适用此候选的条件：baseUrl 包含任一关键字（小写匹配）。 */
	baseUrlContains?: string[];
	/** 判定适用的 api 类型（normalizeApiType 归一化后；缺省任意）。 */
	apiTypes?: string[];
};

export type UsageProbeResponse = {
	/** 探测候选是否命中且解析成功。 */
	matched: boolean;
	/** 解析出的三档用量（rolling/weekly/monthly）。 */
	periods?: Partial<Record<"rolling" | "weekly" | "monthly", { percent?: number; resetsAt?: string; status?: string }>>;
	/** 未命中或解析失败时保留的原始文本（脱敏后），供 UI 兜底展示。 */
	raw?: string;
};

/** 候选端点表：新增 provider 适配器时在此注册。 */
export const USAGE_PROBE_CANDIDATES: UsageProbeCandidate[] = [
	// opencode-go Zen：/v1/usage 直接给出三档占用百分比 + 重置时间。
	{
		path: "/usage",
		baseUrlContains: ["opencode.ai/zen"],
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

/** 解析 /usage 类响应体：三种形态都接受（宽松容错，解析不出则整体回退 raw）。 */
export function parseUsageResponseBody(
	body: unknown,
	raw: string,
): UsageProbeResponse {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { matched: false, raw };
	}
	const usage = (body as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
		return { matched: false, raw };
	}
	const src = usage as Record<string, unknown>;
	// 只关心三个档位；其余字段忽略（不同网关字段名千差万别，不做穷举）。
	const periods: UsageProbeResponse["periods"] = {};
	let any = false;
	for (const key of ["rolling", "weekly", "monthly"] as const) {
		const entry = src[key];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const e = entry as Record<string, unknown>;
		const parsed: { percent?: number; resetsAt?: string; status?: string } = {};
		if (typeof e.percent === "number") { parsed.percent = e.percent; any = true; }
		if (typeof e.resetsAt === "string") { parsed.resetsAt = e.resetsAt; any = true; }
		if (typeof e.status === "string" && e.status.length > 0) { parsed.status = e.status; }
		if (Object.keys(parsed).length > 0) periods[key] = parsed;
	}
	if (!any) return { matched: false, raw };
	return { matched: true, periods };
}