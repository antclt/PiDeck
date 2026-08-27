/**
 * Pi 配置管理 → MCP 页。
 * 只编辑 pi-mcp-adapter 读取的 mcp.json（可写层 ~/.pi/agent/mcp.json），
 * 不启动 MCP 运行时；探测仅检查 command 是否在 PATH / HTTP 是否可达。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { Plus, Trash2, PlugZap, RefreshCw } from "lucide-react";
import { t } from "../i18n";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Switch } from "../components/ui-shadcn/switch";
import { Label } from "../components/ui-shadcn/label";
import { Textarea } from "../components/ui-shadcn/textarea";
import { ConfigSelect, openDocsInSystemBrowser } from "./ConfigShared";
import { argsToText, isMcpServerName, omitUndefined, recordToText, textToArgs, textToRecord } from "./mcpForm";
import type {
	McpConfigFile,
	McpConfigSnapshot,
	McpProbeResult,
	McpServerDefinition,
	McpServerListItem,
	McpServerTransport,
} from "../../../shared/types/mcp";

const api = (window as unknown as { piDesktop: {
	config: {
		getMcp: (projectPath?: string) => Promise<McpConfigSnapshot>;
		saveMcp: (data: McpConfigFile) => Promise<{ valid: boolean; error?: string }>;
		probeMcp: (definition: McpServerDefinition) => Promise<McpProbeResult>;
	};
} }).piDesktop;

const MCP_DOCS = "https://nicobailon-pi-mcp-adapter.mintlify.app/configuration/server-setup";
const EMPTY_FILE: McpConfigFile = { mcpServers: {} };

const LIFECYCLE_OPTIONS = [
	{ value: "lazy", labelKey: "config.mcp.lifecycle.lazy" as const },
	{ value: "eager", labelKey: "config.mcp.lifecycle.eager" as const },
	{ value: "keep-alive", labelKey: "config.mcp.lifecycle.keepAlive" as const },
	{ value: "lazy-keep-alive", labelKey: "config.mcp.lifecycle.lazyKeepAlive" as const },
];

const TRANSPORT_OPTIONS: Array<{ value: McpServerTransport; labelKey: "config.mcp.transport.stdio" | "config.mcp.transport.http" | "config.mcp.transport.socket" }> = [
	{ value: "stdio", labelKey: "config.mcp.transport.stdio" },
	{ value: "http", labelKey: "config.mcp.transport.http" },
	{ value: "socket", labelKey: "config.mcp.transport.socket" },
];

export type McpTabHandle = {
	save: () => Promise<boolean>;
	reload: () => Promise<void>;
};

const ADAPTER_EXTENSION_ID = "pi-mcp-adapter";
const ADAPTER_INSTALL_SOURCE = "npm:pi-mcp-adapter";

/**
 * 未安装 pi-mcp-adapter 时的引导卡（参考用量查询页 NotInstalledCard 模式）。
 * mcp.json 只有被 pi 进程里的 adapter 扩展加载才有意义，缺扩展时先引导安装，
 * 避免用户以为改完配置立刻生效。
 */
function McpAdapterGuide(props: { onInstalled: () => void }) {
	const [installing, setInstalling] = useState(false);
	const [installFailed, setInstallFailed] = useState(false);
	const [copied, setCopied] = useState(false);
	const installCmd = `pi install ${ADAPTER_INSTALL_SOURCE}`;

	const install = async () => {
		setInstalling(true);
		setInstallFailed(false);
		try {
			await window.piDesktop.extensions.install(ADAPTER_INSTALL_SOURCE);
			// 装完重新探测：扩展列表此时应已包含 adapter，切回配置编辑器
			props.onInstalled();
		} catch (error) {
			console.error("[McpTab] install pi-mcp-adapter failed", error);
			setInstallFailed(true);
		} finally {
			setInstalling(false);
		}
	};

	const copyCommand = async () => {
		try {
			await navigator.clipboard.writeText(installCmd);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// 剪贴板不可用时静默失败（命令仍可手选复制）
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

function inferTransport(def: McpServerDefinition): McpServerTransport {
	if (typeof def.url === "string" && def.url.trim()) return "http";
	if (typeof def.socket === "string" && def.socket.trim()) return "socket";
	return "stdio";
}

function blankDefinition(transport: McpServerTransport): McpServerDefinition {
	if (transport === "http") return { url: "https://", lifecycle: "lazy" };
	if (transport === "socket") return { socket: "", lifecycle: "lazy" };
	return { command: "npx", args: ["-y"], lifecycle: "lazy" };
}

function serverDisabled(def: McpServerDefinition): boolean {
	return def.disabled === true;
}

export const McpTab = forwardRef<McpTabHandle, {
	projectPath?: string;
	onDirtyChange: (dirty: boolean) => void;
}>(function McpTab(props, ref) {
	const { projectPath, onDirtyChange } = props;
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [snapshot, setSnapshot] = useState<McpConfigSnapshot | null>(null);
	const [writable, setWritable] = useState<McpConfigFile>(EMPTY_FILE);
	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState<{ name: string; definition: McpServerDefinition } | null>(null);
	const [probe, setProbe] = useState<McpProbeResult | null>(null);
	const [probing, setProbing] = useState(false);
	/** pi-mcp-adapter 扩展是否已安装；null = 探测失败/不可用（不阻塞编辑，预览环境等场景降级）。 */
	const [adapterInstalled, setAdapterInstalled] = useState<boolean | null>(null);

	const markDirty = useCallback(() => {
		onDirtyChange(true);
	}, [onDirtyChange]);

	/**
	 * 探测 pi-mcp-adapter 扩展是否已安装（扩展列表）；失败返回 null 由调用方降级。
	 * mcp.json 依赖该扩展被 pi 加载，缺扩展时配置页改为引导安装。
	 */
	const probeAdapter = useCallback(async (): Promise<boolean | null> => {
		try {
			const list = await window.piDesktop.extensions.list();
			const found = list.extensions.some((ext) => {
				const source = ext.source ?? "";
				const id = ext.id ?? "";
				return id === ADAPTER_EXTENSION_ID || source.includes(ADAPTER_EXTENSION_ID);
			});
			setAdapterInstalled(found);
			return found;
		} catch {
			// 扩展 API 不可用时（如预览环境）不阻塞配置编辑
			setAdapterInstalled(null);
			return null;
		}
	}, []);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		setProbe(null);
		try {
			// 先探测扩展再拉配置：未装扩展时整页切为引导卡，配置放不放入负载
			await probeAdapter();
			const next = await api.config.getMcp(projectPath);
			setSnapshot(next);
			setWritable(next.writableFile.mcpServers ? next.writableFile : { ...next.writableFile, mcpServers: {} });
			onDirtyChange(false);
			setCreating(null);
			const names = next.servers.map((item) => item.name);
			setSelected((current) => (current && names.includes(current) ? current : names[0] ?? null));
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setLoading(false);
		}
	}, [onDirtyChange, projectPath, probeAdapter]);

	useEffect(() => {
		void load();
	}, [load]);

	const displayServers: McpServerListItem[] = useMemo(() => {
		if (!snapshot) return [];
		const writableServers = writable.mcpServers ?? {};
		const seen = new Set<string>();
		const items: McpServerListItem[] = snapshot.servers.map((item) => {
			seen.add(item.name);
			const overlay = writableServers[item.name];
			if (!overlay) return item;
			return {
				...item,
				definition: { ...item.definition, ...omitUndefined(overlay) },
				ownedByWritable: item.originPath === snapshot.writablePath,
				overridePath: snapshot.writablePath,
			};
		});
		for (const [name, definition] of Object.entries(writableServers)) {
			if (seen.has(name)) continue;
			items.push({
				name,
				definition,
				originPath: snapshot.writablePath,
				overridePath: snapshot.writablePath,
				ownedByWritable: true,
			});
		}
		return items.sort((left, right) => left.name.localeCompare(right.name));
	}, [snapshot, writable]);

	const selectedItem = displayServers.find((item) => item.name === selected) ?? null;
	const editingDef: McpServerDefinition = creating
		? creating.definition
		: (selectedItem?.definition ?? blankDefinition("stdio"));
	const transport = inferTransport(editingDef);

	const applyWritable = useCallback((next: McpConfigFile) => {
		setWritable(next);
		markDirty();
	}, [markDirty]);

	const upsert = useCallback((name: string, definition: McpServerDefinition) => {
		applyWritable({
			...writable,
			mcpServers: { ...(writable.mcpServers ?? {}), [name]: definition },
		});
	}, [applyWritable, writable]);

	const startCreate = () => {
		setCreating({ name: "", definition: blankDefinition("stdio") });
		setSelected(null);
		setProbe(null);
	};

	const cancelCreate = () => {
		setCreating(null);
		setSelected(displayServers[0]?.name ?? null);
		setProbe(null);
		// 新建草稿不在 writable 里；取消后若可写层未改，清掉黄点。
		if (snapshot && JSON.stringify(writable) === JSON.stringify(snapshot.writableFile)) {
			onDirtyChange(false);
		}
	};

	const patchEditing = (patch: Partial<McpServerDefinition>) => {
		if (creating) {
			setCreating({ ...creating, definition: { ...creating.definition, ...patch } });
			markDirty();
			return;
		}
		if (!selected) return;
		upsert(selected, { ...editingDef, ...patch });
	};

	const switchTransport = (next: McpServerTransport) => {
		const kept = {
			lifecycle: editingDef.lifecycle,
			disabled: editingDef.disabled,
			env: editingDef.env,
			headers: editingDef.headers,
		};
		const nextDef = { ...blankDefinition(next), ...kept };
		if (creating) {
			setCreating({ ...creating, definition: nextDef });
			markDirty();
			return;
		}
		if (selected) upsert(selected, nextDef);
	};

	const toggleDisabled = (item: McpServerListItem, disabled: boolean) => {
		const existing = writable.mcpServers?.[item.name];
		if (existing) {
			upsert(item.name, { ...existing, disabled: disabled ? true : undefined });
			return;
		}
		// 下层只读来源：只写 disabled 覆盖，不把 command/url 复制进 Pi 层。
		upsert(item.name, { disabled: disabled ? true : false });
	};

	const removeSelected = () => {
		if (!selected) return;
		const item = selectedItem;
		const nextServers = { ...(writable.mcpServers ?? {}) };
		// 传输定义在 Pi 可写层：真正删除条目。只读层只能写 disabled 覆盖，删覆盖会让服务重新启用。
		if (item?.ownedByWritable) {
			delete nextServers[selected];
			applyWritable({ ...writable, mcpServers: nextServers });
		} else if (item) {
			upsert(selected, { disabled: true });
		}
		const remaining = displayServers.filter((entry) => entry.name !== selected);
		setSelected(remaining[0]?.name ?? null);
		setProbe(null);
	};

	const runProbe = async () => {
		setProbing(true);
		setProbe(null);
		try {
			setProbe(await api.config.probeMcp(editingDef));
		} catch (caught) {
			setProbe({ ok: false, error: caught instanceof Error ? caught.message : String(caught) });
		} finally {
			setProbing(false);
		}
	};

	const save = useCallback(async (): Promise<boolean> => {
		if (snapshot?.writableError) {
			setError(t("config.mcp.writableBroken"));
			return false;
		}
		const toSave: McpConfigFile = {
			...writable,
			mcpServers: { ...(writable.mcpServers ?? {}) },
		};
		if (creating) {
			const name = creating.name.trim();
			if (!name) {
				setError(t("config.mcp.nameRequired"));
				return false;
			}
			if (!isMcpServerName(name)) {
				setError(t("config.mcp.nameInvalid"));
				return false;
			}
			// 与已合并列表或可写层撞名时拒绝，避免覆盖已有服务。
			if (displayServers.some((item) => item.name === name) || Boolean(toSave.mcpServers?.[name])) {
				setError(t("config.mcp.nameDuplicate"));
				return false;
			}
			toSave.mcpServers = { ...toSave.mcpServers, [name]: creating.definition };
		}
		setSaving(true);
		setError(null);
		try {
			const result = await api.config.saveMcp(toSave);
			if (!result.valid) {
				setError(result.error ?? t("config.saveFailed"));
				return false;
			}
			await load();
			if (creating?.name.trim()) setSelected(creating.name.trim());
			return true;
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
			return false;
		} finally {
			setSaving(false);
		}
	}, [creating, displayServers, load, snapshot?.writableError, writable]);

	useImperativeHandle(ref, () => ({ save, reload: load }), [save, load]);

	const layerLabel = useMemo(() => ({
		"user-config": t("config.mcp.layer.userConfig"),
		agents: t("config.mcp.layer.agents"),
		"agents-dir": t("config.mcp.layer.agentsDir"),
		"pi-agent": t("config.mcp.layer.piAgent"),
		project: t("config.mcp.layer.project"),
		"project-pi": t("config.mcp.layer.projectPi"),
	}), []);

	if (loading && !snapshot) {
		return <div className="py-12 text-center text-control text-muted-foreground">{t("common.loading")}</div>;
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<strong>{t("config.nav.mcp")}</strong>
					<p className="mt-1 text-micro text-muted-foreground">{t("config.mcp.hint")}</p>
				<p className="mt-1 text-micro text-muted-foreground">{t("config.restartHint")}</p>
					<a
						href={MCP_DOCS}
						className="mt-1 inline-block text-micro text-accent hover:underline"
						onClick={openDocsInSystemBrowser(MCP_DOCS)}
					>
						{t("config.mcp.docs")}
					</a>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || saving}>
						<RefreshCw size={14} />
						{t("common.refresh")}
					</Button>
					{adapterInstalled !== false ? (
						<Button size="sm" onClick={startCreate} disabled={saving || Boolean(creating)}>
							<Plus size={14} />
							{t("config.mcp.add")}
						</Button>
					) : null}
				</div>
			</div>

			{error ? (
				<div className="rounded-sm border border-danger/20 bg-danger-soft px-3 py-2 text-control text-danger">{error}</div>
			) : null}
			{snapshot?.writableError ? (
				<div className="rounded-sm border border-danger/20 bg-danger-soft px-3 py-2 text-control text-danger">
					{t("config.mcp.writableBroken")}
				</div>
			) : null}

			{adapterInstalled === false ? (
				<McpAdapterGuide onInstalled={load} />
			) : (
				<>
					<div className="flex flex-wrap gap-1.5">
						{(snapshot?.layers ?? []).map((layer) => (
							<span
								key={layer.kind}
								className={`rounded-sm border px-1.5 py-0.5 font-mono text-micro ${layer.exists ? "border-border-subtle text-text-secondary" : "border-dashed border-border-subtle text-muted-foreground"}`}
								title={layer.path}
							>
								{layerLabel[layer.kind]}
								{layer.writable ? ` · ${t("config.mcp.writable")}` : ""}
								{layer.exists ? "" : ` · ${t("config.mcp.missing")}`}
							</span>
						))}
					</div>
					{snapshot?.writablePath ? (
						<p className="truncate font-mono text-micro text-muted-foreground" title={snapshot.writablePath}>
							{t("config.mcp.writingTo")}: {snapshot.writablePath}
						</p>
					) : null}
				</>
			)}

			{adapterInstalled === false ? null : (
				<div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,280px)_minmax(0,1fr)] gap-3 max-[820px]:grid-cols-1">
				<div className="flex min-h-0 flex-col gap-1 overflow-auto rounded-md border border-border-subtle bg-bg-panel p-1.5">
					{displayServers.length === 0 && !creating ? (
						<div className="px-2 py-6 text-center text-micro text-muted-foreground">{t("config.mcp.empty")}</div>
					) : (
						displayServers.map((item) => {
							const disabled = serverDisabled(item.definition);
							return (
								<button
									key={item.name}
									type="button"
									className={`flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-control ${selected === item.name && !creating ? "bg-accent/40" : "hover:bg-bg-hover"}`}
									onClick={() => {
										if (creating) return;
										setSelected(item.name);
										setProbe(null);
									}}
								>
									<span className={`size-1.5 shrink-0 rounded-full ${disabled ? "bg-muted-foreground" : "bg-[var(--color-success)]"}`} aria-hidden="true" />
									<span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
									<span className="shrink-0 text-micro text-muted-foreground">{inferTransport(item.definition)}</span>
								</button>
							);
						})
					)}
					{creating ? (
						<div className="rounded-sm bg-accent/40 px-2 py-1.5 text-control font-medium">{t("config.mcp.newServer")}</div>
					) : null}
				</div>

				<div className="flex min-h-0 flex-col gap-3 overflow-auto rounded-md border border-border-subtle bg-bg-panel p-3">
					{!selected && !creating ? (
						<div className="py-8 text-center text-micro text-muted-foreground">{t("config.mcp.selectHint")}</div>
					) : (
						<>
							<div className="grid gap-2">
								<Label>{t("config.mcp.field.name")}</Label>
								<Input
									value={creating ? creating.name : selected ?? ""}
									onChange={(event) => {
										if (!creating) return;
										setCreating({ ...creating, name: event.target.value });
										markDirty();
									}}
									disabled={!creating || saving}
									placeholder="chrome-devtools"
									className="h-8 font-mono"
								/>
							</div>
							<div className="grid gap-2">
								<Label>{t("config.mcp.field.transport")}</Label>
								<ConfigSelect
									value={transport}
									options={TRANSPORT_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
									onChange={(value) => switchTransport(value as McpServerTransport)}
								/>
							</div>
							{transport === "stdio" ? (
								<>
									<div className="grid gap-2">
										<Label>{t("config.mcp.field.command")}</Label>
										<Input
											value={editingDef.command ?? ""}
											onChange={(event) => patchEditing({ command: event.target.value, url: undefined, socket: undefined })}
											className="h-8 font-mono"
											placeholder="npx"
										/>
									</div>
									<div className="grid gap-2">
										<Label>{t("config.mcp.field.args")}</Label>
										<Input
											value={argsToText(editingDef.args)}
											onChange={(event) => patchEditing({ args: textToArgs(event.target.value) })}
											className="h-8 font-mono"
											placeholder="-y chrome-devtools-mcp@1.6.0"
										/>
									</div>
									<div className="grid gap-2">
										<Label>{t("config.mcp.field.cwd")}</Label>
										<Input
											value={editingDef.cwd ?? ""}
											onChange={(event) => patchEditing({ cwd: event.target.value || undefined })}
											className="h-8 font-mono"
										/>
									</div>
								</>
							) : null}
							{transport === "http" ? (
								<div className="grid gap-2">
									<Label>{t("config.mcp.field.url")}</Label>
									<Input
										value={editingDef.url ?? ""}
										onChange={(event) => patchEditing({ url: event.target.value, command: undefined, args: undefined, socket: undefined })}
										className="h-8 font-mono"
										placeholder="https://mcp.example.com/mcp"
									/>
								</div>
							) : null}
							{transport === "socket" ? (
								<div className="grid gap-2">
									<Label>{t("config.mcp.field.socket")}</Label>
									<Input
										value={editingDef.socket ?? ""}
										onChange={(event) => patchEditing({ socket: event.target.value, command: undefined, url: undefined })}
										className="h-8 font-mono"
									/>
								</div>
							) : null}
							<div className="grid gap-2">
								<Label>{t("config.mcp.field.lifecycle")}</Label>
								<ConfigSelect
									value={editingDef.lifecycle ?? "lazy"}
									options={LIFECYCLE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
									onChange={(value) => patchEditing({ lifecycle: value as McpServerDefinition["lifecycle"] })}
								/>
							</div>
							{transport === "stdio" ? (
								<div className="grid gap-2">
									<Label>{t("config.mcp.field.env")}</Label>
									<Textarea
										value={recordToText(editingDef.env)}
										onChange={(event) => patchEditing({ env: textToRecord(event.target.value) })}
										placeholder={t("config.mcp.field.envPlaceholder")}
										className="min-h-20 font-mono text-control"
									/>
								</div>
							) : null}
							{transport === "http" ? (
								<div className="grid gap-2">
									<Label>{t("config.mcp.field.headers")}</Label>
									<Textarea
										value={recordToText(editingDef.headers)}
										onChange={(event) => patchEditing({ headers: textToRecord(event.target.value) })}
										placeholder={t("config.mcp.field.headersPlaceholder")}
										className="min-h-20 font-mono text-control"
									/>
								</div>
							) : null}
							<div className="flex items-center justify-between gap-3 rounded-sm border border-border-subtle px-2.5 py-2">
								<div>
									<div className="text-control font-medium">{t("config.mcp.field.enabled")}</div>
									<div className="text-micro text-muted-foreground">{t("config.mcp.field.enabledHint")}</div>
								</div>
								<Switch
									checked={!serverDisabled(editingDef)}
									onCheckedChange={(checked) => {
										if (creating) {
											patchEditing({ disabled: checked ? undefined : true });
											return;
										}
										if (selectedItem) toggleDisabled(selectedItem, !checked);
									}}
								/>
							</div>
							{selectedItem && !creating ? (
								<p className="text-micro text-muted-foreground" title={selectedItem.originPath}>
									{t("config.mcp.origin")}: {selectedItem.originPath}
									{selectedItem.ownedByWritable ? "" : ` · ${t("config.mcp.overlayHint")}`}
								</p>
							) : null}
							<div className="flex flex-wrap items-center gap-1.5">
								<Button variant="outline" size="sm" onClick={() => void runProbe()} disabled={probing || saving}>
									<PlugZap size={14} />
									{probing ? t("config.mcp.probing") : t("config.mcp.probe")}
								</Button>
								{creating ? (
									<Button variant="ghost" size="sm" onClick={cancelCreate}>{t("common.cancel")}</Button>
								) : (
									<Button variant="outline" size="sm" className="text-destructive" onClick={removeSelected} disabled={saving}>
										<Trash2 size={13} />
										{selectedItem?.ownedByWritable ? t("common.delete") : t("config.mcp.disableInstead")}
									</Button>
								)}
							</div>
							{probe ? (
								<div className={`rounded-sm border px-2.5 py-2 text-micro ${probe.ok ? "border-[var(--color-success)]/30 text-[var(--color-success)]" : "border-danger/20 text-danger"}`}>
									{probe.ok ? `${t("config.mcp.probeOk")} · ${probe.detail}` : `${t("config.mcp.probeFail")} · ${probe.error}`}
								</div>
							) : null}
						</>
					)}
				</div>
			</div>
			)}
		</div>
	);
});
