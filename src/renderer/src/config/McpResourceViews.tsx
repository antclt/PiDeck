import { Fragment, useState } from "react";
import { t } from "../i18n";
import { Button } from "../components/ui-shadcn/button";
import type {
	McpServerDefinition,
	McpServerListItem,
	McpServerTransport,
} from "../../../shared/types/mcp";
import type { ResourceScope } from "./ResourceScopeSelector";

const ADAPTER_INSTALL_SOURCE = "npm:pi-mcp-adapter";

export function inferMcpTransport(definition: McpServerDefinition): McpServerTransport {
	if (typeof definition.url === "string" && definition.url.trim()) return "http";
	if (typeof definition.socket === "string" && definition.socket.trim()) return "socket";
	return "stdio";
}

export function isMcpServerDisabled(definition: McpServerDefinition): boolean {
	return definition.disabled === true;
}

function pathsEqual(left: string, right: string): boolean {
	let normalizedLeft = left.replace(/\\/g, "/").replace(/\/$/, "");
	let normalizedRight = right.replace(/\\/g, "/").replace(/\/$/, "");
	// Ordinary host Windows paths are case-insensitive; Linux/WSL logical paths remain case-sensitive.
	if (/^(?:[a-z]:\/|\/\/)/i.test(normalizedLeft)) {
		normalizedLeft = normalizedLeft.toLowerCase();
		normalizedRight = normalizedRight.toLowerCase();
	}
	return normalizedLeft === normalizedRight;
}

/** Adapter installation guide shown before MCP configuration becomes useful. */
export function McpAdapterGuide(props: { onInstalled: () => void }) {
	const [installing, setInstalling] = useState(false);
	const [installFailed, setInstallFailed] = useState(false);
	const [copied, setCopied] = useState(false);
	const installCmd = `pi install ${ADAPTER_INSTALL_SOURCE}`;

	const install = async () => {
		setInstalling(true);
		setInstallFailed(false);
		try {
			await window.piDesktop.extensions.install(ADAPTER_INSTALL_SOURCE);
			props.onInstalled();
		} catch {
			setInstallFailed(true);
		} finally {
			setInstalling(false);
		}
	};

	const copyCommand = async () => {
		try {
			await navigator.clipboard.writeText(installCmd);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 2000);
		} catch {
			// The command remains selectable when clipboard access is unavailable.
		}
	};

	return (
		<div className="rounded-md border border-border-subtle bg-bg-panel p-4">
			<p className="text-control text-muted-foreground">{t("config.mcp.notInstalled.desc")}</p>
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<Button
					variant="default"
					size="sm"
					onClick={() => void install()}
					disabled={installing}
					loading={installing}
				>
					{installing ? t("config.mcp.notInstalled.installing") : t("config.mcp.notInstalled.install")}
				</Button>
				<code className="rounded-sm border border-border-subtle bg-bg-hover px-2 py-1 font-mono text-micro">
					{installCmd}
				</code>
				<Button variant="ghost" size="sm" onClick={() => void copyCommand()}>
					{copied ? t("config.mcp.notInstalled.copied") : t("config.mcp.notInstalled.copyCmd")}
				</Button>
			</div>
			{installFailed ? (
				<p className="mt-2 text-micro text-danger">{t("config.mcp.notInstalled.installFailed")}</p>
			) : null}
			<p className="mt-2 text-micro text-muted-foreground">{t("config.mcp.notInstalled.restartHint")}</p>
		</div>
	);
}

/** Scope-aware MCP source list. Project scope groups project definitions before inherited globals. */
export function McpServerListPane(props: {
	scope: ResourceScope;
	projectLayerPaths: readonly string[];
	servers: McpServerListItem[];
	selected: string | null;
	creating: boolean;
	onSelect: (name: string) => void;
}) {
	const projectServers = props.servers.filter((item) =>
		props.projectLayerPaths.some((path) => pathsEqual(item.originPath, path)),
	);
	const globalServers = props.servers.filter((item) =>
		!props.projectLayerPaths.some((path) => pathsEqual(item.originPath, path)),
	);
	const groups = props.scope === "project"
		? [
			{ key: "project", label: t("config.resourceGroup.project"), items: projectServers },
			{ key: "global", label: t("config.resourceGroup.global"), items: globalServers },
		]
		: [{ key: "global", label: t("config.resourceGroup.global"), items: globalServers }];

	return (
		<div className="flex min-h-0 flex-col gap-1 overflow-auto rounded-md border border-border-subtle bg-bg-panel p-1.5">
			{props.servers.length === 0 && !props.creating ? (
				<div className="px-2 py-6 text-center text-micro text-muted-foreground">{t("config.mcp.empty")}</div>
			) : (
				groups.map((group) => (
					<Fragment key={group.key}>
						{props.scope === "project" && group.items.length > 0 ? (
							<div className="px-2 pb-1 pt-2 text-micro font-semibold text-muted-foreground">
								{group.label}
							</div>
						) : null}
						{group.items.map((item) => {
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
									<span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
									<span className="shrink-0 text-micro text-muted-foreground">{inferMcpTransport(item.definition)}</span>
								</button>
							);
						})}
					</Fragment>
				))
			)}
			{props.creating ? (
				<div className="rounded-sm bg-accent/40 px-2 py-1.5 text-control font-medium">{t("config.mcp.newServer")}</div>
			) : null}
		</div>
	);
}
