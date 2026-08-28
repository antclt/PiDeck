/**
 * 用量探针专用解析器（结构特殊、声明式路径表达不了的响应，如 xAI billing / Codex usage）。
 *
 * 与 providerUsageProbe 的声明式 parse 不同：这些响应是 percent 桶、cent-wrapper、
 * 多端点链的混合结构，逐字段写路径配置会变成又长又脆的字符串地狱，故注册专用函数。
 * 新增此类 provider 时：在这里加解析函数 → 注册进 CUSTOM_RESOLVERS → 候选表
 * parse 写 { kind: "custom", resolver: "<名字>" }。
 */
import type { ProviderUsageCredits } from "../../shared/types/providerUsage";
import type { UsageProbeResponse } from "./providerUsageProbe";
import { getByPath, toNumber } from "./providerUsagePath";

/** 专用解析器表：kind:"custom" 的 resolver 名称 → 解析函数。 */
const CUSTOM_RESOLVERS: Record<
	"xai-billing" | "codex-usage",
	(body: unknown, raw: string) => UsageProbeResponse
> = {
	"xai-billing": parseXaiBilling,
	"codex-usage": parseCodexUsage,
};

/** 按 resolver 名解析（未注册的 resolver 返回 undefined，由调用方回退 raw）。 */
export function resolveCustomUsage(
	resolver: string | undefined,
	body: unknown,
	raw: string,
): UsageProbeResponse | undefined {
	if (!resolver) return undefined;
	const fn = CUSTOM_RESOLVERS[resolver as keyof typeof CUSTOM_RESOLVERS];
	return fn ? fn(body, raw) : undefined;
}

/** xAI 金额字段是 { val: cents } 包装：取 val 除 100 得主单位（元）。 */
function centWrapperToNumber(value: unknown): number | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const val = toNumber((value as Record<string, unknown>).val);
	return val === undefined ? undefined : val / 100;
}

/**
 * xAI consumer billing（/v1/billing?format=credits）解析：
 * config.creditUsagePercent 是套餐内额度占用百分比（0-100），否则回退 monthlyLimit/used
 * （cent wrapper）成美元桶；onDemandCap/onDemandUsed 是超出套餐的按需用量（美元）；
 * prepaidBalance 是预付余额（美元）。
 * 输出 credits.windows：套餐内额度 + 按需用量两条进度条（与智谱多窗口同版式）。
 */
function parseXaiBilling(body: unknown, raw: string): UsageProbeResponse {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { matched: false, raw };
	const config = getByPath(body, "config");
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		return { matched: false, raw };
	}
	const cfg = config as Record<string, unknown>;
	const windows: NonNullable<ProviderUsageCredits["windows"]> = [];
	// 套餐内额度：百分比优先；没有百分比时用月限额/已用（美元）。
	const percent = toNumber(cfg.creditUsagePercent);
	if (percent !== undefined && percent >= 0 && percent <= 100) {
		windows.push({ key: "included", used: percent, total: 100 });
	} else {
		const limit = centWrapperToNumber(cfg.monthlyLimit);
		const used = centWrapperToNumber(cfg.used);
		if (limit !== undefined || used !== undefined) {
			const total = limit ?? used ?? 0;
			windows.push({ key: "included", used: used ?? 0, total });
		}
	}
	// 按需用量（美元）：cap/used 至少有一个才展示。
	const onDemandCap = centWrapperToNumber(cfg.onDemandCap);
	const onDemandUsed = centWrapperToNumber(cfg.onDemandUsed);
	if (onDemandCap !== undefined || onDemandUsed !== undefined) {
		windows.push({ key: "onDemand", used: onDemandUsed ?? 0, total: onDemandCap ?? onDemandUsed ?? 0 });
	}
	if (windows.length === 0) return { matched: false, raw };
	return { matched: true, kind: "credits", credits: { windows } };
}

/**
 * OpenAI Codex（chatgpt.com/backend-api/wham/usage）解析：
 * rate_limit.primary/secondary_window 是 percent 桶（used_percent/limit_window_seconds/reset_at），
 * credits.balance 是剩余点数（has_credits 时），rate_limit_reset_credits.available_count 是兑换重置次数。
 * 输出 credits：主 remaining=credits 余额，windows=primary/secondary 两条 percent 进度条。
 */
function parseCodexUsage(body: unknown, raw: string): UsageProbeResponse {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { matched: false, raw };
	const windows: NonNullable<ProviderUsageCredits["windows"]> = [];
	for (const position of ["primary", "secondary"] as const) {
		const window = getByPath(body, `rate_limit.${position}_window`);
		if (!window || typeof window !== "object" || Array.isArray(window)) continue;
		const used = toNumber((window as Record<string, unknown>).used_percent);
		if (used === undefined) continue;
		windows.push({ key: position, used: Math.min(100, Math.max(0, used)), total: 100 });
	}
	const credits = getByPath(body, "credits");
	const creditsBalance =
		credits && typeof credits === "object" && !Array.isArray(credits)
			? toNumber((credits as Record<string, unknown>).balance)
			: undefined;
	const creditsUnlimited =
		credits && typeof credits === "object" && !Array.isArray(credits)
			? (credits as Record<string, unknown>).has_credits === true &&
			  (credits as Record<string, unknown>).unlimited === true
			: false;
	if (windows.length === 0 && creditsBalance === undefined) return { matched: false, raw };
	return {
		matched: true,
		kind: "credits",
		credits: {
			// has_credits=true 且 unlimited 时没有具体余额数值，只在 windows 里表达占用。
			...(creditsBalance !== undefined && !creditsUnlimited ? { remaining: creditsBalance } : {}),
			...(windows.length > 0 ? { windows } : {}),
		},
	};
}
