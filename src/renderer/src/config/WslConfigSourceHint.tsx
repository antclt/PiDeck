import { HardDrive } from "lucide-react";
import { t } from "../i18n";
import type { WslConfigTargetHost } from "./piConfigTargetModel";

/**
 * 来源提示（P1-1）：明确当前 models/settings 编辑的是哪条 WSL 档案的发行版 HOME（.pi/agent）。
 *
 * 为什么不显示绝对路径：configGetDir 是单例本机目录，用它标 WSL 路径会把两套作用域混在一起；
 * 这里只用档案 label/distro/user 表达「改的是哪个环境的哪份文件」。
 */
export function WslConfigSourceHint(props: { host: WslConfigTargetHost; file: "models" | "settings" }) {
	return (
		<div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-bg-panel px-3 py-2 text-micro text-muted-foreground" data-testid="wsl-config-source-hint" data-host-id={props.host.id}>
			<HardDrive className="size-3.5 shrink-0" aria-hidden="true" />
			<span data-testid="wsl-config-source-target">{t("config.target.wslSource", { label: props.host.label })}</span>
			<span className="font-mono text-foreground/80" data-testid="wsl-config-source-distro">
				{props.host.distro}
			</span>
			<span className="font-mono text-foreground/80" data-testid="wsl-config-source-user">
				{props.host.user}
			</span>
			<span className="font-mono text-foreground/80">{props.file === "models" ? "models.json" : "settings.json"}</span>
			<span className="w-full text-micro text-muted-foreground" data-testid="wsl-config-provider-ops-note">
				{t("config.target.wslProviderOps")}
			</span>
		</div>
	);
}
