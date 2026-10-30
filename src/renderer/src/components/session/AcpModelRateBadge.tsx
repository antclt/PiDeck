import type { AcpModelRate } from "../../../../shared/types/acp";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";

/**
 * magpie 模型倍率徽章：免费 / `0.69×`；有折扣时前面再放一个划掉的原价。
 * rate 由主进程从本机 magpie 缓存注解（ACP wire 没有价格字段），缺失就不渲染。
 */
export function AcpModelRateBadge(props: { rate?: AcpModelRate; className?: string }) {
	const { rate } = props;
	if (!rate) return null;
	if (rate.free) {
		return <span className={cn("shrink-0 rounded border border-border-subtle px-1 text-micro leading-4 text-muted-foreground", props.className)}>{t("acp.modelRateFree")}</span>;
	}
	return (
		<span className={cn("flex shrink-0 items-center gap-1 text-micro tabular-nums leading-4 text-muted-foreground", props.className)}>
			{rate.was !== undefined ? <span className="line-through opacity-60">{rate.was}×</span> : null}
			<span>{rate.rate}×</span>
		</span>
	);
}
