/**
 * Provider 用量自动查询策略（纯函数，无 React）。
 *
 * 抽出原因：打开模型选择器 / 配置页会对每个 provider 扇出 HTTP 用量探测，
 * 多个 provider 共用同一本地 OpenAI 兼容网关时会把网关打熔断。
 * 全局开关默认关闭自动查询；手动刷新永远放行。本模块可被 Node 单测直接加载。
 */
import type { ProviderUsageEntry } from "../atoms/provider-usage-atoms";

/** 默认自动查询间隔（分钟）：与主进程默认一致（学 cc-switch），0 = 关闭该 provider 的间隔轮询。 */
export const USAGE_PROBE_DEFAULT_INTERVAL_MINUTES = 5;

/** 自动查询触发来源：挂载卡片、轮询、模型选择器批量、用户点击刷新。 */
export type ProviderUsageAutoQueryReason = "mount" | "poll" | "batch" | "manual";

export type ShouldAutoFetchProviderUsageInput = {
	/** 全局开关（AppSettings.providerUsageAutoQueryEnabled）。手动刷新忽略此字段。 */
	autoQueryEnabled: boolean;
	reason: ProviderUsageAutoQueryReason;
	/** 当前缓存条目；从未查过时为 null。poll 不依赖此字段。 */
	entry: Pick<ProviderUsageEntry, "fetchedAt"> | null;
	intervalMinutes: number;
	now?: number;
};

/**
 * entry 是否需要（重）查：
 * - 从未完成过（fetchedAt=null）→ 需要（首查）；
 * - interval <= 0（该 provider 关闭间隔轮询）→ 不需要（只靠手动刷新）；
 * - 否则按 interval 分钟过期判定（默认 5 分钟）。
 */
export function providerUsageEntryStale(
	entry: Pick<ProviderUsageEntry, "fetchedAt"> | null,
	intervalMinutes: number = USAGE_PROBE_DEFAULT_INTERVAL_MINUTES,
	now: number = Date.now(),
): boolean {
	if (!entry || entry.fetchedAt == null) return true;
	if (intervalMinutes <= 0) return false;
	return now - entry.fetchedAt >= intervalMinutes * 60_000;
}

/**
 * 是否应发起一次用量 HTTP 查询。
 *
 * 业务规则：
 * - manual：用户主动刷新，永远发，不看全局开关、不看新鲜期。
 * - 全局开关关闭：mount / poll / batch 一律不发（这是防熔断的主闸）。
 * - poll：间隔 <= 0 不排下一次；否则由调用方按 interval 设 timer，到期即发。
 * - mount / batch：走新鲜期（从未查过或已过 interval 才发）。
 */
export function shouldAutoFetchProviderUsage(input: ShouldAutoFetchProviderUsageInput): boolean {
	if (input.reason === "manual") return true;
	if (!input.autoQueryEnabled) return false;
	if (input.reason === "poll") return input.intervalMinutes > 0;
	return providerUsageEntryStale(input.entry, input.intervalMinutes, input.now ?? Date.now());
}
