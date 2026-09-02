/**
 * Provider 用量 inline 展示（学 cc-switch UsageFooter inline / TierBadge）：
 * - variant="row"：模型选择器分组行内的单段彩色数值（取档位最严重的一段示警，
 *   查询中/失败不渲染）；
 * - variant="card"：设置模型卡片头部的右对齐块 = 相对更新时间 + 数值段 + 刷新小按钮
 *   （cc-switch 卡头 ml-auto inline 同款布局）；多档用量（5h/周/MCP、三档百分比）
 *   逐档全部展示——「已用 92%」带语义标签，用户不用猜百分比是已用还是剩余。
 *
 * backend（"pi" | "dsh"）决定查询/缓存走哪条链路：
 * - pi：配置 ~/.pi/agent/usage-probes.json；
 * - dsh：配置 $DSH_HOME/usage-probes.json + DSH 凭据库；
 * 缓存 key 归一化为 `dsh:<provider>`，与 pi 侧同名 provider（如 deepseek）互不串缓存。
 *
 * 颜色规则与三处详情面板共用 providerUsageDisplay 的 tone：≥90% 红 / ≥70% 橙 /
 * 其余绿；余额不足 10% 橙、≤0 红。无数据一律返回 null——保持「查不到就不显示」。
 */
import { Fragment, type ReactNode } from "react";
import { Clock, RefreshCw } from "lucide-react";
import type { ProviderUsageResult, UsageProbeBackend } from "../../../../shared/types/providerUsage";
import {
	useProviderUsageEntry,
	useProviderUsageRefresh,
} from "../../hooks/useProviderUsage";
import {
	usageBadgePrimarySegment,
	usageBadgeSegments,
	USAGE_TONE_TEXT_CLASS,
	relativeTimeParts,
	type UsageBadgeSegment,
} from "../../utils/providerUsageDisplay";
import { t } from "../../i18n";

/** 只有成功且能产出至少一段带标签数值的结果才属于卡片可见的用量状态。 */
function hasUsableUsage(result: ProviderUsageResult | null): boolean {
	return result != null && result.success && usageBadgeSegments(result, t) != null;
}

/** 一段用量的渲染：灰标签 + 彩色粗体数值（段间由调用方加分隔点）。 */
function UsageSegment(props: { segment: UsageBadgeSegment }) {
	const { segment } = props;
	return (
		<span className="inline-flex items-baseline gap-0.5 whitespace-nowrap">
			<span className="text-text-tertiary">
				{segment.labelKey != null ? t(segment.labelKey) : segment.labelText}
			</span>
			<span className={`font-mono font-semibold tabular-nums ${USAGE_TONE_TEXT_CLASS[segment.tone]}`}>
				{segment.text}
			</span>
		</span>
	);
}

/** 数值段：卡片 = 全部档位（·分隔）；选择器行 = 最严重的一段。 */
function UsageValue(props: { provider: string; backend?: UsageProbeBackend; variant: "row" | "card"; className?: string }) {
	const { result } = useProviderUsageEntry(props.provider, props.backend);
	if (!result || !result.success) return null;
	const segments = usageBadgeSegments(result, t);
	if (!segments || segments.length === 0) return null;
	const shown = props.variant === "row"
		? [usageBadgePrimarySegment(result, t)].filter((segment): segment is UsageBadgeSegment => segment != null)
		: segments;
	return (
		<span className={`flex-none whitespace-nowrap font-mono text-caption tabular-nums ${props.className ?? ""}`}>
			{shown.map((segment, index) => (
				<Fragment key={`${segment.labelKey ?? segment.labelText ?? ""}:${index}`}>
					{index > 0 && <span className="px-1 text-text-tertiary">·</span>}
					<UsageSegment segment={segment} />
				</Fragment>
			))}
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
	const hasUsable = hasUsableUsage(entry.result);
	if (!hasUsable) return null;
	const fetchedAt = entry.fetchedAt;

	if (props.variant === "row") {
		return <UsageValue provider={props.provider} backend={props.backend} variant="row" className={props.className} />;
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
			<UsageValue provider={props.provider} backend={props.backend} variant="card" />
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
				<RefreshCw size={10} className={loading ? "animate-pideck-spin" : undefined} />
			</button>
		</span>
	);
}

/**
 * 供应商卡片底部统一用量行（学 cc-switch：所有卡片同一位置、右对齐、行高一致）。
 *
 * - 其余（未开启/加载/失败/不支持）：不渲染用量行——「查不到就不显示」。
 *   未开启不给「用量查询未开启 → 去配置」广告位（未开启的功能不应占位）；
 *   配置入口统一在卡片头部柱状图按钮，生效意图由用户主动发起。
 */
export function ProviderUsageFooter(props: {
	provider: string;
	backend?: UsageProbeBackend;
}) {
	const entry = useProviderUsageEntry(props.provider, props.backend);
	if (!props.provider || !hasUsableUsage(entry.result)) return null;
	return <ProviderUsageInline provider={props.provider} variant="card" backend={props.backend} />;
}

/**
 * 供应商卡片底部统一用量行（cc-switch 版式：卡片右下角只放金额/百分比）。
 *
 * 认证页 / DSH 页共用：成功且有可展示数值时才渲染右对齐一行 = 用量显示（时间+数值+刷新）。
 * Pi 模型页已把用量收进卡片标题行（ProviderUsageInline variant=card），不再走本底栏。
 * 没有成功配对结果时整个行容器也不渲染，避免卡片底部留下空白占位。
 * 未开启不显示引导（配置入口在卡片头部柱状图按钮）。
 * 「用量查询」柱状图按钮在各自卡片**头部图标组**（不占用量行，见各卡片实现）。
 * 行高固定（h-9）+ border-t 分隔，所有卡片水平对齐。
 *
 * leading：可选的左侧内容。提供后行始终渲染（左 leading、右用量有则显示）；
 * 不提供时维持「查不到就不渲染」的旧行为。
 */
export function ProviderUsageRow(props: {
	provider: string;
	/** 查询/缓存链路：pi（缺省）或 dsh（$DSH_HOME 配置 + DSH 凭据库）。 */
	backend?: UsageProbeBackend;
	className?: string;
	/** 左侧固定内容（如模型数量）；提供后行始终渲染。 */
	leading?: ReactNode;
}) {
	const entry = useProviderUsageEntry(props.provider, props.backend);
	if (!props.provider) return null;
	const hasUsable = hasUsableUsage(entry.result);
	// leading 提供时行必然渲染（模型数量常驻）；否则仅在有可用用量时渲染（旧行为）。
	if (!props.leading && !hasUsable) return null;
	return (
		<div
			className={`flex h-9 items-center justify-end gap-1.5 border-t border-border/60 px-3.5 ${props.className ?? ""}`}
			data-testid="provider-usage-row"
			data-provider={props.provider}
		>
			{props.leading ? (
				<span className="mr-auto min-w-0 truncate text-caption text-text-tertiary">{props.leading}</span>
			) : null}
			{hasUsable ? <ProviderUsageFooter provider={props.provider} backend={props.backend} /> : null}
		</div>
	);
}
