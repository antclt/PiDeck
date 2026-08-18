/**
 * 单供应商 pi ↔ DSH 一键互迁按钮。
 *
 * 点按钮后直接迁当前行；目标已有同名供应商时先确认覆盖。
 * 密钥是否带过去由主进程结果 copiedKey 告知，页面不回显明文。
 */
import { useState } from "react";
import { ArrowLeftRight, LoaderCircle } from "lucide-react";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import type { ProviderMigrationDirection } from "../../../shared/types/providerMigration";

export function ProviderMigrationButton(props: {
	direction: ProviderMigrationDirection;
	provider: string;
	/** 迁完后刷新本页（pi 模型表 / DSH settings.describe）。 */
	onMigrated?: () => void;
	className?: string;
}) {
	const [busy, setBusy] = useState(false);
	const label = props.direction === "pi-to-dsh"
		? t("config.migrate.toDsh")
		: t("config.migrate.toPi");

	const run = async () => {
		if (busy || !props.provider.trim()) return;
		setBusy(true);
		try {
			const preview = await desktopApi.config.previewProviderMigration(props.direction);
			const row = preview.providers.find((item) => item.name === props.provider);
			if (row?.targetExists && !window.confirm(t("config.migrate.overwriteConfirm", { name: props.provider }))) {
				return;
			}
			const result = await desktopApi.config.applyProviderMigration(props.direction, props.provider);
			if (!result.ok) {
				showNotice(result.error || t("config.migrate.failed"), 5000);
				return;
			}
			showNotice(
				result.copiedKey ? t("config.migrate.okWithKey", { name: props.provider }) : t("config.migrate.okNoKey", { name: props.provider }),
				4000,
			);
			// 对端配置页可能已挂载但未重拉；广播后 DSH/Pi 模型页各自刷新。
			window.dispatchEvent(new CustomEvent("pideck:provider-migrated", { detail: { direction: props.direction, provider: props.provider } }));
			props.onMigrated?.();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : t("config.migrate.failed"), 5000);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			className={props.className ?? "size-7"}
			disabled={busy}
			title={label}
			aria-label={label}
			onClick={(event) => {
				event.stopPropagation();
				void run();
			}}
		>
			{busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <ArrowLeftRight className="size-3.5" aria-hidden="true" />}
		</Button>
	);
}
