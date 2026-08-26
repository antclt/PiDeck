/**
 * Session IPC handlers: session list, catalog, runtime management, importers.
 * Phase 3.7: extracted from src/main/index.ts registerIpc().
 */

import { ipcMain, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { isDshPermissionPreset } from "../../shared/types/agent";
import { canonicalizeSessionPath } from "../../shared/sessionIdentity";
import type {
	CreateSessionDraftInput,
	CreateAnonymousSessionInput,
	CreateAnonymousSessionResult,
	UpdateSessionRecordInput,
	SendSessionPromptInput,
	SessionUiResponseInput,
	SessionRuntimeTarget,
	SessionRuntimeInfo,
	SessionRuntimeReplacement,
	SessionRuntimeEvent,
	SessionCommandError,
	SessionCommandResult,
	SendPromptInput,
	SendPromptResult,
	SessionRecord,
	SessionProcessEvent,
	DshModelDiscoveryInput,
	FetchedModel,
	SessionMessagePage,
} from "../../shared/types";
import { parseSessionProcessEvents } from "../sessions/sessionProcessEvents";
import { BackgroundScanCoordinator } from "../sessions/BackgroundScanCoordinator";

function isDshModelDiscoveryInput(input: unknown): input is DshModelDiscoveryInput {
	if (!isRecord(input) || typeof input.settingsNs !== "string" || !input.settingsNs.trim()) return false;
	return ["provider", "baseURL", "api", "apiKey"].every((key) => {
		const value = input[key];
		return value === undefined || typeof value === "string";
	});
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}
/**
 * 已扫描过项目的集合（模块级）：决定 catalogList 走「首次同步扫描」还是
 * 「缓存先回显 + 后台扫描推送」。进程生命周期内单调增长，无需清理。
 */
const scannedProjects = new Set<string>();

/** 后台目录扫描协调器：同项目触发去重 + 冷却合并（3 秒轮询不会演变成并发重扫）。 */
const catalogScanCoordinator = new BackgroundScanCoordinator(5000);

/**
 * 供主进程装配层（启动预扫描）触发的后台扫描调度入口。
 * 标记项目为已扫描，保证预热后首次展开项目走缓存回显路径。
 */
export function scheduleCatalogBackgroundScan(projectId: string, task: () => Promise<void>): boolean {
	scannedProjects.add(projectId);
	return catalogScanCoordinator.schedule(projectId, task);
}
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import { SessionCommandIpcError } from "../sessions/SessionCommandIpcError";
import type { AgentManager } from "../pi/AgentManager";
import type { ConfigManager } from "../config/ConfigManager";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";
import type { CodexSessionImporter } from "../sessions/CodexSessionImporter";
import type { ClaudeSessionImporter } from "../sessions/ClaudeSessionImporter";
import type { OpenCodeSessionImporter } from "../sessions/OpenCodeSessionImporter";
import type { AppLogger } from "../logging/AppLogger";

/**
 * DSH 后端专用 IPC 依赖（C1 分组）：按后端收敛可选注入，为「后端注册表」铺路——
 * 未来新增后端时各自提供一份 BackendIpcDeps，装配层按 backendId 查注册表注入，
 * 而不是在 SessionIpcDeps 上继续堆可选字段。未装配（dshBackend undefined）= 无 DSH
 * 后端，相关通道降级返回空/错误。
 */
export type DshBackendIpcDeps = {
	/** DSH host 级模型目录；未装配时返回空列表。 */
	listDshModels?: () => Promise<import("../../shared/types").AvailableModel[]>;
	/** DSH 配置页模型发现（llm.discoverModels；只返回候选，不写配置）。 */
	discoverDshModels?: (input: DshModelDiscoveryInput) => Promise<FetchedModel[]>;
	/** DSH 可配置提供方目录（内置 catalog + 已注册路由）；未装配时返回空列表。 */
	listDshProviders?: () => Promise<Array<{
		provider: string;
		displayName: string;
		active: boolean;
		declared?: boolean;
	}>>;
	/** DSH agent 预设目录（agentPreset.list）；未装配时返回空列表。 */
	listDshAgentPresets?: () => Promise<Array<{
		id: string;
		trust: "system" | "user";
		isDefault: boolean;
		name?: string;
		description?: string;
		broken?: string;
	}>>;
	/** DSH 部署默认模型选择（settings.yaml agent-default-model）；未装配/不可读时 undefined。 */
	getDshDefaultModel?: () => Promise<{
		provider: string;
		model: string;
		reasoningEffort?: string;
	} | undefined>;
	/** DSH 配置管理页状态；未装配时返回空状态。 */
	getDshStatus?: () => Promise<{
		started: boolean;
		homeDir: string;
	}>;
	/** DSH settings.describe（脱敏 namespace 视图 + schema）。 */
	describeDshSettings?: () => Promise<{
		writable: boolean;
		hasDocument: boolean;
		namespaces: Array<{
			ns: string;
			applies: string;
			revision: number;
			value: unknown;
			user?: unknown;
			secrets: Array<{ path: string[]; set: boolean }>;
			schema: unknown;
		}>;
	}>;
	/** DSH settings.update。 */
	updateDshSettings?: (
		ns: string,
		patch: Record<string, unknown>,
		expectedRevision?: number,
	) => Promise<unknown>;
	/** DSH settings.mutate（路径级操作；删除 provider/字段用 unset op）。 */
	mutateDshSettings?: (
		ns: string,
		ops: Array<
			| { op: "set"; path: string[]; value: unknown }
			| { op: "unset"; path: string[] }
		>,
		expectedRevision?: number,
	) => Promise<unknown>;
	/** DSH credentials.describe。 */
	describeDshCredentials?: (refs: string[]) => Promise<Record<string, {
		configured: boolean;
		source?: string;
		writable: boolean;
	}>>;
	/** DSH credentials.set。 */
	setDshCredential?: (ref: string, value: string) => Promise<void>;
	/** DSH credentials.unset。 */
	unsetDshCredential?: (ref: string) => Promise<void>;
	/** DSH 凭证明文读取（渲染层点「眼睛」时按 ref 取一次；无值返回 undefined）。 */
	readDshCredential?: (ref: string) => Promise<string | undefined>;
	/** DSH settings.openDocument（平台打开配置文档）。 */
	openDshDocument?: () => Promise<void>;
	/** DSH host 重启；返回 false 表示有活跃 DSH 会话被拒绝。 */
	restartDshHost?: () => Promise<boolean>;
	/** DSH 历史分页（session.history 事件流翻页）；未装配时返回空页。 */
	readDshHistoryPage?: (
		dshSessionId: string,
		beforeSeq: number | undefined,
		pageSize: number,
	) => Promise<{ messages: import("../../shared/types").ChatMessage[]; total: number; nextBefore: number | null }>;
	/** DSH 轨迹过程事件（运行时会话按 mux/重放收集；历史会话从 host history 推导；未装配时返回空数组）。 */
	readDshProcessEvents?: (
		agentId: string | undefined,
		dshSessionId: string | undefined,
	) => Promise<import("../../shared/types/trajectory").SessionProcessEvent[]>;
	/** DSH 轨迹系统提示（运行时会话读投影缓存；历史会话从 host history 折叠 request/header；未装配返回 undefined）。 */
	readDshSystemPrompt?: (
		agentId: string | undefined,
		dshSessionId: string | undefined,
	) => Promise<string | undefined>;
	/** DSH 「查看完整输出」（工具结果全文随投影消息存 meta.fullText）；未装配时抛错。 */
	readDshMessageFullText?: (
		agentId: string,
		messageId: string,
	) => Promise<{ text: string }>;
	/** DSH 会话文件路径推导（按 catalog entry 的 dshSessionId + cwd）；未装配/不可推导返回 undefined。 */
	resolveDshSessionFilePath?: (sessionId: string) => Promise<string | undefined>;
	/** DSH 会话内容搜索（session.search）；未装配时返回空列表。 */
	searchDshSessions?: (query: string) => Promise<Array<{ sessionId: string; snippet: string }>>;
	/** DSH 创建目标（G5）；未装配时抛错。 */
	createDshGoal?: (agentId: string, objective: string, maxGoalRounds?: number) => Promise<void>;
	/** DSH 目标操作（G5：pause/resume/complete/clear）；未装配时抛错。 */
	runDshGoalAction?: (
		agentId: string,
		action: "pause" | "resume" | "complete" | "clear",
	) => Promise<void>;
	/** DSH 子代理列表（G6）；未装配时返回空列表。 */
	listDshSubagents?: (agentId: string) => Promise<Array<{
		id: string;
		label?: string;
		activity: "running" | "inactive";
		hasChildren: boolean;
		mode: "one-shot" | "continuable";
		kind: "child" | "diagnostic";
	}>>;
	/** DSH 子代理历史（G6）；未装配时返回空页。 */
	readDshSubagentHistory?: (
		agentId: string,
		childSessionId: string,
		beforeSeq?: number,
		maxMessages?: number,
	) => Promise<{ messages: import("../../shared/types").ChatMessage[]; hasMore: boolean }>;
	/** DSH 技能目录（G7：skill.list 只读）；未装配时返回空列表。 */
	listDshSkills?: (agentId: string) => Promise<import("../../shared/types").DshSkillView[]>;
	/** DSH 孤儿会话 id 列表（G3/D11：host 有但 catalog 无映射）；未装配时返回空列表。 */
	listDshOrphans?: () => Promise<string[]>;
	/** DSH 外部会话清单（dsh-web 等其他工具创建的 host 根会话）；未装配时返回空列表。 */
	listDshForeignSessions?: () => Promise<Array<{
		dshSessionId: string;
		title?: string;
		cwd?: string;
		updatedAt?: number;
	}>>;
	/** DSH 外部会话导入：按 host 会话 id 映射进 catalog（返回新 SessionRecord）。 */
	importDshForeignSession?: (dshSessionId: string) => Promise<import("../../shared/types").SessionRecord>;
	/** DSH 外部会话全量同步（磁盘扫描：catalog 未映射的根会话全部导入）；未装配时返回空统计。 */
	syncDshForeignSessions?: () => Promise<{ imported: number; skipped: number }>;
	/** DSH 会话归档（G14：host 目录移入 .pideck-archive + manifest）；未装配时抛错。 */
	archiveDshSession?: (dshSessionId: string, cwd: string) => Promise<string | undefined>;
	/** DSH 会话恢复（G14：目录按 manifest 移回 sessions 树，返回恢复路径与原 cwd）；未装配时抛错。 */
	unarchiveDshSession?: (dshSessionId: string) => Promise<{ restoredPath: string; cwd: string } | undefined>;
	/** DSH 归档区会话清单（G14：恢复入口用）；未装配时返回空列表。 */
	listArchivedDshSessions?: () => Array<{ dshSessionId: string; cwd: string; archivedAt: number }>;
	/** DSH 动态插件清单（G13 深化）；未装配时返回空列表。 */
	listDshDynamicPlugins?: () => Promise<import("../../shared/types").DshPluginView[]>;
	/** DSH 静态 Loader 条目清单（只读）；未装配时返回空列表。 */
	listDshStaticPlugins?: () => Promise<import("../../shared/types").DshStaticPluginView[]>;
	/** DSH 动态插件安装（define）；未装配时抛错。 */
	installDshPlugin?: (input: import("../../shared/types").DshPluginInstallInput) => Promise<unknown>;
	/** DSH 动态插件运行（面板手势）；未装配时抛错。 */
	runDshPlugin?: (input: import("../../shared/types").DshPluginLifecycleInput) => Promise<unknown>;
	/** DSH 动态插件停止；未装配时抛错。 */
	stopDshPlugin?: (input: import("../../shared/types").DshPluginLifecycleInput) => Promise<unknown>;
	/** DSH 动态插件卸载（undefine）；未装配时抛错。 */
	uninstallDshPlugin?: (input: import("../../shared/types").DshPluginLifecycleInput) => Promise<unknown>;
	/** 判断 agentId 是否属于 DSH 后端（fork 等 pi 专属命令按 backend 分流）。 */
	isDshAgent: (agentId: string) => boolean;
	/** DSH fork：session.fork 裁剪 + runtime 换绑 + catalog dshSessionId 回写。 */
	forkDshAgentSession?: (
		target: SessionRuntimeTarget,
		entryId: string,
	) => Promise<Record<string, unknown> & { targetSessionId?: string }>;
	/** DSH clone：fork 无锚点（完整副本）+ runtime 换绑 + catalog dshSessionId 回写。 */
	cloneDshAgentSession?: (
		target: SessionRuntimeTarget,
	) => Promise<Record<string, unknown> & { targetSessionId?: string }>;
};

export type SessionIpcDeps = {
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	sessionScanner: SessionScanner;
	sessionCatalog: SessionCatalog;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	agentManager: AgentManager;
	configManager: ConfigManager;
	codexSessionImporter: CodexSessionImporter;
	claudeSessionImporter: ClaudeSessionImporter;
	openCodeSessionImporter: OpenCodeSessionImporter;
	appLogger: AppLogger;
	terminalManager: TerminalSessionManager;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	getMainWindow: () => BrowserWindow | null;
	emitSessionRuntimeEvent: (agentId: string, channel: string, payload: unknown) => boolean;
	emitSessionRuntimeDetach: (target: SessionRuntimeTarget) => void;
	createAnonymousSession: (input: CreateAnonymousSessionInput) => Promise<CreateAnonymousSessionResult>;
	stopSessionRuntime: (target: SessionRuntimeTarget) => void;
	emitReplacementState: (runtime: SessionRuntimeInfo, includeMessages: boolean) => void;
	readCatalogSessionReferenceMessages: (sessionId: string) => Promise<unknown[]>;
	/**
	 * 无 pi 会话文件的会话（纯生图草稿）历史读取：回退 ImageSession 独立存储。
	 * 未装配（单测/无生图域）时 undefined；调用处 `?? []` 兜底空页。
	 */
	readImageSessionMessages?: (
		sessionId: string,
	) => Promise<import("../../shared/types").ChatMessage[]>;
	copyCatalogSession: (
		sessionId: string,
	) => Promise<{ cancelled: boolean; targetSessionId?: string }>;
	exportCatalogSessionHtml: (sessionId: string) => Promise<Record<string, unknown> & { path: string }>;
	replaceAgentSession: (agentId: string, fn: () => Promise<any>) => Promise<any>;
	/** DSH 后端专用 IPC 依赖（C1 分组；未装配 = 无 DSH 后端）。 */
	dshBackend?: DshBackendIpcDeps;
};

function sessionCommandIpcError(
	error: SessionCommandError,
	appLogger: Pick<AppLogger, "warn">,
	mainCopy: (key: string, params?: Record<string, string | number>) => string,
): SessionCommandIpcError {
	logSessionCommandFailure(appLogger, error);
	return new SessionCommandIpcError(error, mainCopy);
}

/**
 * 会话命令失败日志：edit/delete/resend 等 IPC 直接返回 SessionCommandResult，
 * 不走 sessionCommandIpcError 抛错，漏打这条就会出现「toast 失败、主进程无日志」。
 */
function logSessionCommandFailure(
	appLogger: Pick<AppLogger, "warn">,
	error: SessionCommandError,
	extra?: Record<string, unknown>,
): void {
	if (!error.debugDetails && extra === undefined) return;
	void appLogger.warn("session-command", "Session command failed", {
		code: error.code,
		...(error.debugDetails ? { debugDetails: error.debugDetails } : {}),
		...extra,
	});
}

async function handleSessionCommandResult<T>(
	appLogger: Pick<AppLogger, "warn">,
	operation: string,
	target: SessionRuntimeTarget,
	extra: Record<string, unknown>,
	run: () => Promise<SessionCommandResult<T>>,
): Promise<SessionCommandResult<T>> {
	const result = await run();
	if (!result.ok) {
		logSessionCommandFailure(appLogger, result.error, {
			operation,
			sessionId: target.sessionId,
			agentId: target.agentId,
			runtimeGeneration: target.runtimeGeneration,
			...extra,
		});
	}
	return result;
}

export function registerSessionIpc(deps: SessionIpcDeps): void {
	const {
		projectStore,
		settingsStore,
		sessionScanner,
		sessionCatalog,
		sessionRuntimeCoordinator,
		agentManager,
		configManager,
		codexSessionImporter,
		claudeSessionImporter,
		openCodeSessionImporter,
		appLogger,
		terminalManager,
		mainCopy,
		getMainWindow,
		emitSessionRuntimeEvent,
		emitSessionRuntimeDetach,
		createAnonymousSession,
		stopSessionRuntime,
		emitReplacementState,
		readCatalogSessionReferenceMessages,
		// 无 pi 会话文件（纯生图草稿）历史读取回退：ImageSession 独立存储
		readImageSessionMessages,
		copyCatalogSession,
		exportCatalogSessionHtml,
		replaceAgentSession,
		dshBackend,
	} = deps;
	// C1：DSH 后端依赖从 dshBackend 分组解构（未装配 = 空对象，相关通道降级）。
	const {
		listDshModels,
		discoverDshModels,
		listDshProviders,
		listDshAgentPresets,
		getDshDefaultModel,
		getDshStatus,
		describeDshSettings,
		updateDshSettings,
		mutateDshSettings,
		describeDshCredentials,
		setDshCredential,
		unsetDshCredential,
		readDshCredential,
		openDshDocument,
		restartDshHost,
		readDshHistoryPage,
		readDshProcessEvents,
		readDshSystemPrompt,
		readDshMessageFullText,
		resolveDshSessionFilePath,
		searchDshSessions,
		createDshGoal,
		runDshGoalAction,
		listDshSubagents,
		readDshSubagentHistory,
		listDshSkills,
		listDshOrphans,
		listDshForeignSessions,
		importDshForeignSession,
		syncDshForeignSessions,
		archiveDshSession,
		unarchiveDshSession,
		listArchivedDshSessions,
		listDshDynamicPlugins,
		listDshStaticPlugins,
		installDshPlugin,
		runDshPlugin,
		stopDshPlugin,
		uninstallDshPlugin,
		isDshAgent = () => false,
		forkDshAgentSession,
		cloneDshAgentSession,
	} = dshBackend ?? {};

	/**
	 * 历史页读取后把文件里的最后模型/思考档位补回 catalog。
	 * 仅补缺失字段，避免旧历史读取覆盖用户后来明确选择的值；运行中 runtime
	 * 有自己的 state，历史回放不参与覆盖。
	 */
	const backfillHistoricalSessionMetadata = async (
		sessionId: string,
		metadata: Pick<SessionMessagePage, "model" | "thinkingLevel">,
	): Promise<void> => {
		if (sessionRuntimeCoordinator.getTarget(sessionId)) return;
		const entry = sessionCatalog.get(sessionId);
		if (!entry || entry.backend === "dsh" || !entry.filePath) return;
		if (entry.model && entry.thinkingLevel) return;
		if (!metadata.model && !metadata.thinkingLevel) return;
		try {
			const current = sessionCatalog.get(sessionId);
			if (!current || current.backend === "dsh" || !current.filePath) return;
			const patch: {
				model?: { provider: string; modelId: string };
				thinkingLevel?: string;
				updatedAt: number;
			} = { updatedAt: current.updatedAt };
			if (!current.model && metadata.model) patch.model = { ...metadata.model };
			if (!current.thinkingLevel && metadata.thinkingLevel) {
				patch.thinkingLevel = metadata.thinkingLevel;
			}
			if (!patch.model && patch.thinkingLevel === undefined) return;
			const updated = await sessionCatalog.update(sessionId, patch);
			const window = getMainWindow();
			if (window && !window.isDestroyed()) {
				window.webContents.send(ipcChannels.sessionsCatalogRefreshed, {
					projectId: updated.projectId,
				});
			}
		} catch (error) {
			void appLogger.warn("session", "Historical session metadata backfill failed", {
				sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	ipcMain.handle(
		ipcChannels.sessionsList,
		async (_event, projectId?: string) => {
			const project = projectId ? projectStore.get(projectId) : undefined;
			let projectPath = project?.path;
			// WSL 模式：将 Windows 项目路径转为 WSL /mnt/ 格式，
			// 使 WSL 会话（CWD = /mnt/c/...）能正确匹配到项目。
			if (projectPath && settingsStore.get().wslEnabled && settingsStore.get().wslDistro) {
				projectPath = projectPath
					.replace(/^([A-Za-z]):\\/, (_: string, d: string) => `/mnt/${d.toLowerCase()}/`)
					.replace(/\\/g, '/');
			}
			return sessionScanner.list(projectPath);
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogList,
		async (_event, projectId: string, options?: { scan?: boolean }) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(mainCopy("project.notFound"));
			let projectPath = project.path;
			const settings = settingsStore.get();
			if (settings.wslEnabled && settings.wslDistro) {
				projectPath = projectPath
					.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`)
					.replace(/\\/g, "/");
			}
			const { wslEnabled, wslDistro, wslUser } = settings;

			// 扫描 + 合并 + 运行时绑定（首次同步路径与后台路径共用）
			const runScanAndMerge = async (): Promise<SessionRecord[]> => {
				const summaries = await sessionScanner.list(projectPath);
				const records = await sessionCatalog.mergeScanned(
					projectId,
					summaries,
					wslEnabled ? { wslDistro, wslUser } : {},
				);
				const bindings = sessionRuntimeCoordinator.attachCatalogRuntimes(records);
				for (const binding of bindings) {
					const tab = agentManager.list().find((candidate) => candidate.id === binding.agentId);
					if (tab) emitSessionRuntimeEvent(tab.id, ipcChannels.agentsState, tab);
				}
				return records;
			};

			// 目录缓存中的现有记录（上次扫描/运行时创建的合并结果，启动时从磁盘加载）
			const cachedRecords = sessionCatalog.listEntries()
				.filter((entry) => entry.projectId === projectId)
				.map((entry) => sessionCatalog.getRecord(entry.id))
				.filter((record): record is SessionRecord => Boolean(record));

			// 纯读路径：事件回调/订阅刷新专用，不再触发扫描（防止推送-拉取循环触发）
			if (options?.scan === false) return cachedRecords;

			// 一律先回磁盘 catalog：打包正式 userData 的历史 JSONL 远多于 dev，
			// 首次 await 全量扫描会让侧栏「正在加载历史会话」卡住整窗。
			// 无缓存时回 []，渲染层保持 loading，等 catalog-refreshed 再揭开。
			scannedProjects.add(projectId);
			catalogScanCoordinator.schedule(projectId, async () => {
				try {
					await runScanAndMerge();
				} catch (error) {
					void appLogger.warn("session", "Background catalog scan failed", {
						projectId,
						error: error instanceof Error ? error.message : String(error),
					});
				} finally {
					// 成功/失败都通知渲染层：空项目不能永远转圈，失败也要让 UI 可操作。
					const window = getMainWindow();
					if (window && !window.isDestroyed()) {
						window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId });
					}
				}
			});
			return cachedRecords;
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogCreateDraft,
		async (_event, input: CreateSessionDraftInput) => {
			const project = projectStore.get(input.projectId);
			if (!project) throw new Error(mainCopy("project.notFound"));
			// Auto-fill model / thinkingLevel from pi config when the caller hasn't
			// provided them, so the composer bar shows the effective default.
			// DSH 后端不适用 pi 的模型配置（模型路由由 DSH host 自己的 settings 决定），
			// 只跳过 model；思考档位值域与 DSH 兼容（off/high/max 等），新会话默认档位
			// 同样填充——否则 DSH 新会话的思考按钮只显示「思考」而非实际默认档位。
			let model = input.backend === "dsh" ? undefined : input.model;
			let thinkingLevel = input.thinkingLevel;
			if ((input.backend !== "dsh" && !model) || !thinkingLevel) {
				try {
					const [settingsResult, modelsResult] = await Promise.all([
						configManager.getSettingsConfig(),
						configManager.getModelsConfig(),
					]);
					const settings = settingsResult.parsed;
					if (input.backend !== "dsh" && !model) {
						const defaultProvider = typeof settings.defaultProvider === "string"
							? settings.defaultProvider
							: undefined;
						const defaultModelId = typeof settings.defaultModel === "string"
							? settings.defaultModel
							: undefined;
						if (defaultProvider && defaultModelId) {
							model = { provider: defaultProvider, modelId: defaultModelId };
						} else {
							// Fallback: first provider's first model from models.json
							const providers = modelsResult.parsed?.providers;
							if (providers) {
								const firstProviderName = Object.keys(providers)[0];
								const firstProvider = firstProviderName ? providers[firstProviderName] : undefined;
								const firstModel = firstProvider?.models?.[0];
								if (firstProviderName && firstModel?.id) {
									model = { provider: firstProviderName, modelId: firstModel.id };
								}
							}
						}
					}
					if (!thinkingLevel) {
						const level = typeof settings.defaultThinkingLevel === "string"
							? settings.defaultThinkingLevel
							: undefined;
						// pi's schema uses underscore; the runtime and UI use camelCase.
						thinkingLevel = level;
					}
				} catch {
					// Config read is best-effort; draft creation must never block.
				}
			}
			const draft = await sessionCatalog.createDraft({
				projectId: input.projectId,
				title: input.title?.trim() || mainCopy("session.newTitle"),
				environment: settingsStore.get().wslEnabled ? "wsl" : "native",
				// 后端透传：仅接受白名单枚举，其余视为 pi（渲染层不可信输入校验在边界）。
				backend: input.backend === "dsh" ? "dsh" : undefined,
				model,
				thinkingLevel,
			});
			void appLogger.info("session", "Session draft created", {
				sessionId: draft.id,
				projectId: input.projectId,
				title: draft.title,
				model: draft.model,
			});
			return draft;
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCreateAnonymous,
		async (_event, input: CreateAnonymousSessionInput) => {
			const result = await createAnonymousSession(input);
			void appLogger.info("session", "Anonymous session created", {
				sessionId: result.session.id,
				projectId: input.projectId,
			});
			return result;
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogUpdate,
		async (_event, sessionId: string, patch: UpdateSessionRecordInput) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry) throw new Error(mainCopy("session.notFound"));
			// 后端锁定（草稿期可改，激活后禁止）：pi 会话文件（JSONL）与 DSH 会话
			// （host session log）格式不同，中途切换会导致消息同步渲染不可靠。
			// 已 active 或已有 runtime 的会话拒绝 backend 变更（渲染层已隐藏入口，这里是边界防御）。
			if (
				patch.backend !== undefined &&
				patch.backend !== entry.backend &&
				(entry.status === "active" || sessionRuntimeCoordinator.getTarget(sessionId))
			) {
				throw new Error(mainCopy("session.backendLocked"));
			}
			// DSH agent 预设同样创建即固定：激活会话的 preset 由 host 会话 header 权威持有，
			// 渲染层只读展示，拒绝任何运行时改写（草稿期预选不受限）。
			if (
				patch.agentPreset !== undefined &&
				patch.agentPreset !== entry.agentPreset &&
				entry.backend === "dsh" &&
				(entry.status === "active" || sessionRuntimeCoordinator.getTarget(sessionId))
			) {
				throw new Error(mainCopy("session.agentPresetLocked"));
			}
			const title = patch.title?.trim();
			if (title && title !== entry.title) {
				const target = sessionRuntimeCoordinator.getTarget(sessionId);
				if (target) {
					const renamed = await sessionRuntimeCoordinator.renameRuntime(target, title);
					if (!renamed.ok) throw sessionCommandIpcError(renamed.error, appLogger, mainCopy);
				} else if (entry.filePath) {
					await sessionScanner.rename(entry.filePath, title);
					void appLogger.info("session", "Session renamed (file)", {
						sessionId,
						oldTitle: entry.title,
						newTitle: title,
					});
				}
			}
			return sessionCatalog.update(sessionId, {
				...patch,
				title: title || undefined,
				// 切到生图后端时甩开 pi 会话文件引用：生图历史独立存 ImageSessionStore，
				// 残留 filePath 会让生图/重发/历史加载误落到不存在的 pi 文件（ENOENT 根因）。
				...(patch.backend === "imagegen" ? { filePath: null, piSessionId: null } : {}),
			});
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogDelete,
		async (_event, sessionId: string) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry) return false;
			// 删除即先杀后删：失败一次/卡在 bound 的会话也能删掉。
			// 仍按路径扫一遍游离 agent，避免只解绑 catalog 却留着进程。
			await sessionRuntimeCoordinator.releaseRuntimeForDelete(sessionId);
			try {
				// DSH 没有 session.delete：host 目录会留在 $DSH_HOME。先记墓碑再删映射，
				// 否则 refreshProjectTree 的自动同步会把同一条再导入。运行中也允许删。
				if (entry.backend === "dsh" && entry.dshSessionId) {
					await sessionCatalog.rememberDismissedDshSession(entry.dshSessionId);
				}
				if (entry.filePath) {
					const normalizedTarget = canonicalizeSessionPath(
						entry.filePath,
						entry.environment,
					);
					const usingAgent = agentManager.list().find((agent) => (
						agent.sessionPath &&
						agent.sessionEnvironment === entry.environment &&
						(entry.environment !== "wsl" || (
							agent.wslDistro === entry.wslDistro &&
							agent.wslUser === entry.wslUser
						)) &&
						canonicalizeSessionPath(agent.sessionPath, entry.environment) === normalizedTarget
					));
					if (usingAgent) {
						await sessionRuntimeCoordinator.stopAgentById(usingAgent.id).catch(() => undefined);
						await agentManager.stop(usingAgent.id).catch(() => undefined);
					}
					await sessionScanner.delete(entry.filePath);
				}
				await sessionCatalog.remove(sessionId);
				void appLogger.info("session", "Catalog session deleted", { sessionId, filePath: entry.filePath });
				return true;
			} catch (error) {
				// 会话删除失败（文件删除失败/记录移除失败/会话使用中拦截）也要留痕，便于事后追踪。
				void appLogger.error("session", "Catalog session delete failed", {
					sessionId,
					filePath: entry.filePath,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogArchive,
		async (_event, sessionId: string) => {
			const entry = sessionCatalog.get(sessionId);
			// DSH 会话归档（G14）：host 目录移入 .pideck-archive（目录移动 + manifest，不销毁数据）。
			// 运行中的会话不能归档（同 pi：移动文件会破坏 host 对当前写入位置的引用）。
			if (entry?.backend === "dsh" && entry.dshSessionId && archiveDshSession) {
				if (
					sessionRuntimeCoordinator.getTarget(sessionId) ||
					sessionRuntimeCoordinator.isActivating(sessionId)
				) {
					throw new Error(mainCopy("session.stopBeforeDelete"));
				}
				const cwd = projectStore.get(entry.projectId)?.path ?? "";
				if (!cwd) throw new Error(mainCopy("project.notFound"));
				const archivedPath = await archiveDshSession(entry.dshSessionId, cwd);
				if (!archivedPath) throw new Error(mainCopy("session.invalidArchivePath"));
				await sessionCatalog.remove(sessionId);
				void appLogger.info("session", "DSH session archived", {
					sessionId,
					dshSessionId: entry.dshSessionId,
					archivedPath,
				});
				return true;
			}
			if (!entry?.filePath) return false;
			// 运行中的会话不能归档（同删除）：移动文件会破坏 pi 对当前写入位置的引用。
			if (
				sessionRuntimeCoordinator.getTarget(sessionId) ||
				sessionRuntimeCoordinator.isActivating(sessionId)
			) {
				throw new Error(mainCopy("session.stopBeforeDelete"));
			}
			const archivedPath = await sessionScanner.archive(entry.filePath);
			await sessionCatalog.remove(sessionId);
			void appLogger.info("session", "Session archived", { sessionId, archivedPath });
			return true;
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogUnarchive,
		async (_event, archivedPath: string) => {
			// 校验入参：归档路径必须是 .pideck-archive 目录内的 JSONL，防路径穿越。
			if (typeof archivedPath !== "string" || !archivedPath.endsWith(".jsonl")) {
				throw new Error(mainCopy("session.invalidArchivePath"));
			}
			const restoredPath = await sessionScanner.unarchive(archivedPath);
			void appLogger.info("session", "Session restored from archive", { restoredPath });
			return true;
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogListArchived,
		async () => sessionScanner.listArchived(),
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogReadMessages,
		async (_event, sessionId: string) => {
			const entry = sessionCatalog.get(sessionId);
			// DSH 会话没有 pi 会话文件：全量读走 host 历史事件流（一次拉最大页），
			// 与分页路径同源；未装配 readDshHistoryPage 时返回空数组。
			if (entry?.backend === "dsh" && entry.dshSessionId && readDshHistoryPage) {
				const page = await readDshHistoryPage(entry.dshSessionId, undefined, 1000);
				return page.messages;
			}
			if (entry?.backend === "imagegen") {
				// imagegen 后端会话：历史独立存 ImageSessionStore，不走 pi 文件
				return (await readImageSessionMessages?.(sessionId)) ?? [];
			}
			if (!entry?.filePath) return [];
			const messages = await agentManager.readSessionDisplayMessages(entry.filePath, sessionId);
			const metadata = await agentManager.readSessionDisplayMetadata(entry.filePath);
			await backfillHistoricalSessionMetadata(sessionId, metadata);
			return messages;
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogReadMessagePage,
		async (_event, sessionId: string, before?: number, pageSize?: number, options?: { beforeEntryId?: string }) => {
			const entry = sessionCatalog.get(sessionId);
			// DSH 会话没有 pi 会话文件：历史浏览走 host 的 session.history 事件流翻页
			// （游标 = 事件 seq），与 pi 的磁盘分页同形状（messages/total/nextBefore）。
			if (entry?.backend === "dsh" && entry.dshSessionId && readDshHistoryPage) {
				return readDshHistoryPage(entry.dshSessionId, before, pageSize ?? 100);
			}
			if (entry?.backend === "imagegen" || !entry?.filePath) {
				// imagegen 后端会话（可能残留无意义 pi filePath）或纯生图草稿：
				// 走 ImageSession 独立存储恢复生图历史，避免落到不存在的 pi 文件
				const imageSessionMessages = (await readImageSessionMessages?.(sessionId)) ?? [];
				if (imageSessionMessages.length > 0) {
					return {
						messages: imageSessionMessages,
						total: imageSessionMessages.length,
						nextBefore: null,
					};
				}
				return { messages: [], total: 0, nextBefore: null };
			}
			// 读盘失败（文件被删/路径失效/解析异常）不能静默：渲染层靠 reject 显示明确错误态，
			// 否则「正在加载历史」骨架无限滞留（2026-08 生图会话文件缺失反馈）。
			try {
				let page: SessionMessagePage;
				// Pi 历史统一按完整轮次分页：磁盘会话首次打开、继续上翻、
				// 以及运行时窗口补历史都共享同一页边界和游标协议。
				// 缓存优先（2026-11）：运行中会话翻历史先在主进程内存缓存切片，命中免文件 IO；
				// 未命中（缓存未覆盖/非活跃会话）回退 SessionHistoryReader 读文件。
				// 注意：缓存按 transient agentId 键控，必须经 coordinator 把稳定 sessionId
				// 解析成当前运行时 agentId；解析不到（非活跃/终端绑定）直接走文件路径。
				if (options?.beforeEntryId || typeof before === "number") {
					const target = sessionRuntimeCoordinator.getTarget(sessionId);
					if (target) {
						const cached = await agentManager.tryReadRuntimeTurnPage(entry.filePath, target.agentId, {
							beforeEntryId: options?.beforeEntryId,
							before,
							turnCount: pageSize,
						}).catch(() => null);
						if (cached) return cached;
					}
				}
				page = await agentManager.readSessionDisplayTurnPage(
					entry.filePath,
					sessionId,
					before,
					pageSize,
					options?.beforeEntryId,
				);
				await backfillHistoricalSessionMetadata(sessionId, page);
				return page;
			} catch (error) {
				// 文件读取失败（被删/路径失效）先查 ImageSession 兜底，命中则直接恢复历史；
				// 都无记录才按失败处理（渲染层显示明确错误态 + 日志）。
				const imageSessionMessages = (await readImageSessionMessages?.(sessionId)) ?? [];
				if (imageSessionMessages.length > 0) {
					return {
						messages: imageSessionMessages,
						total: imageSessionMessages.length,
						nextBefore: null,
					};
				}
				appLogger.warn("session", "Read message page failed", {
					sessionId,
					filePath: entry.filePath,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogReadProcessEvents,
		async (_event, sessionId: string): Promise<SessionProcessEvent[]> => {
			if (typeof sessionId !== "string" || !sessionId.trim()) return [];
			const entry = sessionCatalog.get(sessionId);
			// DSH 会话没有 pi 会话文件：过程事件由运行时会话按 mux/重放收集，
			// 历史（未激活）会话从 host history 事件流推导（轨迹账本的
			// modelChange/permission/plan/goal/compaction 记录）。
			if (entry?.backend === "dsh" && readDshProcessEvents) {
				const target = sessionRuntimeCoordinator.getTarget(sessionId);
				return readDshProcessEvents(target?.agentId, entry.dshSessionId);
			}
			if (!entry?.filePath) return [];
			const content = await sessionScanner.readSessionRawText(entry.filePath);
			return parseSessionProcessEvents(content);
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogReadDshSystemPrompt,
		async (_event, sessionId: string): Promise<string | undefined> => {
			if (typeof sessionId !== "string" || !sessionId.trim()) return undefined;
			const entry = sessionCatalog.get(sessionId);
			// DSH 会话的系统提示由 harness 在请求时组装（persona + sections），PiDeck
			// 只能从 request/header 事件取；运行时会话读投影缓存，历史会话从 host history
			// 折叠（未装配/无数据返回 undefined，轨迹不展示，不阻断）。
			if (entry?.backend === "dsh" && readDshSystemPrompt) {
				const target = sessionRuntimeCoordinator.getTarget(sessionId);
				return readDshSystemPrompt(target?.agentId, entry.dshSessionId);
			}
			return undefined;
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogReadReferenceMessages,
		(_event, sessionId: string) => readCatalogSessionReferenceMessages(sessionId),
	);
	// 按需读取消息完整文本（工具结果截断后的「查看完整输出」）：
	// 入参校验在边界（渲染层数据不可信），agentId/messageId 必须为非空字符串。
	// 运行期路径（agentId 绑定）不可用时（历史会话 _viewer 投影 / agent 已退出）
	// 回退会话文件定位（sessionId → catalog filePath），保证历史浏览同样可展开全文。
	ipcMain.handle(
		ipcChannels.sessionsCatalogReadMessageFullText,
		async (
			_event,
			sessionId: unknown,
			agentId: unknown,
			messageId: unknown,
			entryId?: unknown,
		) => {
			if (
				typeof agentId !== "string" ||
				!agentId.trim() ||
				typeof messageId !== "string" ||
				!messageId.trim()
			) {
				throw new Error("Invalid message full-text request");
			}
			if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId.trim())) {
				throw new Error("Invalid sessionId");
			}
			if (entryId !== undefined && (typeof entryId !== "string" || !entryId.trim())) {
				throw new Error("Invalid entryId");
			}
			try {
				// DSH 会话：工具结果全文随投影消息存内存（meta.fullText），
				// 走 DshAgentManager 直接读取；pi 走运行时缓存/会话文件。
				if (isDshAgent(agentId)) {
					if (!readDshMessageFullText) {
						throw new Error("dsh message full-text is not available");
					}
					return await readDshMessageFullText(agentId, messageId);
				}
				return await agentManager.readMessageFullText(
					agentId,
					messageId,
					entryId as string | undefined,
				);
			} catch (error) {
				if (typeof sessionId === "string" && sessionId.trim()) {
					const record = sessionCatalog.get(sessionId);
					if (record?.filePath) {
						return agentManager.readMessageFullTextFromFile(
							record.filePath,
							messageId,
							entryId as string | undefined,
						);
					}
				}
				throw error;
			}
		},
	);
	// DSH 会话文件路径推导（F5：渲染层右键「复制会话文件路径」，历史会话无运行时 tab 也适用）
	ipcMain.handle(
		ipcChannels.sessionsGetDshSessionPath,
		async (_event, sessionId: unknown): Promise<string | undefined> => {
			if (typeof sessionId !== "string" || !sessionId.trim()) return undefined;
			if (!resolveDshSessionFilePath) return undefined;
			return resolveDshSessionFilePath(sessionId);
		},
	);
	// DSH 会话内容搜索（G9：侧栏搜索框全文搜索，结果按 dshSessionId 映射回 catalog）
	ipcMain.handle(
		ipcChannels.sessionsSearchDsh,
		async (_event, query: unknown): Promise<Array<{ sessionId: string; snippet: string }>> => {
			if (typeof query !== "string" || !query.trim()) return [];
			if (!searchDshSessions) return [];
			return searchDshSessions(query);
		},
	);
	// DSH 目标创建（G5：goal.create）
	ipcMain.handle(
		ipcChannels.dshCreateGoal,
		async (_event, agentId: unknown, objective: unknown, maxGoalRounds?: unknown): Promise<void> => {
			if (typeof agentId !== "string" || typeof objective !== "string") {
				throw new Error("Invalid goal create request");
			}
			if (!createDshGoal) throw new Error("dsh goals are not available");
			await createDshGoal(
				agentId,
				objective,
				typeof maxGoalRounds === "number" ? maxGoalRounds : undefined,
			);
		},
	);
	// DSH 目标操作（G5：pause/resume/complete/clear）
	ipcMain.handle(
		ipcChannels.dshGoalAction,
		async (_event, agentId: unknown, action: unknown): Promise<void> => {
			if (
				typeof agentId !== "string" ||
				(action !== "pause" && action !== "resume" && action !== "complete" && action !== "clear")
			) {
				throw new Error("Invalid goal action request");
			}
			if (!runDshGoalAction) throw new Error("dsh goals are not available");
			await runDshGoalAction(agentId, action);
		},
	);
	// DSH 子代理列表（G6）
	ipcMain.handle(
		ipcChannels.dshListSubagents,
		async (_event, agentId: unknown) => {
			if (typeof agentId !== "string") return [];
			if (!listDshSubagents) return [];
			return listDshSubagents(agentId);
		},
	);
	// DSH 子代理历史（G6）
	ipcMain.handle(
		ipcChannels.dshSubagentHistory,
		async (_event, agentId: unknown, childSessionId: unknown, beforeSeq?: unknown, maxMessages?: unknown) => {
			if (typeof agentId !== "string" || typeof childSessionId !== "string") {
				return { messages: [], hasMore: false };
			}
			if (!readDshSubagentHistory) return { messages: [], hasMore: false };
			return readDshSubagentHistory(
				agentId,
				childSessionId,
				typeof beforeSeq === "number" ? beforeSeq : undefined,
				typeof maxMessages === "number" ? maxMessages : undefined,
			);
		},
	);
	// DSH 技能目录（G7：skill.list 只读；/name 斜杠调用提示由渲染层给）
	ipcMain.handle(
		ipcChannels.dshListSkills,
		async (_event, agentId: unknown) => {
			if (typeof agentId !== "string") return [];
			if (!listDshSkills) return [];
			return listDshSkills(agentId);
		},
	);
	// DSH 孤儿会话列表（G3/D11：host 有但 catalog 无映射，用于清理提示）
	ipcMain.handle(
		ipcChannels.dshListOrphans,
		async (): Promise<string[]> => {
			if (!listDshOrphans) return [];
			return listDshOrphans();
		},
	);
	// DSH 外部会话清单（跨工具兼容，2026-12）：dsh-web 等其他工具创建的 host 根会话，
	// 带标题/cwd，供配置页「导入」把 host 数据映射进 catalog（导入后侧栏可见可加载）。
	// 已映射进 catalog 的会话从清单过滤掉：导入后即从「待导入」列表消失，避免重复导入。
	ipcMain.handle(
		ipcChannels.dshListForeignSessions,
		async (): Promise<Array<{ dshSessionId: string; title?: string; cwd?: string; updatedAt?: number }>> => {
			if (!listDshForeignSessions) return [];
			const items = await listDshForeignSessions();
			const known = new Set(
				sessionCatalog.listEntries()
					.map((entry) => entry.dshSessionId)
					.filter((id): id is string => Boolean(id)),
			);
			const dismissed = sessionCatalog.listDismissedDshSessionIds();
			// 侧栏删过的 host 会话不要出现在「待导入」：否则看起来像没删掉。
			// 归档恢复仍走独立入口，会带 restoreDismissed 清墓碑。
			return items.filter((item) => (
				!known.has(item.dshSessionId) && !dismissed.has(item.dshSessionId)
			));
		},
	);
	// DSH 外部会话导入：按 host 会话 id 建 catalog 映射（status=active，重启保留；
	// 同 dshSessionId 重复导入幂等吸收，见 SessionCatalog.createDraft）。
	ipcMain.handle(
		ipcChannels.dshImportForeignSession,
		async (_event, dshSessionId: unknown): Promise<import("../../shared/types").SessionRecord> => {
			if (typeof dshSessionId !== "string" || !/^session-[A-Za-z0-9-]+$/.test(dshSessionId)) {
				throw new Error(mainCopy("session.invalidArchivePath"));
			}
			if (!importDshForeignSession) throw new Error("DSH session import is not available");
			return importDshForeignSession(dshSessionId);
		},
	);
	// DSH 外部会话全量同步：把 catalog 未映射的磁盘根会话全部导入（不启动 host），
	// 返回 { imported, skipped } 供配置页展示。未装配时返回空统计。
	ipcMain.handle(
		ipcChannels.dshSyncForeignSessions,
		async (): Promise<{ imported: number; skipped: number }> => {
			if (!syncDshForeignSessions) return { imported: 0, skipped: 0 };
			return syncDshForeignSessions();
		},
	);
	// DSH 归档区会话清单（G14：目录已移入 .pideck-archive 的 host 会话，恢复入口用）
	ipcMain.handle(
		ipcChannels.dshListArchived,
		async (): Promise<Array<{ dshSessionId: string; cwd: string; archivedAt: number }>> => {
			if (!listArchivedDshSessions) return [];
			return listArchivedDshSessions();
		},
	);
	// DSH 会话恢复（G14）：目录按 manifest 移回 sessions 树，并重建 catalog 记录
	ipcMain.handle(
		ipcChannels.dshUnarchive,
		async (_event, dshSessionId: unknown): Promise<boolean> => {
			// 入参校验：host 生成的会话 id 固定 "session-" 前缀（host 侧目录名 = sessionId），
			// 白名单正则挡掉路径穿越类输入（渲染层数据不可信，校验在边界）。
			if (typeof dshSessionId !== "string" || !/^session-[A-Za-z0-9-]+$/.test(dshSessionId)) {
				throw new Error(mainCopy("session.invalidArchivePath"));
			}
			if (!unarchiveDshSession) throw new Error("DSH archive restore is not available");
			const restored = await unarchiveDshSession(dshSessionId);
			if (!restored) throw new Error(mainCopy("session.invalidArchivePath"));
			// 重建 catalog 记录：按会话自己的 cwd 匹配或注册项目；没有 cwd 才兑底。
			// 打开会话时 DshAgentManager 用 project.path 当 cwd，挂错项目会 attach 错 workspace。
			const project = restored.cwd
				? (projectStore.findByPath(restored.cwd)
					?? await projectStore.add(
						restored.cwd,
						undefined,
						settingsStore.get().wslEnabled ? "wsl" : "windows",
					))
				: await projectStore.ensureExternalSessionsProject(mainCopy("project.externalSessions"));
			const draft = await sessionCatalog.createDraft({
				projectId: project.id,
				title: mainCopy("session.newTitle"),
				environment: settingsStore.get().wslEnabled ? "wsl" : "native",
				backend: "dsh",
			});
			// 归档恢复是用户明确找回：必须 active，并清掉删除墓碑，否则下次自动同步仍会跳过。
			await sessionCatalog.attachRuntime({
				sessionId: draft.id,
				dshSessionId,
				promoteToActive: true,
				restoreDismissed: true,
			});
			const window = getMainWindow();
			if (window && !window.isDestroyed()) {
				window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: project.id });
			}
			void appLogger.info("session", "DSH session restored from archive", {
				dshSessionId,
				restoredPath: restored.restoredPath,
				projectId: project.id,
			});
			return true;
		},
	);
	// DSH 动态插件管理（G13 深化：进程内临时扩展，define/run/stop/undefine）。
	// 语义校验（idPrefix 规则、源码单侧上限、会话归属）在 host 侧桥插件统一执行；
	// IPC 边界只做第一行类型检查（渲染层数据不可信）。
	ipcMain.handle(
		ipcChannels.dshPluginList,
		async (): Promise<import("../../shared/types").DshPluginView[]> => {
			if (!listDshDynamicPlugins) return [];
			return listDshDynamicPlugins();
		},
	);
	ipcMain.handle(
		ipcChannels.dshPluginStaticList,
		async (): Promise<import("../../shared/types").DshStaticPluginView[]> => {
			if (!listDshStaticPlugins) return [];
			return listDshStaticPlugins();
		},
	);
	ipcMain.handle(
		ipcChannels.dshPluginInstall,
		async (_event, input: unknown): Promise<unknown> => {
			if (typeof input !== "object" || input === null) {
				throw new Error("invalid plugin install payload");
			}
			const record = input as Record<string, unknown>;
			if (
				typeof record.sessionId !== "string" || !record.sessionId ||
				typeof record.idPrefix !== "string" || !record.idPrefix ||
				typeof record.name !== "string" || !record.name.trim() ||
				typeof record.purpose !== "string" || !record.purpose.trim()
			) {
				throw new Error("invalid plugin install payload");
			}
			if (!installDshPlugin) throw new Error("DSH plugin install is not available");
			return installDshPlugin(input as import("../../shared/types").DshPluginInstallInput);
		},
	);
	ipcMain.handle(
		ipcChannels.dshPluginRun,
		async (_event, input: unknown): Promise<unknown> => {
			if (typeof input !== "object" || input === null) {
				throw new Error("invalid plugin lifecycle payload");
			}
			const record = input as Record<string, unknown>;
			if (typeof record.sessionId !== "string" || !record.sessionId || typeof record.pluginId !== "string" || !record.pluginId) {
				throw new Error("invalid plugin lifecycle payload");
			}
			if (!runDshPlugin) throw new Error("DSH plugin run is not available");
			return runDshPlugin(input as import("../../shared/types").DshPluginLifecycleInput);
		},
	);
	ipcMain.handle(
		ipcChannels.dshPluginStop,
		async (_event, input: unknown): Promise<unknown> => {
			if (typeof input !== "object" || input === null) {
				throw new Error("invalid plugin lifecycle payload");
			}
			const record = input as Record<string, unknown>;
			if (typeof record.sessionId !== "string" || !record.sessionId || typeof record.pluginId !== "string" || !record.pluginId) {
				throw new Error("invalid plugin lifecycle payload");
			}
			if (!stopDshPlugin) throw new Error("DSH plugin stop is not available");
			return stopDshPlugin(input as import("../../shared/types").DshPluginLifecycleInput);
		},
	);
	ipcMain.handle(
		ipcChannels.dshPluginUninstall,
		async (_event, input: unknown): Promise<unknown> => {
			if (typeof input !== "object" || input === null) {
				throw new Error("invalid plugin lifecycle payload");
			}
			const record = input as Record<string, unknown>;
			if (typeof record.sessionId !== "string" || !record.sessionId || typeof record.pluginId !== "string" || !record.pluginId) {
				throw new Error("invalid plugin lifecycle payload");
			}
			if (!uninstallDshPlugin) throw new Error("DSH plugin uninstall is not available");
			return uninstallDshPlugin(input as import("../../shared/types").DshPluginLifecycleInput);
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogCopy,
		async (_event, sessionId: string) => {
			const result = await copyCatalogSession(sessionId);
			void appLogger.info("session", "Session copied", {
				sessionId,
				targetSessionId: result.cancelled ? undefined : result.targetSessionId,
			});
			return result;
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogExportHtml,
		async (_event, sessionId: string) => {
			const result = await exportCatalogSessionHtml(sessionId);
			void appLogger.info("session", "Session exported (catalog HTML)", {
				sessionId,
				path: result.path,
			});
			return result;
		},
	);
	// catalog 级消息改写：按 sessionId 操作 JSONL，不要求 live runtime。
	// 运行中必须先停（coordinator 拒绝 SESSION_RUNTIME_BUSY）；入参在边界校验。
	ipcMain.handle(
		ipcChannels.sessionsCatalogEditMessage,
		async (_event, sessionId: unknown, messageId: unknown, newText: unknown, entryId: unknown) => {
			if (typeof sessionId !== "string" || !sessionId.trim()) {
				throw new Error("Invalid catalog edit-message request");
			}
			if (typeof messageId !== "string" || !messageId.trim()) {
				throw new Error("Invalid catalog edit-message request");
			}
			if (typeof newText !== "string") {
				throw new Error("Invalid catalog edit-message request");
			}
			if (entryId !== undefined && typeof entryId !== "string") {
				throw new Error("Invalid catalog edit-message request");
			}
			const result = await sessionRuntimeCoordinator.editCatalogMessage(
				sessionId,
				messageId,
				newText,
				entryId as string | undefined,
			);
			if (!result.ok) {
				logSessionCommandFailure(appLogger, result.error, {
					operation: "editCatalogMessage",
					sessionId,
					messageId,
				});
			}
			return result;
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogDeleteMessage,
		async (_event, sessionId: unknown, messageId: unknown, entryId: unknown) => {
			if (typeof sessionId !== "string" || !sessionId.trim()) {
				throw new Error("Invalid catalog delete-message request");
			}
			if (typeof messageId !== "string" || !messageId.trim()) {
				throw new Error("Invalid catalog delete-message request");
			}
			if (entryId !== undefined && typeof entryId !== "string") {
				throw new Error("Invalid catalog delete-message request");
			}
			const result = await sessionRuntimeCoordinator.deleteCatalogMessage(sessionId, messageId, entryId as string | undefined);
			if (!result.ok) {
				logSessionCommandFailure(appLogger, result.error, {
					operation: "deleteCatalogMessage",
					sessionId,
					messageId,
				});
			}
			return result;
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCatalogPrepareResend,
		async (_event, sessionId: unknown, messageId: unknown, entryId: unknown) => {
			if (typeof sessionId !== "string" || !sessionId.trim()) {
				throw new Error("Invalid catalog prepare-resend request");
			}
			if (typeof messageId !== "string" || !messageId.trim()) {
				throw new Error("Invalid catalog prepare-resend request");
			}
			if (entryId !== undefined && typeof entryId !== "string") {
				throw new Error("Invalid catalog prepare-resend request");
			}
			const result = await sessionRuntimeCoordinator.prepareCatalogResend(sessionId, messageId, entryId as string | undefined);
			if (!result.ok) {
				logSessionCommandFailure(appLogger, result.error, {
					operation: "prepareCatalogResend",
					sessionId,
					messageId,
				});
			}
			return result;
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsSendPrompt,
		async (_event, input: SendSessionPromptInput) => {
			const startedAt = Date.now();
			void appLogger.info("session", "Session prompt IPC received", {
				sessionId: input.sessionId,
				requestId: input.requestId,
				messageLength: input.message.length,
				imageCount: input.images?.length ?? 0,
			});
			try {
				const result = await sessionRuntimeCoordinator.send(input);
				if (result.agentId) {
					const tab = agentManager.list().find((candidate) => candidate.id === result.agentId);
					if (tab) emitSessionRuntimeEvent(tab.id, ipcChannels.agentsState, tab);
				}
				void appLogger.info("session", "Session prompt IPC completed", {
					sessionId: input.sessionId,
					requestId: input.requestId,
					agentId: result.agentId,
					accepted: result.accepted,
					delivery: "delivery" in result ? result.delivery : undefined,
					totalMs: Date.now() - startedAt,
				});
				return result;
			} catch (error) {
				void appLogger.warn("session", "Session prompt IPC failed", {
					sessionId: input.sessionId,
					requestId: input.requestId,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsUiResponse,
		(_event, input: SessionUiResponseInput) => sessionRuntimeCoordinator.respondToUi(input),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeList,
		() => sessionRuntimeCoordinator.listRuntimes(),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeActivate,
		async (_event, sessionId: string) => {
			const startedAt = Date.now();
			void appLogger.info("session-perf", "Runtime activation IPC started", { sessionId });
			const result = await sessionRuntimeCoordinator.activateRuntime(sessionId);
			void appLogger.info("session-perf", "Runtime activation IPC completed", {
				sessionId,
				ok: result.ok,
				activationMs: Date.now() - startedAt,
				// 失败时带错误详情（此前只记 ok:false，排障要翻渲染层 toast）
				...(result.ok ? {} : {
					error: result.error?.debugDetails ?? JSON.stringify(result.error),
				}),
			});
			return result;
		},
	);
	// 渲染层切换会话时汇报聚焦会话；主进程据此判断 Ask 类请求是否需要桌面通知
	ipcMain.handle(
		ipcChannels.sessionsSetFocusedSession,
		(_event, sessionId: unknown) => {
			sessionRuntimeCoordinator.setFocusedSession(
				typeof sessionId === "string" && sessionId.trim()
					? sessionId.trim()
					: undefined,
			);
		},
	);
	ipcMain.handle(
		ipcChannels.dshListModels,
		async () => (listDshModels ? listDshModels() : []),
	);
	ipcMain.handle(
		ipcChannels.dshDiscoverModels,
		async (_event, input: unknown) => {
			if (!isDshModelDiscoveryInput(input)) {
				throw new Error("Invalid DSH model discovery input");
			}
			if (!discoverDshModels) throw new Error("DSH model discovery is not available");
			return discoverDshModels(input);
		},
	);
	ipcMain.handle(
		ipcChannels.dshListProviders,
		async () => (listDshProviders ? listDshProviders() : []),
	);
	ipcMain.handle(
		ipcChannels.dshAgentPresets,
		async () => (listDshAgentPresets ? listDshAgentPresets() : []),
	);
	ipcMain.handle(
		ipcChannels.dshDefaultModel,
		async () => (getDshDefaultModel ? getDshDefaultModel() : undefined),
	);
	ipcMain.handle(
		ipcChannels.dshGetStatus,
		async () => (getDshStatus
			? getDshStatus()
			: { started: false, homeDir: "" }),
	);
	ipcMain.handle(
		ipcChannels.dshConfigDescribe,
		async () => (describeDshSettings
			? describeDshSettings()
			: { writable: false, hasDocument: false, namespaces: [] }),
	);
	ipcMain.handle(
		ipcChannels.dshConfigUpdate,
		async (_event, ns: string, patch: Record<string, unknown>, expectedRevision?: number) => {
			if (!updateDshSettings) throw new Error("DSH settings are not available");
			return updateDshSettings(ns, patch, expectedRevision);
		},
	);
	ipcMain.handle(
		ipcChannels.dshConfigMutate,
		async (
			_event,
			ns: string,
			ops: Array<
				| { op: "set"; path: string[]; value: unknown }
				| { op: "unset"; path: string[] }
			>,
			expectedRevision?: number,
		) => {
			if (!mutateDshSettings) throw new Error("DSH settings are not available");
			return mutateDshSettings(ns, ops, expectedRevision);
		},
	);
	ipcMain.handle(
		ipcChannels.dshCredentialDescribe,
		async (_event, refs: string[]) => (describeDshCredentials ? describeDshCredentials(refs) : {}),
	);
	ipcMain.handle(
		ipcChannels.dshCredentialSet,
		async (_event, ref: string, value: string) => {
			if (!setDshCredential) throw new Error("DSH credentials are not available");
			await setDshCredential(ref, value);
		},
	);
	ipcMain.handle(
		ipcChannels.dshCredentialUnset,
		async (_event, ref: string) => {
			if (!unsetDshCredential) throw new Error("DSH credentials are not available");
			await unsetDshCredential(ref);
		},
	);
	// 凭证明文读取：渲染层点「眼睛」时按 ref 取一次（无值返回 undefined）。
	// ref 格式校验与 DSH credentialRef 同规则，防路径注入。
	ipcMain.handle(
		ipcChannels.dshCredentialRead,
		async (_event, ref: unknown) => {
			if (!readDshCredential) throw new Error("DSH credentials are not available");
			if (typeof ref !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
				throw new Error(`invalid credential ref: ${String(ref)}`);
			}
			return readDshCredential(ref);
		},
	);
	ipcMain.handle(
		ipcChannels.dshOpenDocument,
		async () => {
			if (!openDshDocument) throw new Error("DSH settings document is not available");
			await openDshDocument();
		},
	);
	ipcMain.handle(
		ipcChannels.dshRestartHost,
		async () => {
			if (!restartDshHost) throw new Error("DSH host restart is not available");
			return restartDshHost();
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeStop,
		(_event, target: SessionRuntimeTarget) => stopSessionRuntime(target),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeAbort,
		(_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.abortRuntime(target),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeRestart,
		async (_event, target: SessionRuntimeTarget) => {
			terminalManager.closeAgent(target.agentId);
			const result = await sessionRuntimeCoordinator.restartRuntime(target);
			if (result.ok) {
				// A --no-session restart is a binding replacement, not a close. Its
				// higher generation state event clears old runtime UI without deleting
				// the transient SessionRecord from the renderer.
				if (!result.value.session.noSession) emitSessionRuntimeDetach(target);
				emitReplacementState(result.value.runtime, false);
			}
			return result;
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeCompact,
		(_event, target: SessionRuntimeTarget, prompt?: string) =>
			sessionRuntimeCoordinator.compactRuntime(target, prompt),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeState,
		(_event, target: SessionRuntimeTarget) =>
			sessionRuntimeCoordinator.getRuntimeState(target),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeCommands,
		(_event, target: SessionRuntimeTarget) =>
			sessionRuntimeCoordinator.listRuntimeCommands(target),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeListModels,
		(_event, target: SessionRuntimeTarget) =>
			sessionRuntimeCoordinator.listRuntimeModels(target),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeThinkingLevels,
		(_event, target: SessionRuntimeTarget) =>
			sessionRuntimeCoordinator.listRuntimeThinkingLevels(target),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeExportHtml,
		async (_event, target: SessionRuntimeTarget) => {
			const result = await sessionRuntimeCoordinator.exportRuntimeHtml(target);
			void appLogger.info("session", "Session exported (runtime HTML)", {
				sessionId: target.sessionId,
				ok: result.ok,
			});
			return result;
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeEditMessage,
		(_event, target: SessionRuntimeTarget, messageId: string, newText: string) =>
			handleSessionCommandResult(
				appLogger,
				"editRuntimeMessage",
				target,
				{ messageId },
				() => sessionRuntimeCoordinator.editRuntimeMessage(target, messageId, newText),
			),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeDeleteMessage,
		(_event, target: SessionRuntimeTarget, messageId: string) =>
			handleSessionCommandResult(
				appLogger,
				"deleteRuntimeMessage",
				target,
				{ messageId },
				() => sessionRuntimeCoordinator.deleteRuntimeMessage(target, messageId),
			),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimePrepareResend,
		(_event, target: SessionRuntimeTarget, messageId: string) =>
			handleSessionCommandResult(
				appLogger,
				"prepareRuntimeResend",
				target,
				{ messageId },
				() => sessionRuntimeCoordinator.prepareRuntimeResend(target, messageId),
			),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeSetModel,
		(
			_event,
			target: SessionRuntimeTarget,
			provider: string,
			modelId: string,
		) => sessionRuntimeCoordinator.setRuntimeModel(target, provider, modelId),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeSetThinking,
		(_event, target: SessionRuntimeTarget, level: string) =>
				sessionRuntimeCoordinator.setRuntimeThinking(target, level),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeSetPermission,
		(_event, target: SessionRuntimeTarget, preset: string) => {
			// Renderer input is untrusted: reject values outside DSH's finite preset
			// set before they can reach the backend or be persisted in the catalog.
			if (!isDshPermissionPreset(preset)) {
				return Promise.resolve({
					ok: false as const,
					error: {
						code: "SESSION_COMMAND_FAILED" as const,
						debugDetails: `Unsupported DSH permission preset: ${String(preset)}`,
					},
				});
			}
			return sessionRuntimeCoordinator.setRuntimePermission(target, preset);
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeClone,
		async (_event, target: SessionRuntimeTarget) => {
			const validated = sessionRuntimeCoordinator.validateTarget(target);
			if (!validated.ok) return validated;
			try {
				// DSH 后端：clone = fork 无锚点（完整副本）+ runtime 换绑新会话
				// （catalog 的 dshSessionId 同步更新，重启后 attach 到 clone 结果）。
				// D3/C10：与 fork 同约束——withRuntimeReservation（lease 检查 + replacement 预留）。
				if (isDshAgent(target.agentId)) {
					if (!cloneDshAgentSession) {
						throw new Error("dsh clone is not available");
					}
					const value = await sessionRuntimeCoordinator.withRuntimeReservation(
						target.sessionId,
						target.agentId,
						() => cloneDshAgentSession(target),
					);
					void appLogger.info("session", "Session cloned (dsh)", {
						sessionId: target.sessionId,
					});
					return { ok: true as const, value };
				}
				const value = await replaceAgentSession(
					target.agentId,
					() => agentManager.cloneSession(target.agentId),
				);
				void appLogger.info("session", "Session cloned", { sessionId: target.sessionId });
				return {
					ok: true as const,
					value,
				};
			} catch (error) {
				return {
					ok: false as const,
					error: {
						code: "SESSION_COMMAND_FAILED" as const,
						debugDetails: error instanceof Error ? error.message : String(error),
					},
				};
			}
		},
	);
	// fork 与 clone 共用 replaceAgentSession：RPC 成功后刷新 sessionPath / 消息投影
	ipcMain.handle(
		ipcChannels.sessionsRuntimeGetForkMessages,
		(_event, target: SessionRuntimeTarget) =>
			sessionRuntimeCoordinator.getRuntimeForkMessages(target),
	);
	ipcMain.handle(
		ipcChannels.sessionsRuntimeFork,
		async (_event, target: SessionRuntimeTarget, entryId: string) => {
			const validated = sessionRuntimeCoordinator.validateTarget(target);
			if (!validated.ok) return validated;
			try {
				// DSH 后端：fork = session.fork 裁剪 + runtime 换绑新会话（catalog 的
				// dshSessionId 同步更新，重启后 attach 到 fork 结果）。
				// D3/C10：withRuntimeReservation 提供完整保护——dispatch lease 检查
				// （在途发送拒绝，防 RPC 响应落到已废弃 mux）+ replacement 预留
				// （fork 期间阻止并发 restart 等命令交错）。
				if (isDshAgent(target.agentId)) {
					if (!forkDshAgentSession) {
						throw new Error("dsh fork is not available");
					}
					const value = await sessionRuntimeCoordinator.withRuntimeReservation(
						target.sessionId,
						target.agentId,
						() => forkDshAgentSession(target, entryId),
					);
					void appLogger.info("session", "Session forked (dsh)", {
						sessionId: target.sessionId,
						entryId,
					});
					return { ok: true as const, value };
				}
				const value = await replaceAgentSession(
					target.agentId,
					() => agentManager.forkSession(target.agentId, entryId),
				);
				void appLogger.info("session", "Session forked", { sessionId: target.sessionId, entryId });
				return {
					ok: true as const,
					value,
				};
			} catch (error) {
				return {
					ok: false as const,
					error: {
						code: "SESSION_COMMAND_FAILED" as const,
						debugDetails: error instanceof Error ? error.message : String(error),
					},
				};
			}
		},
	);
	ipcMain.handle(
		ipcChannels.codexSessionsScan,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const result = await codexSessionImporter.scan(project.path);
			void appLogger.debug("session", "Codex sessions scanned", { projectId });
			return result;
		},
	);
	ipcMain.handle(
		ipcChannels.codexSessionsImport,
		async (_event, projectId: string, sourcePaths: string[]) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const result = await codexSessionImporter.import(project.path, sourcePaths);
			void appLogger.info("session", "Codex sessions imported", {
				projectId,
				sourceCount: sourcePaths.length,
			});
			return result;
		},
	);
	ipcMain.handle(
		ipcChannels.claudeSessionsScan,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const result = await claudeSessionImporter.scan(project.path);
			void appLogger.debug("session", "Claude sessions scanned", { projectId });
			return result;
		},
	);
	ipcMain.handle(
		ipcChannels.claudeSessionsImport,
		async (_event, projectId: string, sourcePaths: string[]) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const result = await claudeSessionImporter.import(project.path, sourcePaths);
			void appLogger.info("session", "Claude sessions imported", {
				projectId,
				sourceCount: sourcePaths.length,
			});
			return result;
		},
	);
	ipcMain.handle(
		ipcChannels.openCodeSessionsScan,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const result = await openCodeSessionImporter.scan(project.path);
			void appLogger.debug("session", "OpenCode sessions scanned", { projectId });
			return result;
		},
	);
	ipcMain.handle(
		ipcChannels.openCodeSessionsImport,
		async (_event, projectId: string, sourcePaths: string[]) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const result = await openCodeSessionImporter.import(project.path, sourcePaths);
			void appLogger.info("session", "OpenCode sessions imported", {
				projectId,
				sourceCount: sourcePaths.length,
			});
			return result;
		},
	);
}
