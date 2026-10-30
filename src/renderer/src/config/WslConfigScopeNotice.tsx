import { CloudOff } from "lucide-react";
import { WSL_CONFIG_CODES } from "../../../shared/piConfig";
import { t } from "../i18n";
import type { WslConfigTargetHost } from "./piConfigTargetModel";

/**
 * WSL 目标的页级说明（P1-1）：auth/trust/mcp/raw 不在 WSL 作用域内，本阶段只支持 models/settings。
 *
 * 这里必须挡住本地编辑器，而不是把 Windows 内容显示成 WSL 内容：在用户眼里「配置页显示的就是那个目标」，
 * 一旦允许本地表单在 WSL 目标下渲染并保存，改的就是 Windows HOME，WSL 会话永远读不到。
 */
export function WslConfigScopeNotice(props: { file: "auth" | "trust" | "mcp" | "raw"; host: WslConfigTargetHost }) {
	return (
		<div className="flex shrink-0 flex-col gap-2 rounded-md border border-border-subtle bg-bg-panel px-4 py-3" data-testid={"wsl-config-unsupported-" + props.file} data-code={WSL_CONFIG_CODES.unsupported}>
			<div className="flex items-center gap-2 text-control font-medium">
				<CloudOff className="size-4 shrink-0" aria-hidden="true" />
				{t("config.target.wsl")}
			</div>
			<p className="text-control leading-relaxed text-muted-foreground">{t("config.target.wslUnsupported", { label: props.host.label })}</p>
			<code className="w-fit rounded-sm bg-bg-input px-1.5 py-0.5 font-mono text-micro text-muted-foreground" data-testid="wsl-config-stable-code">
				{WSL_CONFIG_CODES.unsupported}
			</code>
		</div>
	);
}
