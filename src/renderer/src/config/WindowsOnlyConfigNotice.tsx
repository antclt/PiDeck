import { Info } from "lucide-react";
import { t } from "../i18n";

/**
 * P1-2 阶段标注：技能 / 提示词 / 扩展页尚未按 WSL 目标改造，只编辑 Windows（本机）配置。
 *
 * 为什么必须有这条提示：这三页的数据来自本机 home 下的目录扫描，选中 WSL 目标时它们不会跟着切。
 * 不标注会让用户以为「页面上看到的就是发行版里的技能/提示词/扩展」，进而以为改动生效——
 * 直接把 Windows 内容显示成 WSL 内容比不显示更危险。完整 WSL 作用域另立工作流。
 */
export function WindowsOnlyConfigNotice(props: { page: string; testId?: string }) {
	return (
		<div className="flex shrink-0 flex-col gap-1 rounded-md border border-border-subtle bg-bg-panel px-3 py-2 text-micro" data-testid={props.testId ?? "windows-only-config-notice"}>
			<span className="flex items-center gap-1.5 font-medium text-foreground/80">
				<Info className="size-3.5 shrink-0" aria-hidden="true" />
				{t("config.windowsOnly.title")}
			</span>
			<span className="text-muted-foreground">{t("config.windowsOnly.body", { page: props.page })}</span>
		</div>
	);
}
