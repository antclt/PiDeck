/**
 * Provider usage/balance 探测（纯函数，可单测）。
 *
 * 设计目标：可扩展——新增 provider 只在此处增补「候选端点 + 响应解析」，不发散到 UI/IPC。
 * 内置策略：
 *   - opencode-go（baseUrl 含 opencode.ai/zen）：GET /usage →
 *     { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
 *   - DeepSeek（baseUrl 含 api.deepseek.com）：GET /user/balance →
 *     { balance_infos: [{ currency, total_balance }] }（total_balance 可能是数字或字符串）
 *   - OpenRouter（baseUrl 含 openrouter.ai）：GET /credits →
 *     { data: { total_credits, total_usage } }（remaining 由 total-used 反推）
 *   - Moonshot / Kimi（baseUrl 含 api.moonshot.ai / api.moonshot.cn）：GET /users/me/balance →
 *     { data: { available_balance, voucher_balance, cash_balance } }（无 currency 字段，.ai=USD/.cn=CNY）
 *   - 通用 OpenAI 兼容网关（api 归一化为 openai-completions / openai-responses / openai-codex-responses）：
 *     GET /usage → { balance, unit }（OpenAI 官方 /usage 结构；不限定 baseUrl，兜底所有 OpenAI 协议站点）
 *
 * 除内置候选外，ConfigManager 还会合并用户自定义探针（~/.pi/agent/usage-probes.json），
 * 两者共用同一套候选结构与解析器。
 */
import type {
	ProviderUsageCredits,
	ProviderUsageKind,
	ProviderUsagePeriod,
} from "../../shared/types/providerUsage";

export type UsageProbeParse =
	/** 三档百分比（默认；不填 parse 即此形态）。 */
	| { kind: "periods" }
	/** 剩余额度：valuePath 必填，currencyPath 可选。 */
	| { kind: "balance"; valuePath: string; currencyPath?: string }
	/**
	 * 额度点数：三个路径至少给一个；remaining 缺省由 total-used 反推。
	 * windows 可选：同一响应里的并列限额窗口（如智谱 5h 窗 + 周窗），
	 * 逐条解析进 credits.windows；主 total/used/remaining 仍由三个 path 解析。
	 */
	| {
			kind: "credits";
			totalPath?: string;
			usedPath?: string;
			remainingPath?: string;
			windows?: {
				key: string;
				totalPath: string;
				usedPath: string;
				remainingPath?: string;
			}[];
	  };

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
	/**
	 * 端点挂在 host 根而非 baseUrl 路径下（如智谱监控 API /api/monitor/…，与
	 * OpenAI 兼容端点 /api/paas/v4 不在同一 base）：true 时只取 baseUrl 的 origin
	 * 拼接 path，跳过版本化补齐与路径段拼接。
	 */
	rootPath?: boolean;
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
	/** kind=credits 的额度点数（含可选的多窗口并列限额）。 */
	credits?: ProviderUsageCredits;
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
	// OpenRouter：/credits 给出总额度与已用额度（需 Management key）。
	// baseUrl 已含 /api/v1，path 相对其拼接；remaining 由 total-used 反推。
	{
		path: "/credits",
		baseUrlContains: ["openrouter.ai"],
		parse: {
			kind: "credits",
			totalPath: "data.total_credits",
			usedPath: "data.total_usage",
		},
	},
	// Moonshot / Kimi（国内 .cn 与国际 .ai 是同一个 balance 端点）：/users/me/balance
	// 返回 { data: { available_balance, voucher_balance, cash_balance } }，available_balance=现金+赠送券，
	// ≤0 不可调用推理 API；无 currency 字段（.ai 计 USD、.cn 计 CNY），故不标币种。
	{
		path: "/users/me/balance",
		baseUrlContains: ["api.moonshot.ai", "api.moonshot.cn"],
		parse: {
			kind: "balance",
			valuePath: "data.available_balance",
		},
	},
	// 智谱 GLM Coding Plan：监控 API 挂在 host 根（/api/monitor/…），与 OpenAI 兼容端点
	// /api/paas/v4 不在同一 base 下，故用 rootPath 只取 baseUrl 的 origin 拼接。
	// 认证要求裸 apiKey（Authorization 不加 Bearer 前缀）；取主 Token 额度窗口 limits[0]
	// （usage=总配额、currentValue=已用；percentage 只是百分比，不能当 used 参与计算）。
	// 放在通用 OpenAI 候选之前：命中 open.bigmodel.cn 时优先走本候选。
	{
		path: "/api/monitor/usage/quota/limit",
		rootPath: true,
		baseUrlContains: ["open.bigmodel.cn"],
		headers: { Authorization: "{{apiKey}}" },
		parse: {
			kind: "credits",
			totalPath: "data.limits[0].usage",
			usedPath: "data.limits[0].currentValue",
			// 双限额窗口并列展示：limits[0]=5h 滚动窗（unit:3,number:5）、limits[1]=周窗
			// （unit:6,number:1，自下单起 7 天周期重置）。任一耗尽都可能 429，两个都要给用户看到。
			windows: [
				{ key: "fiveHour", totalPath: "data.limits[0].usage", usedPath: "data.limits[0].currentValue" },
				{ key: "weekly", totalPath: "data.limits[1].usage", usedPath: "data.limits[1].currentValue" },
			],
		},
	},
	// 通用 OpenAI 兼容网关：多数 OpenAI 兼容中转站实现官方 /v1/usage 端点
	// （{ balance, unit } 结构）。不限定 baseUrl，仅靠 apiTypes 收窄到 OpenAI 协议，
	// 放在数组末尾——前面带 baseUrlContains 的专有候选优先命中，不会被此条抢走。
	{
		path: "/usage",
		apiTypes: ["openai-completions", "openai-responses", "openai-codex-responses"],
		parse: {
			kind: "balance",
			valuePath: "balance",
			currencyPath: "unit",
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
	// host 根端点（rootPath）：不拼 baseUrl 的路径段，只取 origin，避免把
	// /api/paas/v4 之类 OpenAI 兼容路径拼进不存在的地址。
	if (candidate.rootPath) {
		try {
			return [new URL(baseUrl).origin.replace(/\/+$/, "") + candidate.path];
		} catch {
			// baseUrl 非法：退回常规拼接，由请求层 404 兜底
		}
	}
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
		const remaining = parse.remainingPath
			? toNumber(getByPath(body, parse.remainingPath))
			: undefined;
		if (total === undefined && used === undefined && remaining === undefined) {
			return { matched: false, raw };
		}
		// windows（多窗口并列限额，如智谱 5h 窗+周窗）逐条解析：单窗缺值跳过，不拖垮整条。
		const windows: NonNullable<ProviderUsageCredits["windows"]> = [];
		for (const window of parse.windows ?? []) {
			const wTotal = toNumber(getByPath(body, window.totalPath));
			const wUsed = toNumber(getByPath(body, window.usedPath));
			const wRemaining = window.remainingPath
				? toNumber(getByPath(body, window.remainingPath))
				: wTotal !== undefined && wUsed !== undefined
					? wTotal - wUsed
					: undefined;
			if (wTotal === undefined && wUsed === undefined && wRemaining === undefined) continue;
			windows.push({
				key: window.key,
				...(wTotal !== undefined ? { total: wTotal } : {}),
				...(wUsed !== undefined ? { used: wUsed } : {}),
				...(wRemaining !== undefined ? { remaining: wRemaining } : {}),
			});
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
				...(windows.length > 0 ? { windows } : {}),
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
