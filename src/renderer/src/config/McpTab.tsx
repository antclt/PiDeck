/**
 * Pi 配置管理 → MCP 页（全局作用域）与项目资源管理器 → MCP 页（项目作用域）共用。
 * 作用域由 props.scope 决定：全局页写 ~/.pi/agent/mcp.json，项目页写所选项目 .pi/mcp.json
 * （均经主进程信任门禁与项目边界校验）。不启动 MCP 运行时；轻量探测仅检查 command 是否在
 * PATH / HTTP 是否可达，真实连接检测走 `pi mcp list --json`。
 * pi 0.99.2 语义：同名条目整体替换；`enabled` 是唯一启停字段；auth.provider 是供应商登录模式。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Trash2, PlugZap, RefreshCw, Radio, LogIn, LogOut, TriangleAlert } from "lucide-react";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Switch } from "../components/ui-shadcn/switch";
import { Label } from "../components/ui-shadcn/label";
import { Textarea } from "../components/ui-shadcn/textarea";
import { ConfigSelect, openDocsInSystemBrowser, SecretInput } from "./ConfigShared";
import { ConfirmDialog } from "../components/ui-shadcn/ConfirmDialog";
import { detectThirdPartyMcpExtensions, hasLegacyDisabledField, inferMcpTransport, isMcpServerDisabled, McpServerListPane, usesMcpOAuth, usesProviderAuth, type ThirdPartyMcpExtension } from "./McpResourceViews";
import { argsToText, buildMcpDisplayServers, isMcpServerName, recordToText, textToArgs, textToRecord } from "./mcpForm";
import { resolveExposureAliases } from "../../../shared/mcpExposure";
import type { McpCliListResult, McpConfigFile, McpConfigScope, McpConfigSnapshot, McpExposure, McpOAuth, McpProbeResult, McpServerDefinition, McpServerListItem, McpServerTransport } from "../../../shared/types/mcp";
import { ResourceImportDialog } from "./ResourceImportDialog";

const api = (
	window as unknown as {
		piDesktop: {
			config: {
				getMcp: (scope?: McpConfigScope) => Promise<McpConfigSnapshot>;
				saveMcp: (data: McpConfigFile, scope?: McpConfigScope) => Promise<{ valid: boolean; error?: string }>;
				probeMcp: (definition: McpServerDefinition) => Promise<McpProbeResult>;
				/** pi mcp CLI：真实连接检测 + OAuth 登录/登出（仅命令路线，见计划 M2）。 */
				mcpListStatus: (scope?: McpConfigScope) => Promise<McpCliListResult>;
				mcpLogin: (server: string, timeoutSec?: number, scope?: McpConfigScope, operationId?: string) => Promise<{ ok: boolean; output: string }>;
				mcpLogout: (server: string, scope?: McpConfigScope) => Promise<{ ok: boolean; output: string }>;
				onMcpLoginUrl: (callback: (payload: { server: string; scope?: McpConfigScope; operationId?: string; url: string }) => void) => () => void;
			};
			app: {
				openExternal: (url: string, forceSystem?: boolean) => Promise<void> | void;
			};
		};
	}
).piDesktop;

const MCP_DOCS = "https://earendil-works.github.io/pi/docs/mcp";
const EMPTY_FILE: McpConfigFile = { mcpServers: {} };

/**
 * exposure 选项：0.99.2 起 `codemode-deferred` 归一为 `codemode` 别名，
 * 新表单只提供四个 canonical 值；旧文件里已有的别名仍能读。
 */
type ExposureLabelKey = "config.mcp.exposure.codemode" | "config.mcp.exposure.deferred" | "config.mcp.exposure.direct" | "config.mcp.exposure.hidden";
const EXPOSURE_OPTIONS: Array<{ value: McpExposure; labelKey: ExposureLabelKey }> = [
	{ value: "codemode", labelKey: "config.mcp.exposure.codemode" },
	{ value: "deferred", labelKey: "config.mcp.exposure.deferred" },
	{ value: "direct", labelKey: "config.mcp.exposure.direct" },
	{ value: "hidden", labelKey: "config.mcp.exposure.hidden" },
];

const TRANSPORT_OPTIONS: Array<{ value: McpServerTransport; labelKey: "config.mcp.transport.stdio" | "config.mcp.transport.http" }> = [
	{ value: "stdio", labelKey: "config.mcp.transport.stdio" },
	{ value: "http", labelKey: "config.mcp.transport.http" },
];

export type McpTabHandle = {
	save: () => Promise<boolean>;
	reload: () => Promise<void>;
};

function blankDefinition(transport: McpServerTransport): McpServerDefinition {
	if (transport === "http") return { url: "https://" };
	return { command: "npx", args: ["-y"] };
}

/** toolExposure 编辑行的稳定草稿（保存时才构建有序对象）。 */
type ToolExposureRow = { rowId: string; pattern: string; exposure: McpExposure };

/** URL 的 userinfo/query 可能含凭据：停用覆盖不能把它们复制进项目层。 */
function urlHasSensitiveParts(url: string): boolean {
	try {
		const parsed = new URL(url);
		return Boolean(parsed.username || parsed.password || parsed.search);
	} catch {
		return false;
	}
}

/**
 * 为「在本层停用继承条目」构造最小有效定义：pi 要求 `enabled:false` 仍带有效传输，
 * 且不复制 headers/env/oauth/auth 等可能含凭据的字段。
 */
function buildInheritedDisableOverride(definition: McpServerDefinition): { definition: McpServerDefinition; sensitive: boolean } {
	if (typeof definition.url === "string" && definition.url.trim()) {
		if (urlHasSensitiveParts(definition.url)) return { definition: { enabled: false }, sensitive: true };
		const next: McpServerDefinition = { url: definition.url, enabled: false };
		if (definition.type === "http" || definition.type === "streamable-http") next.type = definition.type;
		return { definition: next, sensitive: false };
	}
	if (typeof definition.command === "string" && definition.command.trim()) {
		return { definition: { command: definition.command, enabled: false }, sensitive: false };
	}
	return { definition: { enabled: false }, sensitive: false };
}

export const McpTab = forwardRef<
	McpTabHandle,
	{
		/** 未设置 = 全局页；设置 = 项目资源管理器打开的项目作用域。 */
		projectId?: string;
		projectName?: string;
		/** 导入对话框的项目来源：扫描激活项目里的 Claude/Codex MCP 配置（Chat 项目由主进程过滤）。 */
		activeProjectId?: string;
		/** 「去扩展页」由父层导航（本页不掌握 UI 路由），保留当前作用域。 */
		onGoToExtensions?: () => void;
		onDirtyChange: (dirty: boolean) => void;
	}
>(function McpTab(props, ref) {
	const { projectId, projectName, activeProjectId, onDirtyChange } = props;
	/**
	 * 作用域对象：主进程按注册 projectId 解析，渲染层不传路径。
	 * 必须 memo —— 它进 load 的依赖，每次渲染新建对象会让 load 身份变化、effect 重跑，
	 * 用磁盘内容覆盖正在编辑的草稿（表现为“输入的内容自己消失”）。
	 */
	const scope: McpConfigScope | undefined = useMemo(() => (projectId ? { scope: "project", projectId } : undefined), [projectId]);
	/**
	 * 脏回调同样不能进 load 依赖：调用方传内联箭头时身份每次都变，同样会触发重载覆盖草稿。
	 * 用 ref 取最新值，load 不再依赖调用方是否把回调 memo 化。
	 */
	const onDirtyChangeRef = useRef(onDirtyChange);
	useEffect(() => {
		onDirtyChangeRef.current = onDirtyChange;
	}, [onDirtyChange]);
	const isProjectScope = Boolean(projectId);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [snapshot, setSnapshot] = useState<McpConfigSnapshot | null>(null);
	const [writable, setWritable] = useState<McpConfigFile>(EMPTY_FILE);
	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState<{ name: string; definition: McpServerDefinition } | null>(null);
	const [probe, setProbe] = useState<McpProbeResult | null>(null);
	const [probing, setProbing] = useState(false);
	/** pi mcp list --json 的真实连接状态（「检测连接」按钮触发）。 */
	const [status, setStatus] = useState<McpCliListResult | null>(null);
	const [statusLoading, setStatusLoading] = useState(false);
	const [statusError, setStatusError] = useState<string | null>(null);
	/** 登录进行中的 server 名（同一时间只允许一个登录动作，pi 侧一次只处理一个回调端口）。 */
	const [loggingInServer, setLoggingInServer] = useState<string | null>(null);
	/** 登录过程中捕获的授权 URL（内嵌兑底链接，不弹 toast；见计划 M6）。 */
	const [loginUrl, setLoginUrl] = useState<{ server: string; url: string } | null>(null);
	/** 最近一次登录/登出结果（行内展示 output 尾部；新动作会覆盖）。 */
	const [loginResult, setLoginResult] = useState<{ server: string; ok: boolean; output: string } | null>(null);
	/** 待确认登出的 server：登出会删除同一 URL 共享的凭据，必须二次确认。 */
	const [logoutConfirm, setLogoutConfirm] = useState<string | null>(null);
	/** 第三方接管型 MCP 扩展（pi-mcp-adapter 等）识别结果；null = 探测失败（横幅降级，不阻塞编辑）。 */
	const [thirdPartyMcp, setThirdPartyMcp] = useState<ThirdPartyMcpExtension[] | null>(null);
	const loadGenerationRef = useRef(0);
	/** 当前登录操作的绑定身份：只有同一次操作的 URL 事件才能更新登录区域。 */
	const loginOperationRef = useRef<{ operationId: string; server: string } | null>(null);

	/** 脏状态上报父层（标题栏保存按钮与关闭确认依赖它）。 */
	const markDirty = useCallback(() => onDirtyChangeRef.current(true), []);

	/**
	 * 识别接管型第三方 MCP 扩展（pi-mcp-adapter 等）；失败返回 null 由调用方降级。
	 * pi 0.99 起 mcp.json 由内置 MCP 读取，这类扩展会让内置 MCP 失效，横幅给卸载命令。
	 */
	const probeThirdParty = useCallback(async (): Promise<ThirdPartyMcpExtension[] | null> => {
		try {
			const list = await window.piDesktop.extensions.list();
			return detectThirdPartyMcpExtensions(list.extensions);
		} catch {
			// 扩展 API 不可用时（如预览环境）不阻塞配置浏览或编辑。
			return null;
		}
	}, []);

	const load = useCallback(async () => {
		const generation = ++loadGenerationRef.current;
		setLoading(true);
		setError(null);
		setProbe(null);
		try {
			const thirdPartyState = await probeThirdParty();
			if (generation !== loadGenerationRef.current) return;
			const next = await api.config.getMcp(scope);
			if (generation !== loadGenerationRef.current) return;
			setThirdPartyMcp(thirdPartyState);
			setSnapshot(next);
			setWritable(next.writableFile.mcpServers ? next.writableFile : { ...next.writableFile, mcpServers: {} });
			onDirtyChangeRef.current(false);
			setCreating(null);
			const names = next.servers.map((item) => item.name);
			setSelected((current) => (current && names.includes(current) ? current : (names[0] ?? null)));
		} catch (caught) {
			if (generation === loadGenerationRef.current) {
				setError(caught instanceof Error ? caught.message : String(caught));
			}
		} finally {
			if (generation === loadGenerationRef.current) setLoading(false);
		}
	}, [probeThirdParty, scope]);

	useEffect(() => {
		void load();
		return () => {
			// A late response after unmount must never replace the current snapshot.
			loadGenerationRef.current += 1;
		};
	}, [load]);

	const displayServers = useMemo(() => (snapshot ? buildMcpDisplayServers(snapshot, writable) : []), [snapshot, writable]);
	/** 使用供应商登录（auth.provider）的 server：不使用 MCP OAuth，登录/登出按钮不适用。 */
	const providerAuthServerNames = useMemo(() => new Set(displayServers.filter((item) => usesProviderAuth(item.definition)).map((item) => item.name)), [displayServers]);

	// 切换 server 或重新加载后清掉 toolExposure 草稿行，避免把上一台的编辑串到下一台。
	useEffect(() => {
		setToolExposureOverride(null);
	}, [selected, creating]);

	const selectedItem = displayServers.find((item) => item.name === selected) ?? null;
	const editingDef: McpServerDefinition = creating ? creating.definition : (selectedItem?.definition ?? blankDefinition("stdio"));
	const transport = inferMcpTransport(editingDef);
	/**
	 * 表单的**展示与预选值**用归一后的定义：兼容别名 `codemode-deferred` 不归一就会落到
	 * ConfigSelect 的「自定义」兜底里、把原字符串当档位显示。
	 * 只用于显示/预选：草稿与落盘仍保留原文，不主动改写用户文件。
	 */
	const editingDisplayDef = useMemo(() => resolveExposureAliases(editingDef), [editingDef]);

	const applyWritable = useCallback(
		(next: McpConfigFile) => {
			setWritable(next);
			markDirty();
		},
		[markDirty],
	);

	const upsert = useCallback(
		(name: string, definition: McpServerDefinition) => {
			applyWritable({
				...writable,
				mcpServers: { ...(writable.mcpServers ?? {}), [name]: definition },
			});
		},
		[applyWritable, writable],
	);

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
			onDirtyChangeRef.current(false);
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

	/** OAuth 子字段变更：全部为空时整键删除，避免落盘 `oauth: {}`。 */
	const patchOauth = (patch: Partial<McpOAuth>) => {
		const current = editingDef.oauth ?? {};
		const next = { ...current, ...patch };
		const hasValue = Object.values(next).some((value) => value !== undefined);
		patchEditing({ oauth: hasValue ? next : undefined });
	};

	/**
	 * toolExposure 编辑行：用稳定的 rowId 作 React key，名称/暴露方式分开编辑，
	 * 保存时才构建有序对象。不能把可编辑名称当 key，否则每个字符输入都会重建行、丢焦点；
	 * 也不能每键入一次就删除重建原 map，对象顺序是 pi 的匹配顺序（首个命中优先）。
	 */
	const toolExposureRows = useMemo<ToolExposureRow[]>(() => {
		const base = editingDisplayDef.toolExposure ?? {};
		return Object.entries(base).map(([pattern, exposure]) => ({ rowId: `row-${pattern}`, pattern, exposure }));
	}, [editingDisplayDef.toolExposure]);
	const [toolExposureOverride, setToolExposureOverride] = useState<ToolExposureRow[] | null>(null);
	const rows = toolExposureOverride ?? toolExposureRows;
	const commitToolExposureRows = (next: ToolExposureRow[]) => {
		setToolExposureOverride(next);
		const trimmed = next.filter((row) => row.pattern.trim().length > 0);
		if (trimmed.length !== next.length) return;
		const record: Record<string, McpExposure> = {};
		for (const row of trimmed) {
			const pattern = row.pattern;
			if (!pattern || pattern in record) return;
			record[pattern] = row.exposure;
		}
		patchEditing({ toolExposure: Object.keys(record).length > 0 ? record : undefined });
	};
	const addToolExposureRow = () => {
		let index = rows.length;
		const taken = new Set(rows.map((row) => row.pattern));
		while (taken.has(`tool_${index}`)) index += 1;
		setToolExposureOverride([...rows, { rowId: `new-${Date.now()}-${index}`, pattern: `tool_${index}`, exposure: "direct" }]);
	};

	const switchTransport = (next: McpServerTransport) => {
		const kept = {
			exposure: editingDef.exposure,
			enabled: editingDef.enabled,
			timeout: editingDef.timeout,
			env: editingDef.env,
			headers: editingDef.headers,
			oauth: editingDef.oauth,
		};
		const nextDef = { ...blankDefinition(next), ...kept };
		if (creating) {
			setCreating({ ...creating, definition: nextDef });
			markDirty();
			return;
		}
		if (selected) upsert(selected, nextDef);
	};

	/**
	 * 在本层停用/启用一个条目。
	 * - 本层已有条目：停用写 `enabled:false`、启用**删键**（pi 自己的 updateMcpServerConfig 就是这样）。
	 * - 继承自其他层（项目页里来自全局）：停用写「有效的最小停用定义」——必须有有效传输，
	 *   因为 pi 对 `{enabled:false}` 这种无传输条目直接判非法并跳过；不复制 headers/env/oauth/auth 凭据。
	 */
	const toggleDisabled = (item: McpServerListItem, disabled: boolean) => {
		const existing = writable.mcpServers?.[item.name];
		if (existing) {
			const { disabled: _ignored, ...kept } = existing as McpServerDefinition & { disabled?: unknown };
			upsert(item.name, disabled ? { ...kept, enabled: false } : kept);
			return;
		}
		if (!disabled) return;
		const inherit = buildInheritedDisableOverride(item.definition);
		if (inherit.sensitive) {
			setError(t("config.mcp.inherited.sensitiveUrl"));
			return;
		}
		upsert(item.name, inherit.definition);
	};

	const removeSelected = () => {
		if (!selected) return;
		const item = selectedItem;
		const nextServers = { ...(writable.mcpServers ?? {}) };
		if (item?.ownedByWritable) {
			// 本层定义：真正删除条目（项目页删除覆盖后重新继承全局定义）。
			delete nextServers[selected];
			applyWritable({ ...writable, mcpServers: nextServers });
		} else if (item) {
			// 继承条目：入口按钮是「恢复继承」/「在本项目停用」，不在这里静默改其他层。
			const inherit = buildInheritedDisableOverride(item.definition);
			if (inherit.sensitive) {
				setError(t("config.mcp.inherited.sensitiveUrl"));
				return;
			}
			upsert(selected, inherit.definition);
		}
		const remaining = displayServers.filter((entry) => entry.name !== selected);
		setSelected(remaining[0]?.name ?? null);
		setProbe(null);
	};

	/** 恢复继承：删除本层同名覆盖，重新使用下层定义。 */
	const restoreInherited = () => {
		if (!selected || !snapshot) return;
		const nextServers = { ...(writable.mcpServers ?? {}) };
		if (!(selected in nextServers)) return;
		delete nextServers[selected];
		applyWritable({ ...writable, mcpServers: nextServers });
		const inherited = snapshot.servers.find((entry) => entry.name === selected);
		setSelected(inherited ? selected : (displayServers.find((entry) => entry.name !== selected)?.name ?? null));
		setProbe(null);
	};

	/** 继承条目在本层是否已有覆盖（用于显示「恢复继承」）。 */
	const hasLocalOverride = Boolean(selected && writable.mcpServers && selected in writable.mcpServers);

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

	/** 有未保存草稿时不允许运行检测/登录：CLI 读的是磁盘配置，不能显示草稿的结果。 */
	const blockedByDraft = (): boolean => {
		const dirty = Boolean(snapshot && JSON.stringify(writable) !== JSON.stringify(snapshot.writableFile)) || Boolean(creating);
		if (dirty) setStatusError(t("config.mcp.draftBlocked"));
		return dirty;
	};

	/** 真实连接检测：spawn `pi mcp list --json`（exit 1 不算失败，stdout 仍是合法报告）。 */
	const runStatusCheck = async () => {
		if (blockedByDraft()) return;
		setStatusLoading(true);
		setStatusError(null);
		try {
			setStatus(await api.config.mcpListStatus(scope));
		} catch (caught) {
			setStatus(null);
			setStatusError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setStatusLoading(false);
		}
	};

	/** OAuth 登录：授权 URL 经 onMcpLoginUrl 推送（内嵌在按钮行里），成功后刷新状态。 */
	const runLogin = async (server: string) => {
		if (blockedByDraft()) return;
		// 每次登录一个独立 operationId：迟到/跨作用域的结果不会覆盖当前登录区域。
		const operationId = `mcp-login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		loginOperationRef.current = { operationId, server };
		setLoggingInServer(server);
		setLoginUrl(null);
		const unsubscribe = api.config.onMcpLoginUrl((payload) => {
			const expected = loginOperationRef.current;
			if (!expected || payload.operationId !== expected.operationId) return;
			if (payload.server === server) setLoginUrl(payload);
		});
		try {
			const result = await api.config.mcpLogin(server, 240, scope, operationId);
			if (result.ok) {
				// 凭据生效时机（pi 行为）：运行中的会话不会立刻重连，下一轮对话自动使用新凭据。
				showNotice(t("config.mcp.oauth.loginOk"), 5000, "info");
				await runStatusCheck();
			}
			setLoginResult({ server, ok: result.ok, output: result.output });
		} catch (caught) {
			setLoginResult({ server, ok: false, output: caught instanceof Error ? caught.message : String(caught) });
		} finally {
			unsubscribe();
			if (loginOperationRef.current?.operationId === operationId) loginOperationRef.current = null;
			setLoggingInServer(null);
			setLoginUrl(null);
		}
	};

	const runLogout = async (server: string) => {
		try {
			const result = await api.config.mcpLogout(server, scope);
			setLoginResult({ server, ok: result.ok, output: result.output });
			if (result.ok) await runStatusCheck();
		} catch (caught) {
			setLoginResult({ server, ok: false, output: caught instanceof Error ? caught.message : String(caught) });
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
			const result = await api.config.saveMcp(toSave, scope);
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
	}, [creating, displayServers, load, scope, snapshot?.writableError, writable]);

	useImperativeHandle(ref, () => ({ save, reload: load }), [save, load]);

	const layerLabel = useMemo(
		() => ({
			"pi-agent": t("config.mcp.layer.piAgent"),
			"project-pi": t("config.mcp.layer.projectPi"),
		}),
		[],
	);

	if (loading && !snapshot) {
		return (
			<div className="flex items-center justify-center gap-2 py-12 text-control text-muted-foreground">
				<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
				{t("common.loading")}
			</div>
		);
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<strong>{t("config.nav.mcp")}</strong>
					<p className="mt-1 text-micro text-muted-foreground">{t("config.mcp.hint")}</p>
					<p className="mt-1 text-micro text-muted-foreground">{t("config.restartHint")}</p>
					<a href={MCP_DOCS} className="mt-1 inline-block text-micro text-primary hover:underline" onClick={openDocsInSystemBrowser(MCP_DOCS)}>
						{t("config.mcp.docs")}
					</a>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || saving}>
						<RefreshCw size={14} />
						{t("common.refresh")}
					</Button>
					<ResourceImportDialog kind="mcp" sourceProjectId={activeProjectId} triggerLabel={t("config.import.button")} onImported={() => void load()} />
					<Button size="sm" onClick={startCreate} disabled={saving || Boolean(creating)}>
						<Plus size={14} />
						{t("config.mcp.add")}
					</Button>
				</div>
			</div>

			{error ? <div className="rounded-sm border border-danger/20 bg-danger-soft px-3 py-2 text-control text-danger">{error}</div> : null}
			{snapshot?.writableError ? <div className="rounded-sm border border-danger/20 bg-danger-soft px-3 py-2 text-control text-danger">{t("config.mcp.writableBroken")}</div> : null}

			{thirdPartyMcp !== null && thirdPartyMcp.length > 0 ? (
				// 第三方接管型 MCP 扩展横幅：一句话后果 + 一句可复制卸载命令（计划 M5 文案口径）。
				thirdPartyMcp.map((item) => (
					<div key={item.source} className="rounded-md border border-[var(--color-warning,#d97706)]/40 bg-[color-mix(in_srgb,var(--color-warning,#d97706)_8%,var(--color-bg-panel))] px-3 py-2">
						<div className="flex items-center gap-1.5 text-control font-medium">
							<TriangleAlert size={14} className="text-[var(--color-warning,#d97706)]" />
							{item.enabled ? t("config.mcp.thirdParty.title", { source: item.source }) : t("config.mcp.thirdParty.titleDisabled", { source: item.source })}
						</div>
						<p className="mt-1 text-micro text-muted-foreground">{item.enabled ? t("config.mcp.thirdParty.desc") : t("config.mcp.thirdParty.descDisabled")}</p>
						<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
							{item.isLocalFile ? (
								<span className="font-mono text-micro text-muted-foreground">{t("config.mcp.thirdParty.localFileHint")}</span>
							) : (
								<>
									<code className="rounded-sm border border-border-subtle bg-bg-hover px-2 py-1 font-mono text-micro">{item.uninstallCommand}</code>
									<Button variant="outline" size="xs" onClick={() => void window.piDesktop.clipboard.writeText(item.uninstallCommand)}>
										{t("config.mcp.thirdParty.copyCommand")}
									</Button>
								</>
							)}
							<Button variant="ghost" size="xs" onClick={() => props.onGoToExtensions?.()}>
								{t("config.mcp.thirdParty.goToExtensions")}
							</Button>
						</div>
					</div>
				))
			) : thirdPartyMcp === null ? (
				// 扩展列表探测失败：不阻塞配置区，仅提示。
				<p className="text-micro text-muted-foreground">{t("config.mcp.thirdParty.detectFailed")}</p>
			) : null}

			<div className="flex flex-wrap gap-1.5">
				{(snapshot?.layers ?? []).map((layer) => (
					<span key={layer.kind} className={`rounded-sm border px-1.5 py-0.5 font-mono text-micro ${layer.exists ? "border-border-subtle text-text-secondary" : "border-dashed border-border-subtle text-muted-foreground"}`} title={layer.path}>
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

			{/* 真实连接检测（pi mcp list --json）：配置正确 ≠ 能连上，这里给出 state/tools/errors。 */}
			<div className="rounded-md border border-border-subtle bg-bg-panel p-2.5">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-1.5 text-control font-medium">
						<Radio size={14} />
						{t("config.mcp.status.title")}
					</div>
					<Button variant="outline" size="sm" onClick={() => void runStatusCheck()} disabled={statusLoading || saving} title={statusError === t("config.mcp.draftBlocked") ? t("config.mcp.draftBlocked") : undefined}>
						{statusLoading ? t("config.mcp.status.checking") : t("config.mcp.status.check")}
					</Button>
				</div>
				{statusError ? <p className="mt-2 text-micro text-danger">{statusError}</p> : null}
				{status ? (
					<div className="mt-2 grid gap-1.5">
						{status.servers.map((server) => (
							<div key={server.name} className="rounded-sm border border-border-subtle px-2.5 py-1.5">
								<div className="flex flex-wrap items-center gap-2">
									<span className={`size-1.5 shrink-0 rounded-full ${server.state === "connected" ? "bg-[var(--color-success)]" : server.state === "needs-auth" ? "bg-[var(--color-warning,#d97706)]" : server.state === "disabled" ? "bg-muted-foreground" : "bg-danger"}`} aria-hidden="true" />
									<span className="text-control font-medium">{server.name}</span>
									<span className="text-micro text-muted-foreground">
										{server.state === "connected" ? t("config.mcp.status.connected", { count: server.tools.length }) : server.state === "needs-auth" ? t("config.mcp.status.needsAuth") : server.state === "disabled" ? t("config.mcp.status.disabled") : t("config.mcp.status.disconnected")}
									</span>
									<span className="text-micro text-muted-foreground">· {server.exposure}</span>
									{providerAuthServerNames.has(server.name) ? (
										// provider-auth 不是 MCP OAuth：不能提示再去 MCP 登录，也不能在这里登出。
										<span className="text-micro text-muted-foreground">{t("config.mcp.providerAuth.statusHint")}</span>
									) : (
										<>
											{server.state === "needs-auth" ? (
												loggingInServer === server.name ? (
													<span className="text-micro text-muted-foreground">{t("config.mcp.oauth.loggingIn")}</span>
												) : (
													<Button variant="outline" size="xs" onClick={() => void runLogin(server.name)}>
														<LogIn size={12} />
														{t("config.mcp.oauth.login")}
													</Button>
												)
											) : null}
											{server.transport.startsWith("http") ? (
												<Button variant="ghost" size="xs" onClick={() => setLogoutConfirm(server.name)}>
													<LogOut size={12} />
													{t("config.mcp.oauth.logout")}
												</Button>
											) : null}
										</>
									)}
								</div>
								{loggingInServer === server.name ? (
									<div className="mt-1 flex flex-wrap items-center gap-1.5 text-micro text-muted-foreground">
										<span>{t("config.mcp.status.loginPending")}</span>
										{loginUrl?.server === server.name ? (
											<button type="button" className="text-primary underline underline-offset-2" onClick={() => void window.piDesktop.app.openExternal(loginUrl.url, true)}>
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
						))}
						{status.servers.length === 0 ? <p className="text-micro text-muted-foreground">{t("config.mcp.status.empty")}</p> : null}
						{status.errors.map((message, index) => (
							<p key={index} className="rounded-sm border border-danger/20 px-2 py-1 text-micro text-danger">
								{message}
							</p>
						))}
						{status.note ? <p className="text-micro text-muted-foreground">{status.note}</p> : null}
					</div>
				) : null}
				{/* 登录/登出/检测结果始终显示：此前只在状态列表缺少该 server 时渲染，常见失败被吞掉。 */}
				{loginResult ? (
					<p className={`mt-2 break-all text-micro ${loginResult.ok ? "text-[var(--color-success)]" : "text-danger"}`}>
						{loginResult.server}: {loginResult.output || (loginResult.ok ? t("config.mcp.oauth.done") : t("config.mcp.oauth.failed"))}
					</p>
				) : null}
			</div>

			<div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,280px)_minmax(0,1fr)] gap-3 max-[820px]:grid-cols-1">
				<McpServerListPane
					servers={displayServers}
					selected={selected}
					creating={Boolean(creating)}
					onSelect={(name) => {
						setSelected(name);
						setProbe(null);
					}}
				/>

				<div className="flex min-h-0 flex-col gap-3 overflow-auto rounded-md border border-border-subtle bg-bg-panel p-3">
					{!selected && !creating ? (
						<div className="py-8 text-center text-micro text-muted-foreground">{t("config.mcp.selectHint")}</div>
					) : (
						<>
							<div className="grid gap-2">
								<Label>{t("config.mcp.field.name")}</Label>
								<Input
									value={creating ? creating.name : (selected ?? "")}
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
								<ConfigSelect value={transport} options={TRANSPORT_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))} onChange={(value) => switchTransport(value as McpServerTransport)} />
							</div>
							{transport === "stdio" ? (
								<>
									<div className="grid gap-2">
										<Label>{t("config.mcp.field.command")}</Label>
										<Input value={editingDef.command ?? ""} onChange={(event) => patchEditing({ command: event.target.value, url: undefined })} className="h-8 font-mono" placeholder="npx" />
									</div>
									<div className="grid gap-2">
										<Label>{t("config.mcp.field.args")}</Label>
										<Input value={argsToText(editingDef.args)} onChange={(event) => patchEditing({ args: textToArgs(event.target.value) })} className="h-8 font-mono" placeholder="-y chrome-devtools-mcp@1.6.0" />
									</div>
									<div className="grid gap-2">
										<Label>{t("config.mcp.field.cwd")}</Label>
										<Input value={editingDef.cwd ?? ""} onChange={(event) => patchEditing({ cwd: event.target.value || undefined })} className="h-8 font-mono" />
									</div>
								</>
							) : null}
							{transport === "http" ? (
								<>
									<div className="grid gap-2">
										<Label>{t("config.mcp.field.url")}</Label>
										<Input value={editingDef.url ?? ""} onChange={(event) => patchEditing({ url: event.target.value, command: undefined, args: undefined })} className="h-8 font-mono" placeholder="https://mcp.example.com/mcp" />
									</div>
									<div className="grid gap-2">
										<Label>{t("config.mcp.field.headers")}</Label>
										<Textarea value={recordToText(editingDef.headers)} onChange={(event) => patchEditing({ headers: textToRecord(event.target.value) })} placeholder={t("config.mcp.field.headersPlaceholder")} className="min-h-20 font-mono text-control" />
									</div>
									{usesProviderAuth(editingDef) ? (
										<div className="rounded-sm border border-border-subtle p-2.5">
											<div className="text-control font-medium">{t("config.mcp.providerAuth.section")}</div>
											<p className="mt-0.5 text-micro text-muted-foreground">{t("config.mcp.providerAuth.hint", { provider: editingDef.auth?.provider ?? "" })}</p>
										</div>
									) : (
										<div className="rounded-sm border border-border-subtle p-2.5">
											<div className="text-control font-medium">{t("config.mcp.oauth.section")}</div>
											<p className="mb-2 mt-0.5 text-micro text-muted-foreground">{t("config.mcp.oauth.sectionHint")}</p>
											<div className="grid gap-2">
												<div className="grid gap-1">
													<Label>{t("config.mcp.oauth.clientId")}</Label>
													<Input value={editingDef.oauth?.clientId ?? ""} onChange={(event) => patchOauth({ clientId: event.target.value || undefined })} className="h-8 font-mono" />
												</div>
												<div className="grid gap-1">
													<Label>{t("config.mcp.oauth.clientSecret")}</Label>
													<SecretInput value={editingDef.oauth?.clientSecret ?? ""} onChange={(value) => patchOauth({ clientSecret: value || undefined })} placeholder={t("config.mcp.oauth.secretPlaceholder")} />
												</div>
												<div className="grid gap-1">
													<Label>{t("config.mcp.oauth.clientName")}</Label>
													<Input value={editingDef.oauth?.clientName ?? ""} onChange={(event) => patchOauth({ clientName: event.target.value || undefined })} className="h-8 font-mono" placeholder="pi" />
													<p className="text-micro text-muted-foreground">{t("config.mcp.oauth.clientNameHint")}</p>
												</div>
												<div className="grid gap-1">
													<Label>{t("config.mcp.oauth.callbackPort")}</Label>
													<Input
														value={editingDef.oauth?.callbackPort === undefined ? "" : String(editingDef.oauth.callbackPort)}
														onChange={(event) => {
															const raw = event.target.value.trim();
															if (raw === "") {
																patchOauth({ callbackPort: undefined });
																return;
															}
															const parsed = Number(raw);
															if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) patchOauth({ callbackPort: parsed });
														}}
														className="h-8 font-mono"
														placeholder="8765"
														inputMode="numeric"
													/>
												</div>
												<div className="grid gap-1">
													<Label>{t("config.mcp.oauth.callbackUrl")}</Label>
													<Input value={editingDef.oauth?.callbackUrl ?? ""} onChange={(event) => patchOauth({ callbackUrl: event.target.value || undefined })} className="h-8 font-mono" placeholder="http://127.0.0.1:8765/callback" />
													<p className="text-micro text-muted-foreground">{t("config.mcp.oauth.callbackUrlHint")}</p>
												</div>
												<div className="grid gap-1">
													<Label>{t("config.mcp.oauth.scope")}</Label>
													<Input value={editingDef.oauth?.scope ?? ""} onChange={(event) => patchOauth({ scope: event.target.value || undefined })} className="h-8 font-mono" placeholder="read:project write:project" />
													<p className="text-micro text-muted-foreground">{t("config.mcp.oauth.scopeHint")}</p>
												</div>
												<div className="grid gap-1">
													<Label>{t("config.mcp.oauth.authServerMetadataUrl")}</Label>
													<Input value={editingDef.oauth?.authServerMetadataUrl ?? ""} onChange={(event) => patchOauth({ authServerMetadataUrl: event.target.value || undefined })} className="h-8 font-mono" placeholder="https://auth.example.com/.well-known/oauth-authorization-server" />
													<p className="text-micro text-muted-foreground">{t("config.mcp.oauth.authServerMetadataUrlHint")}</p>
												</div>
												<div className="grid gap-1">
													<Label>{t("config.mcp.oauth.clientRegistration")}</Label>
													<Input value={editingDef.oauth?.clientRegistration ?? ""} onChange={(event) => patchOauth({ clientRegistration: event.target.value === "dcr" || event.target.value === "cimd" ? event.target.value : undefined })} className="h-8 font-mono" placeholder="dcr" />
													<p className="text-micro text-muted-foreground">{t("config.mcp.oauth.clientRegistrationHint")}</p>
												</div>
											</div>
										</div>
									)}
								</>
							) : null}
							<div className="grid gap-2">
								<Label>{t("config.mcp.field.exposure")}</Label>
								<ConfigSelect value={editingDisplayDef.exposure ?? "codemode"} options={EXPOSURE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))} onChange={(value) => patchEditing({ exposure: value as McpExposure })} />
								<p className="text-micro text-muted-foreground">{t("config.mcp.exposureHint")}</p>
							</div>
							<div className="rounded-sm border border-border-subtle p-2.5">
								<div className="flex items-center justify-between gap-2">
									<div>
										<div className="text-control font-medium">{t("config.mcp.toolExposure.section")}</div>
										<p className="mt-0.5 text-micro text-muted-foreground">{t("config.mcp.toolExposure.sectionHint")}</p>
									</div>
									<Button variant="outline" size="xs" onClick={addToolExposureRow}>
										<Plus size={13} />
										{t("config.mcp.toolExposure.add")}
									</Button>
								</div>
								{rows.map((row) => (
									<div key={row.rowId} className="mt-2 flex items-center gap-1.5">
										<Input value={row.pattern} onChange={(event) => commitToolExposureRows(rows.map((entry) => (entry.rowId === row.rowId ? { ...entry, pattern: event.target.value } : entry)))} className="h-8 min-w-0 flex-1 font-mono" placeholder="get_*" />
										<ConfigSelect
											value={row.exposure}
											options={EXPOSURE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
											onChange={(value) => commitToolExposureRows(rows.map((entry) => (entry.rowId === row.rowId ? { ...entry, exposure: value as McpExposure } : entry)))}
											triggerClassName="w-36 shrink-0"
										/>
										<Button
											variant="ghost"
											size="icon-sm"
											className="size-7 shrink-0 text-muted-foreground"
											onClick={() => {
												const next = rows.filter((entry) => entry.rowId !== row.rowId);
												setToolExposureOverride(next.length > 0 ? next : null);
												patchEditing({ toolExposure: next.length > 0 ? Object.fromEntries(next.map((entry) => [entry.pattern, entry.exposure])) : undefined });
											}}
											title={t("common.delete")}
										>
											<Trash2 size={13} />
										</Button>
									</div>
								))}
								{rows.length === 0 ? <p className="mt-1.5 text-micro text-muted-foreground">{t("config.mcp.toolExposure.empty")}</p> : null}
							</div>
							<div className="grid gap-2">
								<Label>{t("config.mcp.field.timeout")}</Label>
								<Input
									value={editingDef.timeout === undefined ? "" : String(editingDef.timeout)}
									onChange={(event) => {
										const raw = event.target.value.trim();
										// 留空 = 用 pi 默认（60s）；只接受 >0 的有限秒数，无效输入不回写。
										if (raw === "") {
											patchEditing({ timeout: undefined });
											return;
										}
										const parsed = Number(raw);
										if (Number.isFinite(parsed) && parsed > 0) patchEditing({ timeout: parsed });
									}}
									className="h-8 font-mono"
									placeholder="60"
									inputMode="numeric"
								/>
								<p className="text-micro text-muted-foreground">{t("config.mcp.timeoutHint")}</p>
							</div>
							{transport === "stdio" ? (
								<div className="grid gap-2">
									<Label>{t("config.mcp.field.env")}</Label>
									<Textarea value={recordToText(editingDef.env)} onChange={(event) => patchEditing({ env: textToRecord(event.target.value) })} placeholder={t("config.mcp.field.envPlaceholder")} className="min-h-20 font-mono text-control" />
								</div>
							) : null}
							<div className="flex items-center justify-between gap-3 rounded-sm border border-border-subtle px-2.5 py-2">
								<div>
									<div className="text-control font-medium">{t("config.mcp.field.enabled")}</div>
									<div className="text-micro text-muted-foreground">{t("config.mcp.field.enabledHint")}</div>
								</div>
								<Switch
									checked={!isMcpServerDisabled(editingDef)}
									onCheckedChange={(checked) => {
										// pi 0.99 内置 MCP 只认 `enabled`：启用删键、停用写 false（不写 adapter 的 disabled）。
										if (creating) {
											if (checked) {
												const { enabled: _ignored, ...kept } = creating.definition as McpServerDefinition & { enabled?: unknown };
												setCreating({ ...creating, definition: kept });
											} else {
												patchEditing({ enabled: false });
											}
											markDirty();
											return;
										}
										if (selectedItem) toggleDisabled(selectedItem, !checked);
									}}
								/>
							</div>
							{selectedItem && !creating ? (
								<p className="text-micro text-muted-foreground" title={selectedItem.originPath}>
									{t("config.mcp.origin")}: {selectedItem.originPath}
									{selectedItem.ownedByWritable ? "" : ` · ${t("config.mcp.inheritedHint")}`}
								</p>
							) : null}
							{/* 继承条目（项目页里来自全局）只能覆盖/停用，不能在这里删除或编辑全局定义。 */}
							{isProjectScope && selectedItem && !creating && !selectedItem.ownedByWritable ? (
								<div className="flex flex-wrap items-center gap-1.5 rounded-sm border border-border-subtle bg-bg-hover px-2.5 py-2">
									<Button variant="outline" size="xs" onClick={() => toggleDisabled(selectedItem, true)} disabled={saving}>
										{t("config.mcp.disableInherited")}
									</Button>
									<Button variant="ghost" size="xs" onClick={restoreInherited} disabled={saving || !hasLocalOverride}>
										{t("config.mcp.restoreInherited")}
									</Button>
								</div>
							) : null}
							<div className="flex flex-wrap items-center gap-1.5">
								<Button variant="outline" size="sm" onClick={() => void runProbe()} disabled={probing || saving}>
									<PlugZap size={14} />
									{probing ? t("config.mcp.probing") : t("config.mcp.probe")}
								</Button>
								{creating ? (
									<Button variant="ghost" size="sm" onClick={cancelCreate}>
										{t("common.cancel")}
									</Button>
								) : (
									<Button variant="outline" size="sm" className="text-destructive" onClick={removeSelected} disabled={saving}>
										<Trash2 size={13} />
										{selectedItem?.ownedByWritable ? t("common.delete") : t("config.mcp.disableInstead")}
									</Button>
								)}
							</div>
							{probe ? <div className={`rounded-sm border px-2.5 py-2 text-micro ${probe.ok ? "border-[var(--color-success)]/30 text-[var(--color-success)]" : "border-danger/20 text-danger"}`}>{probe.ok ? `${t("config.mcp.probeOk")} · ${probe.detail}` : `${t("config.mcp.probeFail")} · ${probe.error}`}</div> : null}
						</>
					)}
				</div>
			</div>
			{logoutConfirm ? (
				<ConfirmDialog
					title={t("config.mcp.oauth.logoutConfirmTitle")}
					message={t("config.mcp.oauth.logoutConfirmBody", { name: logoutConfirm })}
					confirmLabel={t("config.mcp.oauth.logout")}
					danger
					onConfirm={() => {
						const server = logoutConfirm;
						setLogoutConfirm(null);
						void runLogout(server);
					}}
					onCancel={() => setLogoutConfirm(null)}
				/>
			) : null}
		</div>
	);
});
