/**
 * Provider 用量展示纯函数（无 React）：三处（圆球面板 / 模型卡片 / 模型选择器行）
 * 共用的格式化、状态档位与相对时间。视觉规则学自 cc-switch UsageFooter/TierBadge：
 * - 百分比档位：≥90% 红、≥70% 橙、其余绿（utilizationColor 同款阈值）；
 * - 余额/剩余量：≤0 红、不足总额 10% 橙、其余绿；
 * - 查询失败/无可用数值 → null（三处统一「不渲染」，避免报错噪音）。
 */
import type { TranslationKey } from "../i18n";
import type { ProviderUsageResult } from "../../../shared/types/providerUsage";

/** 用量状态档位（cc-switch utilizationColor 语义）。 */
export type UsageTone = "ok" | "low" | "empty" | "neutral";

/** tone → 文字色（cc-switch text-green-600/orange-500/red-500 同款，含暗色变体）。 */
export const USAGE_TONE_TEXT_CLASS: Record<UsageTone, string> = {
	ok: "text-green-600 dark:text-green-400",
	low: "text-orange-500 dark:text-orange-400",
	empty: "text-red-500 dark:text-red-400",
	neutral: "text-text-tertiary",
};

/** tone → 进度条填充色（TierBar 同款：绿/橙/红）。 */
export const USAGE_TONE_BAR_CLASS: Record<UsageTone, string> = {
	ok: "bg-green-500",
	low: "bg-orange-500",
	empty: "bg-red-500",
	neutral: "bg-text-tertiary",
};

/** 币种代码 → 常用符号（未知代码原样展示，避免硬编码映射丢失币种）。 */
export function currencySymbol(code?: string): string {
	switch ((code ?? "").toUpperCase()) {
		case "CNY":
		case "RMB":
			return "¥";
		case "USD":
			return "$";
		case "EUR":
			return "€";
		case "GBP":
			return "£";
		default:
			return (code ?? "").trim();
	}
}

/** 金额/点数格式化：最多两位小数，整数不显示小数点。 */
export function formatAmount(n: number): string {
	const rounded = Math.round(n * 100) / 100;
	return String(rounded);
}

/** 有常用符号映射的币种代码（其余代码作为后缀展示，避免「XYZ3.5」这类粘连）。 */
const KNOWN_CURRENCY_CODES = new Set(["CNY", "RMB", "USD", "EUR", "GBP"]);

/** 余额展示：已知币种用「¥110」符号前缀，未知代码用「110 XYZ」后缀，无币种只用数字。 */
export function formatBalance(balance: { value: number; currency?: string }): string {
	const code = (balance.currency ?? "").trim();
	const amount = formatAmount(balance.value);
	if (code && KNOWN_CURRENCY_CODES.has(code.toUpperCase())) {
		return `${currencySymbol(code)}${amount}`;
	}
	if (code) return `${amount} ${code}`;
	return amount;
}

/**
 * 结果里可推导出的最高用量百分比（0-100，封顶）。
 * - periods：取 rolling/weekly/monthly 中已上报的最大值（任一窗口吃紧都要警示）；
 * - credits：优先 windows 逐窗算 used/total（total>0），否则主值 used/total（remaining 可反推 used）；
 * - balance：无上限概念，返回 null。
 */
export function usagePercent(result: ProviderUsageResult): number | null {
	if (!result.success) return null;
	if (result.kind === "periods" && result.periods) {
		const values = Object.values(result.periods)
			.map((period) => period?.percent)
			.filter((value): value is number => typeof value === "number");
		if (values.length === 0) return null;
		return Math.min(100, Math.max(...values));
	}
	if (result.kind === "credits" && result.credits) {
		const credits = result.credits;
		const fromWindow = (total?: number, used?: number): number | null => {
			if (total == null || used == null || total <= 0) return null;
			return Math.min(100, Math.round((used / total) * 100));
		};
		const usedOf = (total?: number, used?: number, remaining?: number): number | undefined =>
			used ?? (remaining != null && total != null ? total - remaining : undefined);
		const windowPercents = (credits.windows ?? [])
			.map((window) => fromWindow(window.total, usedOf(window.total, window.used, window.remaining)))
			.filter((value): value is number => value != null);
		if (windowPercents.length > 0) return Math.max(...windowPercents);
		const mainPercent = fromWindow(credits.total, usedOf(credits.total, credits.used, credits.remaining));
		if (mainPercent != null) return mainPercent;
		return null;
	}
	return null;
}

/**
 * 展示档位（cc-switch 语义）：
 * - 百分比可得 → ≥90 empty（红）/ ≥70 low（橙）/ 其余 ok（绿）；
 * - balance → 余额 ≤0 empty；credits 剩余 ≤0 empty、不足总额 10% low、其余 ok；
 * - 无任何可判定数值 → neutral（灰）。
 */
export function usageTone(result: ProviderUsageResult): UsageTone {
	const percent = usagePercent(result);
	if (percent != null) {
		if (percent >= 90) return "empty";
		if (percent >= 70) return "low";
		return "ok";
	}
	if (result.kind === "balance" && result.balance) {
		if (result.balance.value <= 0) return "empty";
		return "ok";
	}
	if (result.kind === "credits" && result.credits) {
		const credits = result.credits;
		const remaining = credits.remaining ?? (credits.total != null && credits.used != null ? credits.total - credits.used : undefined);
		if (remaining != null) {
			if (remaining <= 0) return "empty";
			if (credits.total != null && credits.total > 0 && remaining / credits.total < 0.1) return "low";
			return "ok";
		}
		// 只有已用量：无总额可判，中性灰。
		return "neutral";
	}
	return "neutral";
}

/** 档位对应的彩字类（含 dark 变体）。 */
export function usageToneTextClass(result: ProviderUsageResult): string {
	return USAGE_TONE_TEXT_CLASS[usageTone(result)];
}

/** 单个百分比 → 档位（TierBar/逐窗口行用；与 usageTone 同阈值）。 */
export function usageToneForPercent(percent: number | null): UsageTone {
	if (percent == null) return "neutral";
	if (percent >= 90) return "empty";
	if (percent >= 70) return "low";
	return "ok";
}

/**
 * 徽标主值文本：periods/credits-windows → 最高窗口百分比（如 "86%"）；
 * balance → 余额（如 "¥86.3"）；credits 主值 → 剩余优先、已用兜底（如 "120.5"）。
 * 返回 null 表示没有可展示的数值（调用方不渲染）。
 */
export function formatUsageBadgeText(result: ProviderUsageResult): string | null {
	if (!result.success) return null;
	if (result.kind === "periods") {
		const percent = usagePercent(result);
		return percent != null ? `${Math.round(percent)}%` : null;
	}
	if (result.kind === "balance" && result.balance) {
		return formatBalance(result.balance);
	}
	if (result.kind === "credits" && result.credits) {
		const credits = result.credits;
		if ((credits.windows?.length ?? 0) > 0) {
			const percent = usagePercent(result);
			return percent != null ? `${Math.round(percent)}%` : null;
		}
		if (credits.remaining != null) return formatAmount(credits.remaining);
		if (credits.total != null && credits.used != null) return formatAmount(credits.total - credits.used);
		if (credits.used != null) return formatAmount(credits.used);
		return null;
	}
	return null;
}

/**
 * 相对更新时间（cc-switch inline 的 Clock 行）：刚刚 / n 分钟前 / n 小时前 / n 天前。
 * 超过 30 天或时钟异常回退短日期（避免出现「9999 天前」这类荒谬值）。
 */
export function formatRelativeTime(
	timestamp: number,
	now: number = Date.now(),
): string {
	const elapsed = now - timestamp;
	if (!Number.isFinite(elapsed) || elapsed < 0) return "justNow";
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return "justNow";
	if (minutes < 60) return `minutes:${minutes}`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `hours:${hours}`;
	const days = Math.floor(hours / 24);
	if (days <= 30) return `days:${days}`;
	return "stale";
}

/** 相对时间 i18n key 集合（与 rendererCopy 中 config.usage.time* 一一对应）。 */
export type RelativeTimeKey =
	| "config.usage.timeJustNow"
	| "config.usage.timeMinutesAgo"
	| "config.usage.timeHoursAgo"
	| "config.usage.timeDaysAgo"
	| "config.usage.timeStale";

/**
 * 把 formatRelativeTime 的标记翻成 i18n key 与参数（组件层用 t() 渲染）。
 * 独立成纯函数便于单测与复用（详情面板 / inline 卡头共用）。
 */
export function relativeTimeParts(
	timestamp: number,
	now: number = Date.now(),
): { key: RelativeTimeKey; params?: Record<string, number> } {
	const mark = formatRelativeTime(timestamp, now);
	if (mark === "justNow") return { key: "config.usage.timeJustNow" };
	if (mark === "stale") return { key: "config.usage.timeStale" };
	const [unit, raw] = mark.split(":");
	const n = Number(raw);
	if (unit === "minutes") return { key: "config.usage.timeMinutesAgo", params: { n } };
	if (unit === "hours") return { key: "config.usage.timeHoursAgo", params: { n } };
	return { key: "config.usage.timeDaysAgo", params: { n } };
}
