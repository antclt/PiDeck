import { t } from "../i18n";
import { LogIn, LogOut } from "lucide-react";
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
/** 单个 server 的连接状态行（含登录/登出/错误/工具数）；全量面板与编辑器状态卡共用。 */
export function McpStatusRow(props: {
	server: { name: string; state: string; exposure: string; tools: string[]; error?: string };
	providerAuth: boolean;
	hasCredential: boolean;
	loggingIn: boolean;
	loginUrl: { server: string; url: string } | null;
	onLogin: (name: string) => void;
	onLogout: (name: string) => void;
	onOpenAuthUrl: (url: string) => void;
}) {
	const { server } = props;
	return (
		<div className="rounded-sm border border-border-subtle px-2.5 py-1.5">
			<div className="flex flex-wrap items-center gap-2">
				<span className={`size-1.5 shrink-0 rounded-full ${server.state === "connected" ? "bg-[var(--color-success)]" : server.state === "needs-auth" ? "bg-[var(--color-warning,#d97706)]" : server.state === "disabled" ? "bg-muted-foreground" : "bg-danger"}`} aria-hidden="true" />
				<span className="text-control font-medium">{server.name}</span>
				<span className="text-micro text-muted-foreground">
					{server.state === "connected" ? t("config.mcp.status.connected", { count: server.tools.length }) : server.state === "needs-auth" ? t("config.mcp.status.needsAuth") : server.state === "disabled" ? t("config.mcp.status.disabled") : t("config.mcp.status.disconnected")}
				</span>
				<span className="text-micro text-muted-foreground">· {server.exposure}</span>
				{props.providerAuth ? (
					// provider-auth 不是 MCP OAuth：不能提示再去 MCP 登录，也不能在这里登出。
					<span className="text-micro text-muted-foreground">{t("config.mcp.providerAuth.statusHint")}</span>
				) : (
					<>
						{server.state === "needs-auth" ? (
							props.loggingIn ? (
								<span className="text-micro text-muted-foreground">{t("config.mcp.oauth.loggingIn")}</span>
							) : (
								<Button variant="outline" size="xs" onClick={() => props.onLogin(server.name)}>
									<LogIn size={12} />
									{t("config.mcp.oauth.login")}
								</Button>
							)
						) : null}
						{props.hasCredential ? (
							<Button variant="ghost" size="xs" onClick={() => props.onLogout(server.name)}>
								<LogOut size={12} />
								{t("config.mcp.oauth.logout")}
							</Button>
						) : null}
					</>
				)}
			</div>
			{props.loggingIn ? (
				<div className="mt-1 flex flex-wrap items-center gap-1.5 text-micro text-muted-foreground">
					<span>{t("config.mcp.status.loginPending")}</span>
					{props.loginUrl?.server === server.name ? (
						<button type="button" className="text-primary underline underline-offset-2" onClick={() => { if (props.loginUrl) props.onOpenAuthUrl(props.loginUrl.url); }}>
							{t("config.mcp.oauth.openAuthLink")}
						</button>
					) : null}
				</div>
			) : null}
			{server.error ? (
				<p className="mt-1 break-all text-micro text-danger" title={server.error}>
					{server.error}
				</p>
			) : null}
			{server.tools.length > 0 && server.state !== "connected" ? <p className="mt-1 truncate font-mono text-micro text-muted-foreground">{server.tools.join(", ")}</p> : null}
		</div>
	);
}

export function McpServerListPane(props: { servers: McpServerListItem[]; selected: string | null; creating: boolean; onSelect: (name: string) => void }) {
	return (
		<div className="flex min-h-0 flex-col gap-1 overflow-auto rounded-md border border-border-subtle bg-bg-panel p-1.5">
			{props.servers.length === 0 && !props.creating ? (
				<div className="px-2 py-6 text-center text-micro text-muted-foreground">{t("config.mcp.empty")}</div>
			) : (
				props.servers.map((item) => {
					const disabled = isMcpServerDisabled(item.definition);
					return (
						<button
							key={item.name}
							type="button"
							className={`flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-control ${props.selected === item.name && !props.creating ? "bg-accent/40" : "hover:bg-bg-hover"}`}
							onClick={() => {
								if (!props.creating) props.onSelect(item.name);
							}}
						>
							<span className={`size-1.5 shrink-0 rounded-full ${disabled ? "bg-muted-foreground" : "bg-[var(--color-success)]"}`} aria-hidden="true" />
							<span className={`min-w-0 flex-1 truncate font-medium ${item.pendingDelete && !item.revertsToInherited ? "line-through opacity-60" : ""}`}>{item.name}</span>
							{item.pendingDelete ? <span className="shrink-0 rounded-sm border border-border-subtle px-1 text-micro text-muted-foreground">{item.revertsToInherited ? t("config.mcp.revertBadge") : t("config.mcp.pendingDeleteBadge")}</span> : null}
							{item.originScope === "project-pi" && !item.pendingDelete ? <span className="shrink-0 rounded-sm border border-border-subtle px-1 text-micro text-muted-foreground">{t("config.mcp.layer.projectPi")}</span> : null}
							<span className="shrink-0 text-micro text-muted-foreground">{inferMcpTransport(item.definition)}</span>
						</button>
					);
				})
			)}
			{props.creating ? <div className="rounded-sm bg-accent/40 px-2 py-1.5 text-control font-medium">{t("config.mcp.newServer")}</div> : null}
		</div>
	);
}
