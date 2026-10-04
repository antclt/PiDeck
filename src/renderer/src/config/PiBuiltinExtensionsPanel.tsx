/**
 * pi 原生内置扩展开关面板（计划 A4）。
 *
 * 为什么单独一块：扩展页原有的「内置」行是 **PiDeck 自己的** `pi-deck-*.ts`；
 * pi 随 CLI 分发的四个内置扩展（mcp / llama.cpp / codemode / tool-search）此前在
 * PiDeck 里完全不可见，用户只能在 TUI 的 `pi config` 里开关。白名单模式还会无条件
 * 把它们全部带回，导致「PiDeck 里关不掉」。本面板把开关写进 pi 原生 settings.json
 * （`-builtin:<name>` / `+builtin:<name>`），全局与项目作用域各自生效。
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import { Switch } from "../components/ui-shadcn/switch";
import type { PiBuiltinExtension, PiResourceConfigSummary, PiResourceScope } from "../../../shared/types/piResources";
import type { ResourceScope } from "./resourceScopeModel";
import { isProjectUntrustedError } from "./projectResourceErrors";

type PiResourcesApi = {
	piResourcesSummary: (scope?: PiResourceScope) => Promise<PiResourceConfigSummary>;
	piResourcesSetBuiltin: (input: { scope?: PiResourceScope; name: PiBuiltinExtension; enabled: boolean; expectedRevision?: string }) => Promise<{ ok: boolean; error?: string; revision?: string }>;
};

function api(): PiResourcesApi {
	const desktop = (window as unknown as { piDesktop?: { config?: Partial<PiResourcesApi> } }).piDesktop;
	if (!desktop?.config?.piResourcesSummary || !desktop.config.piResourcesSetBuiltin) throw new Error("PiDeck pi resources API is not available");
	return desktop.config as PiResourcesApi;
}

/** 每个内置扩展的作用说明（工具/能力影响）。 */
const BUILTIN_HINTS: Record<PiBuiltinExtension, string> = {
	mcp: "config.piResources.builtin.mcp",
	"llama.cpp": "config.piResources.builtin.llama",
	codemode: "config.piResources.builtin.codemode",
	"tool-search": "config.piResources.builtin.toolSearch",
};

export function PiBuiltinExtensionsPanel(props: {
	scope: ResourceScope;
	projectId?: string;
	/** 切换成功后通知父层刷新依赖数据（例如 MCP 提示）。 */
	onChanged?: () => void;
}) {
	const scope: PiResourceScope | undefined = props.scope === "project" && props.projectId ? { scope: "project", projectId: props.projectId } : { scope: "global" };
	const [summary, setSummary] = useState<PiResourceConfigSummary | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [toggling, setToggling] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setSummary(await api().piResourcesSummary(scope));
		} catch (caught) {
			setSummary(null);
			// 未信任项目：主进程拒读是正确门禁，但要把裸 IPC 异常换成引导文案（先信任再刷新）
			setError(isProjectUntrustedError(caught) ? t("config.projectUntrusted.notice") : caught instanceof Error ? caught.message : String(caught));
		} finally {
			setLoading(false);
		}
	}, [scope]);

	useEffect(() => {
		void load();
	}, [load]);

	const toggle = async (name: PiBuiltinExtension, enabled: boolean) => {
		if (toggling) return;
		setToggling(name);
		try {
			const result = await api().piResourcesSetBuiltin({ scope, name, enabled, expectedRevision: summary?.revision });
			if (!result.ok) {
				setError(isProjectUntrustedError(result.error) ? t("config.projectUntrusted.notice") : (result.error ?? t("config.piResources.saveFailed")));
				// revision 冲突：重新读取，避免用户在旧草稿上继续切
				if (result.error?.includes("changed on disk")) await load();
				return;
			}
			await load();
			props.onChanged?.();
			showNotice(t("config.piResources.saved"), 2500);
		} catch (caught) {
			setError(isProjectUntrustedError(caught) ? t("config.projectUntrusted.notice") : caught instanceof Error ? caught.message : String(caught));
		} finally {
			setToggling(null);
		}
	};

	return (
		<div className="mb-3 rounded-md border border-border-subtle bg-bg-panel p-3">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="text-control font-medium">{t("config.piResources.title")}</div>
					<p className="mt-0.5 text-micro text-muted-foreground">{t("config.piResources.hint")}</p>
				</div>
				<Button variant="outline" size="xs" onClick={() => void load()} disabled={loading}>
					<RefreshCw size={13} />
					{t("common.refresh")}
				</Button>
			</div>

			{error ? (
				<div className="mt-2 flex items-start gap-1.5 rounded-sm border border-danger/20 bg-danger-soft px-2 py-1.5 text-micro text-danger">
					<AlertTriangle size={13} className="mt-px shrink-0" />
					<span className="break-all">{error}</span>
				</div>
			) : null}

			{loading && !summary ? <div className="py-3 text-center text-micro text-muted-foreground">{t("common.loading")}</div> : null}

			{summary ? (
				<div className="mt-2 grid gap-1.5">
					{summary.builtins.map((item) => (
						<div key={item.name} className="flex items-center justify-between gap-3 rounded-sm border border-border-subtle px-2.5 py-1.5">
							<div className="min-w-0">
								<div className="flex items-center gap-1.5">
									<span className="font-mono text-control text-text-primary">builtin:{item.name}</span>
									<span className={`rounded-sm px-1 text-micro ${item.enabled ? "text-[var(--color-success)]" : "text-muted-foreground"}`}>{item.enabled ? t("config.piResources.on") : t("config.piResources.off")}</span>
									{item.state === "inherit" ? <span className="text-micro text-muted-foreground">· {t("config.piResources.inherited")}</span> : null}
								</div>
								<div className="mt-0.5 text-micro text-muted-foreground">{t(BUILTIN_HINTS[item.name] as never)}</div>
							</div>
							<Switch checked={item.enabled} disabled={toggling === item.name} onCheckedChange={(checked) => void toggle(item.name, checked)} aria-label={item.name} />
						</div>
					))}
					<p className="font-mono text-micro text-muted-foreground" title={summary.settingsPath}>
						{summary.settingsPath}
					</p>
					<p className="text-micro text-muted-foreground">{t("config.piResources.restartHint")}</p>
				</div>
			) : null}
		</div>
	);
}
