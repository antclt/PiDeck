import { t } from "../i18n";
import { LogIn, LogOut, RefreshCw } from "lucide-react";
import { Button } from "../components/ui-shadcn/button";
import type { McpServerDefinition, McpServerListItem, McpServerTransport } from "../../../shared/types/mcp";

// 识别规则/类型来自 shared（主进程会话启动提醒与渲染层横幅共用单一来源）。
export { MCP_PROXY_EXTENSION_RULES, detectThirdPartyMcpExtensions } from "../../../shared/mcpThirdParty";
export type { ThirdPartyMcpExtension } from "../../../shared/mcpThirdParty";

/** 渲染层传输推断（仅 stdio/http；pi 0.99 无 socket）。 */
export function inferMcpTransport(definition: McpServerDefinition): McpServerTransport {
	if (typeof definition.url === "string" && definition.url.trim()) return "http";
	return "stdio";
}

/**
 * 停用判定：pi 0.99.2 内置 MCP 只认 `enabled`（默认 true）。
 * `disabled` 是 adapter 时代字段，pi 静默忽略。
 */
export function isMcpServerDisabled(definition: McpServerDefinition): boolean {
	return definition.enabled === false;
}

/** 旧文件里仍有 `disabled` 字段（pi 不识别）：展示迁移提示，不当作已停用。 */
export function hasLegacyDisabledField(definition: McpServerDefinition): boolean {
	return (definition as { disabled?: unknown }).disabled === true;
}

/** 判定是否使用供应商登录 token（auth.provider），该模式不使用 MCP OAuth。 */
export function usesProviderAuth(definition: McpServerDefinition): boolean {
	return typeof definition.auth?.provider === "string" && definition.auth.provider.length > 0;
}

/** 判定是否使用 MCP OAuth：HTTP、无 Authorization 头、无 auth.provider。 */
export function usesMcpOAuth(definition: McpServerDefinition): boolean {
	if (typeof definition.url !== "string" || !definition.url.trim()) return false;
	if (usesProviderAuth(definition)) return false;
	return !Object.keys(definition.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

/** 全局/项目 MCP 来源列表：合并结果按名字升序。 */

export function McpServerListPane(props: {
	servers: McpServerListItem[];
	selected: string | null;
	creating: boolean;
	onSelect: (name: string) => void;
	/** pi mcp list 的连接状态（按 server 名）；未检测的行显示未检测态。 */
	statusByName: Record<string, { state: string; tools: string[]; error?: string }>;
	credentialNames: ReadonlySet<string>;
	providerAuthNames: ReadonlySet<string>;
	loggingInServer: string | null;
	onLogin: (name: string) => void;
	onLogout: (name: string) => void;
	onRefreshStatus: () => void;
	statusLoading: boolean;
}) {
	const stateOf = (name: string): { state: string; tools: string[]; error?: string } | undefined => props.statusByName[name];
	return (
		<div className="flex min-h-0 flex-col gap-1 overflow-auto rounded-md border border-border-subtle bg-bg-panel p-1.5">
			<div className="flex items-center justify-between gap-2 px-1 pb-0.5">
				<span className="text-micro text-muted-foreground">{t("config.mcp.serverCount", { count: props.servers.length })}</span>
				<Button variant="ghost" size="icon-xs" onClick={props.onRefreshStatus} disabled={props.statusLoading} title={t("config.mcp.status.check")}>
					<RefreshCw size={12} className={props.statusLoading ? "animate-spin" : ""} />
				</Button>
			</div>
			{props.servers.length === 0 && !props.creating ? (
				<div className="px-2 py-6 text-center text-micro text-muted-foreground">{t("config.mcp.empty")}</div>
			) : (
				props.servers.map((item) => {
					const disabled = isMcpServerDisabled(item.definition);
					const status = props.statusByName[item.name];
					const state = status?.state ?? (disabled ? "disabled" : "");
					const needsAuth = state === "needs-auth";
					const connected = state === "connected";
					const hasCredential = props.credentialNames.has(item.name);
					return (
						<div
							key={item.name}
							className={`flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-control ${props.selected === item.name && !props.creating ? "bg-accent/40" : "hover:bg-bg-hover"}`}
							onClick={() => {
								if (!props.creating) props.onSelect(item.name);
							}}
						>
							<span className={`size-1.5 shrink-0 rounded-full ${connected ? "bg-[var(--color-success)]" : needsAuth ? "bg-[var(--color-warning,#d97706)]" : disabled ? "bg-muted-foreground" : status ? "bg-danger" : "bg-muted-foreground"}`} aria-hidden="true" />
							<span className={`min-w-0 flex-1 truncate font-medium ${item.pendingDelete && !item.revertsToInherited ? "line-through opacity-60" : ""}`}>{item.name}</span>
							{item.pendingDelete ? <span className="shrink-0 rounded-sm border border-border-subtle px-1 text-micro text-muted-foreground">{item.revertsToInherited ? t("config.mcp.revertBadge") : t("config.mcp.pendingDeleteBadge")}</span> : null}
							{item.originScope === "project-pi" && !item.pendingDelete ? <span className="shrink-0 rounded-sm border border-border-subtle px-1 text-micro text-muted-foreground">{t("config.mcp.layer.projectPi")}</span> : null}
							{connected ? <span className="shrink-0 text-micro text-muted-foreground">· {status.tools.length} 工具</span> : null}
							{needsAuth && !props.providerAuthNames.has(item.name) ? (
								props.loggingInServer === item.name ? (
									<span className="shrink-0 text-micro text-muted-foreground">{t("config.mcp.oauth.loggingIn")}</span>
								) : (
									<Button
										variant="outline"
										size="xs"
										onClick={(event) => {
											event.stopPropagation();
											props.onLogin(item.name);
										}}
									>
										<LogIn size={12} />
										{t("config.mcp.oauth.login")}
									</Button>
								)
							) : null}
							{hasCredential ? (
								<Button
									variant="ghost"
									size="icon-xs"
									title={t("config.mcp.oauth.logout")}
									onClick={(event) => {
										event.stopPropagation();
										props.onLogout(item.name);
									}}
								>
									<LogOut size={12} />
								</Button>
							) : null}
							{status?.error ? <span className="size-1.5 shrink-0 rounded-full bg-danger" title={status.error} aria-hidden="true" /> : null}
						</div>
					);
				})
			)}
			{props.creating ? <div className="rounded-sm bg-accent/40 px-2 py-1.5 text-control font-medium">{t("config.mcp.newServer")}</div> : null}
		</div>
	);
}
