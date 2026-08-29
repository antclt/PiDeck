/**
 * Provider 用量 inline 展示（学 cc-switch UsageFooter inline / TierBadge）：
 * - variant="row"：模型选择器分组行内的单行彩色数值（无图标无胶囊，查询中/失败不渲染）；
 * - variant="card"：设置模型卡片头部的右对齐块 = 相对更新时间 + 数值段 + 刷新小按钮
 *   （cc-switch 卡头 ml-auto inline 同款布局）。
 *
 * backend（"pi" | "dsh"）决定查询/缓存走哪条链路：
 * - pi：配置 ~/.pi/agent/usage-probes.json；
 * - dsh：配置 $DSH_HOME/usage-probes.json + DSH 凭据库；
 * 缓存 key 归一化为 `dsh:<provider>`，与 pi 侧同名 provider（如 deepseek）互不串缓存。
 *
 * 颜色规则与三处详情面板共用 providerUsageDisplay 的 tone：≥90% 红 / ≥70% 橙 /
 * 其余绿；余额不足 10% 橙、≤0 红。无数据一律返回 null——保持「查不到就不显示」。
 */
import { Clock, RefreshCw } from "lucide-react";
import type { UsageProbeBackend } from "../../../../shared/types/providerUsage";
import {
	useProviderUsageEntry,
	useProviderUsageRefresh,
} from "../../hooks/useProviderUsage";
import {
	formatUsageBadgeText,
	usagePercent,
	usageToneTextClass,
	relativeTimeParts,
} from "../../utils/providerUsageDisplay";
import { t } from "../../i18n";

/** 数值段：灰标签（剩/已用）+ 彩色粗体数字，或纯彩色百分比。 */
function UsageValue(props: { provider: string; backend?: UsageProbeBackend; className?: string }) {
	const { result } = useProviderUsageEntry(props.provider, props.backend);
	if (!result || !result.success) return null;
	const text = formatUsageBadgeText(result);
	if (!text) return null;
	const toneClass = usageToneTextClass(result);
	const percent = usagePercent(result);
	return (
		<span className={`flex-none whitespace-nowrap font-mono text-caption tabular-nums ${props.className ?? ""}`}>
			{percent == null && (
				<span className="text-text-tertiary">{t("config.usage.remainingShort")} </span>
			)}
			<span className={`font-semibold ${toneClass}`}>{text}</span>
		</span>
	);
}

export function ProviderUsageInline(props: {
	provider: string;
	/** row = 选择器分组行（极简单值）；card = 模型卡片头部（时间 + 数值 + 刷新）。 */
	variant: "row" | "card";
	backend?: UsageProbeBackend;
	className?: string;
}) {
	const entry = useProviderUsageEntry(props.provider, props.backend);
	const refresh = useProviderUsageRefresh();
	if (!props.provider) return null;
	const hasUsable =
		entry.result != null && entry.result.success && formatUsageBadgeText(entry.result) != null;
	if (!hasUsable) return null;
	const fetchedAt = entry.fetchedAt;

	if (props.variant === "row") {
		return <UsageValue provider={props.provider} backend={props.backend} className={props.className} />;
	}

	const time = fetchedAt != null ? relativeTimeParts(fetchedAt) : null;
	const loading = entry.status === "loading";
	return (
		<span
			className={`flex flex-none items-center gap-1.5 whitespace-nowrap ${props.className ?? ""}`}
			data-testid="provider-usage-inline"
			data-provider={props.provider}
		>
			{time && (
				<span className="inline-flex items-center gap-0.5 text-[10px] text-text-tertiary">
					<Clock size={10} aria-hidden="true" />
					{t(time.key, time.params)}
				</span>
			)}
			<UsageValue provider={props.provider} backend={props.backend} />
			<button
				type="button"
				data-testid="provider-usage-inline-refresh"
				title={t("config.usage.refresh")}
				aria-label={t("config.usage.refresh")}
				onClick={(event) => {
					event.stopPropagation();
					refresh(props.provider, props.backend);
				}}
				className="flex h-4 w-4 flex-none items-center justify-center rounded text-text-tertiary transition-colors hover:bg-muted/60 hover:text-foreground"
			>
				<RefreshCw size={10} className={loading ? "animate-spin" : undefined} />
			</button>
		</span>
	);
}

/**
 * 供应商卡片底部统一用量行（学 cc-switch：所有卡片同一位置、右对齐、行高一致）。
 *
 * 二态（保证对齐，行容器恒占位）：
 * - 有数据：时间 + 彩色数值 + 刷新（与 ProviderUsageInline 同源）；
 * - 其余（未开启/加载/失败/不支持）：空占位，不渲染任何文案——「查不到就不显示」。
 *   未开启不给「用量查询未开启 → 去配置」广告位（用户反馈：没开启的功能不该有引导条）；
 *   配置入口统一在卡片头部柱状图按钮，生效意图由用户主动发起。
 */
export function ProviderUsageFooter(props: {
	provider: string;
	backend?: UsageProbeBackend;
}) {
	const entry = useProviderUsageEntry(props.provider, props.backend);
	if (!props.provider) return null;
	const hasUsable =
		entry.result != null && entry.result.success && formatUsageBadgeText(entry.result) != null;
	if (!hasUsable) {
		// 空占位：保持行高，让所有卡片底部用量行水平对齐（cc-switch 卡片列表同款）。
		return <span className="inline-flex h-5 items-center" aria-hidden="true" />;
	}
	return <ProviderUsageInline provider={props.provider} variant="card" backend={props.backend} />;
}

/**
 * 供应商卡片底部统一用量行（cc-switch 版式：卡片右下角只放金额/百分比）。
 *
 * 模型页 / 认证页 / DSH 页共用：右对齐一行 = 用量显示（时间+数值+刷新）或空占位。
 * 未开启不显示引导（配置入口在卡片头部柱状图按钮）。
 * 「用量查询」柱状图按钮在各自卡片**头部图标组**（不占用量行，见各卡片实现）。
 * 行高固定（h-9）+ border-t 分隔，所有卡片水平对齐。
 */
export function ProviderUsageRow(props: {
	provider: string;
	/** 查询/缓存链路：pi（缺省）或 dsh（$DSH_HOME 配置 + DSH 凭据库）。 */
	backend?: UsageProbeBackend;
	className?: string;
}) {
	return (
		<div
			className={`flex h-9 items-center justify-end gap-1.5 border-t border-border/60 px-3.5 ${props.className ?? ""}`}
			data-testid="provider-usage-row"
			data-provider={props.provider}
		>
			<ProviderUsageFooter provider={props.provider} backend={props.backend} />
		</div>
	);
}
