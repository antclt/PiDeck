import { randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	open,
	readFile,
	unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import type {
	AgentBackend,
	AgentTab,
	SessionEnvironment,
	SessionRecord,
	SessionSource,
	SessionSummary,
} from "../../shared/types";
import { getAppLogger } from "../logging/sharedLogger";
import { renameWithRetry } from "../utils/fsRetry";
import {
	buildSessionOriginKey,
	buildSummaryOriginKey,
	canonicalizeSessionPath,
	getImportedSessionSourceId,
	getSessionEnvironment,
} from "../../shared/sessionIdentity";

export type SessionCatalogEntry = {
	id: string;
	projectId: string;
	originKey?: string;
	title: string;
	/** Anonymous entries are in-memory only and are never written to session-catalog.json. */
	noSession?: boolean;
	source: SessionSource;
	environment: SessionEnvironment;
	/** 运行时后端；缺省 "pi"（旧 catalog 数据兼容）。 */
	backend?: AgentBackend;
	filePath?: string;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
	status: "draft" | "active";
	/** 子会话标记：扫描时从 SessionSummary 继承，持久化供 getRecord/listEntries 重建（不丢树形） */
	parentSessionPath?: string;
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	piSessionId?: string;
	/** DSH 会话身份（DSH host 的 sessionId）；backend=dsh 时由 DshAgentManager 创建/attach 维护。 */
	dshSessionId?: string;
	/** DSH 权限预设（read-only/workspace-write/danger-full-access）：草稿期预选，激活时应用。 */
	permissionPreset?: string;
	createdAt: number;
	updatedAt: number;
};

type SessionCatalogFile = {
	version: 1;
	sessions: SessionCatalogEntry[];
};

type SessionCatalogContext = {
	wslDistro?: string;
	wslUser?: string;
};

/**
 * 将 catalog 条目 filePath 归一化为绝对路径（可选注入）。
 * pi 可能上报相对 cwd 的 sessionFile（如 sessionDir 配置为 ".pi/sessions"），
 * 与扫描器发现的绝对路径 originKey 不同，会造成同文件双记录（侧栏重复显示）。
 * 注入后 catalog 在加载与写入边界统一修正；实现见 main/index.ts。
 */
export type SessionFilePathResolver = (
	projectId: string,
	filePath: string,
	environment: SessionEnvironment,
) => string;

function cloneEntry(entry: SessionCatalogEntry): SessionCatalogEntry {
	return {
		...entry,
		model: entry.model ? { ...entry.model } : undefined,
	};
}

function equalModel(
	left?: { provider: string; modelId: string },
	right?: { provider: string; modelId: string },
): boolean {
	return left?.provider === right?.provider && left?.modelId === right?.modelId;
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(
		error &&
		typeof error === "object" &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT",
	);
}

export function canAttachRuntimeMetadata(
	entry: SessionCatalogEntry | undefined,
	tab: Partial<AgentTab>,
): boolean {
	if (!entry || !tab.sessionPath) return false;
	if (entry.status === "draft" && !entry.filePath) return true;
	if (!entry.filePath) return false;
	const environment = tab.sessionEnvironment ?? entry.environment;
	return buildSessionOriginKey({
		source: entry.source,
		environment: entry.environment,
		filePath: entry.filePath,
		wslDistro: entry.wslDistro,
		wslUser: entry.wslUser,
		importedSourceId: entry.importedSourceId,
	}) === buildSessionOriginKey({
		source: tab.sessionSource ?? entry.source,
		environment,
		filePath: tab.sessionPath,
		wslDistro: tab.wslDistro ?? entry.wslDistro,
		wslUser: tab.wslUser ?? entry.wslUser,
		importedSourceId: tab.importedSourceId ?? entry.importedSourceId,
	});
}

export class SessionCatalog {
	private entries: SessionCatalogEntry[] = [];
	/** Runtime-only records share the catalog lookup contract without durable storage. */
	private transientEntries = new Map<string, SessionCatalogEntry>();
	private loaded = false;
	private writeQueue: Promise<void> = Promise.resolve();
	private skipNextBackup = false;

	private identityContext: SessionCatalogContext;

	constructor(
		private readonly filePath: string,
		identityContext: SessionCatalogContext = {},
		private readonly resolveFilePath?: SessionFilePathResolver,
	) {
		this.identityContext = { ...identityContext };
	}

	setIdentityContext(context: SessionCatalogContext): void {
		this.identityContext = { ...context };
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		let primaryError: unknown;
		try {
			this.entries = await this.readEntries(this.filePath);
		} catch (error) {
			primaryError = error;
			try {
				this.entries = await this.readEntries(this.backupFilePath());
				this.skipNextBackup = true;
			} catch (backupError) {
				if (isMissingFileError(primaryError) && isMissingFileError(backupError)) {
					this.entries = [];
				} else {
					// catalog 主文件与备份同时损坏是数据丢失信号，必须留 error 级日志供审计
					void getAppLogger()?.error("session-catalog", "Catalog and backup both failed to load", {
						primary: primaryError instanceof Error ? primaryError.message : String(primaryError),
						backup: backupError instanceof Error ? backupError.message : String(backupError),
					});
					throw new Error(
						`Failed to load Session catalog or backup: ${String(primaryError)}; ${String(backupError)}`,
					);
				}
			}
		}
		// Draft 只代表当前进程中的“尚未发送”编辑面：没有用户消息就没有
		// 可恢复的 Pi session。重启时清掉它们（仅限 pi 后端），避免空 Agent 在
		// 历史列表中永久残留。
		// 例外：DSH 会话的草稿必须保留。DSH 的 host 会话数据由 $DSH_HOME 持久化，
		// catalog 只是 id 映射；即使“创建后激活链路未走完”（attachRuntime 未把
		// status 置 active），重启后用户仍应在侧栏看到并重新激活它。若在此清掉，
		// host 侧会话会变成孤儿且无法从侧栏访问。带 dshSessionId 的异常中间态同样保留。
		const staleDrafts = this.entries.filter(
			(entry) => entry.status === "draft" && entry.backend !== "dsh",
		);
		if (staleDrafts.length > 0) {
			this.entries = this.entries.filter(
				(entry) => entry.status !== "draft" || entry.backend === "dsh",
			);
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 启动清理是 best-effort；内存已经不再暴露草稿，下一次启动仍会重试清理。
			}
		}

		// 兼容旧数据：早期版本可能存有相对 filePath（pi 返回相对 cwd 的 sessionFile，
		// 如 sessionDir 配置为 ".pi/sessions"）。相对路径与扫描器绝对路径的 originKey
		// 不同 → 同一文件出现两条记录（侧栏重复显示），且文件操作落到错误位置。
		// 加载时用注入的 resolver 统一修正为绝对路径并重算 originKey。
		const repaired = this.repairRelativeFilePaths(this.entries);
		if (repaired) {
			this.entries = repaired;
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 修复是 best-effort；内存已生效，下一次启动仍会重试。
			}
		}

		// 兼容旧数据：DSH 会话曾只按文件分支 attach（filePath/piSessionId 落盘，
		// dshSessionId 缺失）——标题同步（findByDshSessionId）与重启后 attach 恢复
		// 旧会话都依赖 dshSessionId。加载时把 backend=dsh 且缺 dshSessionId 的
		// 记录用 piSessionId（当时存的就是 host 会话 id）补齐。
		const migratedDsh = this.entries.some((entry) => (
			entry.backend === "dsh" && !entry.dshSessionId && entry.piSessionId
		));
		if (migratedDsh) {
			for (const entry of this.entries) {
				if (entry.backend === "dsh" && !entry.dshSessionId && entry.piSessionId) {
					entry.dshSessionId = entry.piSessionId;
				}
			}
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 迁移是 best-effort；内存已生效，下一次启动仍会重试。
			}
		}

		// 兼容旧数据：早期版本把 DSH 会话当 pi 会话 attach（filePath=host zstd 文件、
		// piSessionId=host 会话 id 落盘）。pi 侧逻辑会把 zstd 文件当 pi 会话文件
		// 处理（启动 pi exited code=1、导出/删除误判等）。dsh 条目只保留 dshSessionId，
		// filePath/piSessionId 一律清除（dshSessionId 已在上方迁移补齐）。
		const pollutedDsh = this.entries.some((entry) => (
			entry.backend === "dsh" && (Boolean(entry.filePath) || Boolean(entry.piSessionId))
		));
		if (pollutedDsh) {
			for (const entry of this.entries) {
				if (entry.backend !== "dsh") continue;
				delete entry.filePath;
				delete entry.piSessionId;
				entry.originKey = undefined;
			}
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 迁移是 best-effort；内存已生效，下一次启动仍会重试。
			}
		}
		this.loaded = true;
		if (this.skipNextBackup) {
			await this.writeSnapshot(this.entries);
		}
	}

	listEntries(): SessionCatalogEntry[] {
		this.assertLoaded();
		return [
			...this.entries.map(cloneEntry),
			...Array.from(this.transientEntries.values(), cloneEntry),
		];
	}

	get(id: string): SessionCatalogEntry | undefined {
		this.assertLoaded();
		const entry = this.transientEntries.get(id) ?? this.entries.find((candidate) => candidate.id === id);
		return entry ? cloneEntry(entry) : undefined;
	}

	/** 按 DSH host 会话 id 反查 catalog 记录（会话标题同步用；只读查询，不排队写）。
	 *  transient 草稿尚未 attach host 会话（无 dshSessionId），只需查持久 entries。 */
	findByDshSessionId(dshSessionId: string): SessionCatalogEntry | undefined {
		this.assertLoaded();
		const entry = this.entries.find((candidate) => candidate.dshSessionId === dshSessionId);
		return entry ? cloneEntry(entry) : undefined;
	}

	createAnonymous(input: {
		projectId: string;
		title: string;
		environment: SessionEnvironment;
		model?: { provider: string; modelId: string };
		thinkingLevel?: string;
	}): SessionRecord {
		this.assertLoaded();
		const now = Date.now();
		const entry: SessionCatalogEntry = {
			id: randomUUID(),
			projectId: input.projectId,
			title: input.title,
			noSession: true,
			source: "pi",
			environment: input.environment,
			wslDistro: input.environment === "wsl" ? this.identityContext.wslDistro : undefined,
			wslUser: input.environment === "wsl" ? this.identityContext.wslUser : undefined,
			status: "active",
			model: input.model,
			thinkingLevel: input.thinkingLevel,
			createdAt: now,
			updatedAt: now,
		};
		this.transientEntries.set(entry.id, entry);
		return this.recordFromEntry(entry);
	}

	removeTransient(id: string): boolean {
		this.assertLoaded();
		return this.transientEntries.delete(id);
	}

	getRecord(id: string): SessionRecord | undefined {
		const entry = this.get(id);
		return entry ? this.recordFromEntry(entry) : undefined;
	}

	findByFilePath(
		filePath: string,
		environment: SessionEnvironment,
	): SessionCatalogEntry | undefined {
		this.assertLoaded();
		const target = canonicalizeSessionPath(filePath, environment);
		const entry = this.entries.find((candidate) => (
			candidate.filePath &&
			candidate.environment === environment &&
			canonicalizeSessionPath(candidate.filePath, environment) === target
		));
		return entry ? cloneEntry(entry) : undefined;
	}

	async ensureRuntimeTarget(input: {
		projectId: string;
		title: string;
		source: SessionSource;
		environment: SessionEnvironment;
		filePath: string;
		wslDistro?: string;
		wslUser?: string;
		importedSourceId?: string;
		piSessionId?: string;
	}): Promise<SessionCatalogEntry> {
		this.assertLoaded();
		// 与 attachRuntime 同口径：进入 catalog 前归一化为绝对路径，保证 originKey 去重一致。
		const filePath = this.resolveFilePath
			? this.resolveFilePath(input.projectId, input.filePath, input.environment)
			: input.filePath;
		return this.enqueueMutation((entries) => {
			const originKey = buildSessionOriginKey({
				source: input.source,
				environment: input.environment,
				filePath,
				wslDistro: input.wslDistro,
				wslUser: input.wslUser,
				importedSourceId: input.importedSourceId,
			});
			let entry = entries.find((candidate) => {
				if (candidate.originKey === originKey) return true;
				if (!candidate.filePath) return false;
				return buildSessionOriginKey({
					source: candidate.source,
					environment: candidate.environment,
					filePath: candidate.filePath,
					wslDistro: candidate.wslDistro,
					wslUser: candidate.wslUser,
					importedSourceId: candidate.importedSourceId,
				}) === originKey;
			});
			const now = Date.now();
			if (!entry) {
				entry = {
					id: randomUUID(),
					projectId: input.projectId,
					originKey,
					title: input.title,
					source: input.source,
					environment: input.environment,
					filePath,
					wslDistro: input.wslDistro,
					wslUser: input.wslUser,
					importedSourceId: input.importedSourceId,
					piSessionId: input.piSessionId,
					status: "active",
					createdAt: now,
					updatedAt: now,
				};
				entries.push(entry);
			} else {
				entry.projectId = input.projectId;
				entry.originKey = originKey;
				entry.title = input.title;
				entry.source = input.source;
				entry.environment = input.environment;
				entry.filePath = filePath;
				entry.wslDistro = input.wslDistro;
				entry.wslUser = input.wslUser;
				entry.importedSourceId = input.importedSourceId;
				entry.piSessionId = input.piSessionId;
				entry.status = "active";
				entry.updatedAt = now;
			}
			return { value: cloneEntry(entry), changed: true };
		});
	}

	async createDraft(input: {
		projectId: string;
		title: string;
		environment: SessionEnvironment;
		source?: SessionSource;
		backend?: AgentBackend;
		model?: { provider: string; modelId: string };
		thinkingLevel?: string;
		permissionPreset?: string;
		/** 外部（dsh-web 等）会话导入：host 会话已存在，条目直接置 active（重启不清理）。 */
		dshSessionId?: string;
		/** 纠正归属时保留已有标题（磁盘扫描没有投影标题，不能用 cwd 末段覆盖 host 回写名）。 */
		keepExistingTitle?: boolean;
	}): Promise<SessionRecord> {
		this.assertLoaded();
		const entry = await this.enqueueMutation((entries) => {
			const now = Date.now();
			// 幂等去重：DSH 外部会话按 host 会话 id 唯一映射。同一 dshSessionId 重复
			// 导入（自动同步与手动导入并发、配置页重复点击、host-ready 重放）时
			// 不再新建条目，只更新标题/项目归属——否则侧栏出现两条同 host 会话记录，
			// 且删除其一后另一条仍可加载同一 host 数据（「重复导入」用户问题）。
			if (input.dshSessionId) {
				const existing = entries.find((candidate) => (
					candidate.dshSessionId === input.dshSessionId
				));
				if (existing) {
					const nextTitle = input.keepExistingTitle ? existing.title : input.title;
					const changed = (
						existing.projectId !== input.projectId ||
						existing.title !== nextTitle ||
						existing.backend !== input.backend ||
						existing.status !== "active"
					);
					existing.projectId = input.projectId;
					existing.title = nextTitle;
					existing.backend = input.backend;
					existing.status = "active";
					existing.updatedAt = now;
					return { value: cloneEntry(existing), changed };
				}
			}
			const nextEntry: SessionCatalogEntry = {
				id: randomUUID(),
				projectId: input.projectId,
				title: input.title,
				source: input.source ?? "pi",
				environment: input.environment,
				backend: input.backend,
				wslDistro: input.environment === "wsl"
					? this.identityContext.wslDistro
					: undefined,
				wslUser: input.environment === "wsl"
					? this.identityContext.wslUser
					: undefined,
				// 带 dshSessionId = 导入已有 host 会话（数据在 $DSH_HOME），
				// 不是「尚未发送」的草稿：置 active，重启清理/重新打开都按真实会话处理。
				status: input.dshSessionId ? "active" : "draft",
				model: input.model,
				thinkingLevel: input.thinkingLevel,
				permissionPreset: input.permissionPreset,
				dshSessionId: input.dshSessionId,
				createdAt: now,
				updatedAt: now,
			};
			entries.push(nextEntry);
			return { value: cloneEntry(nextEntry), changed: true };
		});
		return this.recordFromEntry(entry);
	}

	async update(
		id: string,
		patch: Partial<Pick<
			SessionCatalogEntry,
			"title" | "backend" | "updatedAt"
		>> & {
			model?: { provider: string; modelId: string } | null;
			thinkingLevel?: string | null;
			permissionPreset?: string | null;
		},
	): Promise<SessionRecord> {
		this.assertLoaded();
		const transient = this.transientEntries.get(id);
		if (transient) {
			if (patch.title !== undefined) transient.title = patch.title;
			if (patch.model !== undefined) transient.model = patch.model ?? undefined;
			if (patch.thinkingLevel !== undefined) transient.thinkingLevel = patch.thinkingLevel ?? undefined;
			if (patch.permissionPreset !== undefined) transient.permissionPreset = patch.permissionPreset ?? undefined;
			if (patch.backend !== undefined) transient.backend = patch.backend;
			transient.updatedAt = patch.updatedAt ?? Date.now();
			return this.recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, id);
			if (patch.title !== undefined) nextEntry.title = patch.title;
			if (patch.model !== undefined) nextEntry.model = patch.model ?? undefined;
			if (patch.thinkingLevel !== undefined) nextEntry.thinkingLevel = patch.thinkingLevel ?? undefined;
			if (patch.permissionPreset !== undefined) nextEntry.permissionPreset = patch.permissionPreset ?? undefined;
			if (patch.backend !== undefined) nextEntry.backend = patch.backend;
			nextEntry.updatedAt = patch.updatedAt ?? Date.now();
			return { value: cloneEntry(nextEntry), changed: true };
		});
		return this.recordFromEntry(entry);
	}

	async attachRuntime(input: {
		sessionId: string;
		filePath?: string;
		piSessionId?: string;
		dshSessionId?: string;
	}): Promise<SessionCatalogEntry> {
		this.assertLoaded();
		return this.enqueueMutation((entries) => {
			const entry = this.requireEntry(entries, input.sessionId);
			// pi 可能上报相对 cwd 的 sessionFile：写入 catalog 前归一化为绝对路径，
			// 否则与扫描器绝对路径 originKey 不一致，同一文件会出现两条记录。
			const filePath =
				input.filePath && this.resolveFilePath
					? this.resolveFilePath(
							entry.projectId,
							input.filePath,
							entry.environment,
						)
					: input.filePath;
			const previousFilePath = entry.filePath;
			if (filePath) entry.filePath = filePath;
			if (input.piSessionId) entry.piSessionId = input.piSessionId;
			if (input.dshSessionId) entry.dshSessionId = input.dshSessionId;
			// DSH 会话没有 pi 会话文件：无 filePath 分支，但 attach 到 host 会话后即视为
			// active（会话持久化在 $DSH_HOME，重启不应被 draft 清理逻辑清掉）。
			if (input.dshSessionId && !entry.filePath && entry.status === "draft") {
				entry.status = "active";
			}
			if (entry.filePath) {
				const pathUnchanged = Boolean(
					previousFilePath &&
					canonicalizeSessionPath(previousFilePath, entry.environment) ===
						canonicalizeSessionPath(entry.filePath, entry.environment),
				);
				const nextOriginKey = pathUnchanged && entry.originKey
					? entry.originKey
					: this.originKeyForEntry(entry);
				entry.originKey = nextOriginKey;
				entry.status = "active";

				const duplicateIndex = nextOriginKey
					? entries.findIndex((candidate) => (
						candidate.id !== entry.id && candidate.originKey === nextOriginKey
					))
					: -1;
				if (duplicateIndex >= 0) {
					const duplicate = entries[duplicateIndex];
					entry.model ??= duplicate.model;
					entry.thinkingLevel ??= duplicate.thinkingLevel;
					entry.importedSourceId ??= duplicate.importedSourceId;
					entry.createdAt = Math.min(entry.createdAt, duplicate.createdAt);
					entries.splice(duplicateIndex, 1);
				}
			}
			entry.updatedAt = Date.now();
			return { value: cloneEntry(entry), changed: true };
		});
	}

	async remove(id: string): Promise<boolean> {
		this.assertLoaded();
		if (this.transientEntries.delete(id)) return true;
		return this.enqueueMutation((entries) => {
			const index = entries.findIndex((entry) => entry.id === id);
			if (index < 0) return { value: false, changed: false };
			entries.splice(index, 1);
			return { value: true, changed: true };
		});
	}

	async removeByFilePath(
		filePath: string,
		environment: SessionEnvironment,
	): Promise<boolean> {
		this.assertLoaded();
		const target = canonicalizeSessionPath(filePath, environment);
		return this.enqueueMutation((entries) => {
			const index = entries.findIndex((entry) => (
				entry.filePath &&
				entry.environment === environment &&
				canonicalizeSessionPath(entry.filePath, environment) === target
			));
			if (index < 0) return { value: false, changed: false };
			entries.splice(index, 1);
			return { value: true, changed: true };
		});
	}

	async mergeScanned(
		projectId: string,
		summaries: SessionSummary[],
		context: SessionCatalogContext = this.identityContext,
	): Promise<SessionRecord[]> {
		this.assertLoaded();
		return this.enqueueMutation((entries) => {
			const byOrigin = new Map(
				entries
					.filter((entry) => entry.originKey)
					.map((entry) => [entry.originKey!, entry]),
			);
			const summaryById = new Map<string, SessionSummary>();
			let changed = false;

			// Restore model/thinking from the session file when the catalog lacks them.
			// (Explicit user picks are already stored on the entry and are preserved.)
			function inheritSessionMeta(entry: SessionCatalogEntry, summary: SessionSummary) {
				if (!entry.model && summary.model) {
					entry.model = { ...summary.model };
					changed = true;
				}
				if (!entry.thinkingLevel && summary.thinkingLevel) {
					entry.thinkingLevel = summary.thinkingLevel;
					changed = true;
				}
			}

			for (const summary of summaries) {
				const originKey = buildSummaryOriginKey(summary, context);
				const importedSourceId = getImportedSessionSourceId(summary);
				let entry = byOrigin.get(originKey);
				if (!entry) {
					const now = summary.updatedAt || Date.now();
					entry = {
						id: randomUUID(),
						projectId,
						originKey,
						title: summary.name || "Untitled",
						source: summary.source ?? "pi",
						environment: getSessionEnvironment(summary),
						filePath: summary.filePath,
						wslDistro: summary.wsl ? context.wslDistro : undefined,
						wslUser: summary.wsl ? context.wslUser : undefined,
						importedSourceId,
						status: "active",
						parentSessionPath: summary.parentSessionPath,
						createdAt: now,
						updatedAt: now,
					};
					entries.push(entry);
					byOrigin.set(originKey, entry);
					changed = true;
				} else {
					const nextTitle = summary.name || entry.title;
					if (
						entry.projectId !== projectId ||
						entry.filePath !== summary.filePath ||
						entry.title !== nextTitle ||
						entry.source !== (summary.source ?? "pi") ||
						entry.environment !== getSessionEnvironment(summary) ||
						entry.wslDistro !== (summary.wsl ? context.wslDistro : undefined) ||
						entry.wslUser !== (summary.wsl ? context.wslUser : undefined) ||
						entry.importedSourceId !== importedSourceId ||
						entry.status !== "active" ||
						entry.parentSessionPath !== summary.parentSessionPath ||
						entry.updatedAt !== summary.updatedAt
					) {
						entry.projectId = projectId;
						entry.filePath = summary.filePath;
						entry.title = nextTitle;
						entry.source = summary.source ?? "pi";
						entry.environment = getSessionEnvironment(summary);
						entry.wslDistro = summary.wsl ? context.wslDistro : undefined;
						entry.wslUser = summary.wsl ? context.wslUser : undefined;
						entry.importedSourceId = importedSourceId;
						entry.status = "active";
						// 子会话的父子关系可能随后续扫描才被识别（parent 文件出现/路径推断补全），
						// 变化必须计入 changed 才会落盘，否则重拉后仍以孤儿平铺。
						entry.parentSessionPath = summary.parentSessionPath;
						entry.updatedAt = summary.updatedAt;
						changed = true;
					}
				}
				summaryById.set(entry.id, summary);
				inheritSessionMeta(entry, summary);
			}

			const records = entries
				.filter((entry) => entry.projectId === projectId)
				.map((entry) => this.recordFromEntry(entry, summaryById.get(entry.id)));
			const idByPath = new Map<string, string>();
			for (const record of records) {
				if (!record.filePath) continue;
				idByPath.set(
					canonicalizeSessionPath(record.filePath, record.environment),
					record.id,
				);
			}
			for (const record of records) {
				if (!record.parentSessionPath) continue;
				record.parentSessionId = idByPath.get(
					canonicalizeSessionPath(record.parentSessionPath, record.environment),
				);
			}
			return {
				value: records.sort((left, right) => right.updatedAt - left.updatedAt),
				changed,
			};
		}).then((records) => [
			...Array.from(this.transientEntries.values())
				.filter((entry) => entry.projectId === projectId)
				.map((entry) => this.recordFromEntry(entry)),
			...records,
		].sort((left, right) => right.updatedAt - left.updatedAt));
	}

	private recordFromEntry(
		entry: SessionCatalogEntry,
		summary?: SessionSummary,
	): SessionRecord {
		return {
			id: entry.id,
			projectId: entry.projectId,
			title: summary?.name || entry.title,
			noSession: entry.noSession,
			source: summary?.source ?? entry.source,
			environment: summary ? getSessionEnvironment(summary) : entry.environment,
			backend: entry.backend,
			filePath: summary?.filePath ?? entry.filePath,
			wslDistro: entry.wslDistro,
			wslUser: entry.wslUser,
			importedSourceId: summary
				? getImportedSessionSourceId(summary)
				: entry.importedSourceId,
			parentSessionPath: summary?.parentSessionPath ?? entry.parentSessionPath,
			projectPath: summary?.projectPath,
			preview: summary?.preview ?? "",
			messageCount: summary?.messageCount ?? 0,
			status: entry.status,
			model: entry.model ? { ...entry.model } : undefined,
			thinkingLevel: entry.thinkingLevel,
			permissionPreset: entry.permissionPreset,
			dshSessionId: entry.dshSessionId,
			createdAt: entry.createdAt,
			updatedAt: summary?.updatedAt ?? entry.updatedAt,
			wsl: summary?.wsl,
			codexSessionId: summary?.codexSessionId,
			codexThreadSource: summary?.codexThreadSource,
			codexParentThreadId: summary?.codexParentThreadId,
			codexAgentRole: summary?.codexAgentRole,
			codexAgentNickname: summary?.codexAgentNickname,
		};
	}

	private originKeyForEntry(entry: SessionCatalogEntry): string | undefined {
		if (!entry.filePath) return undefined;
		return buildSessionOriginKey({
			source: entry.source,
			environment: entry.environment,
			filePath: entry.filePath,
			wslDistro: entry.wslDistro ?? this.identityContext.wslDistro,
			wslUser: entry.wslUser ?? this.identityContext.wslUser,
			importedSourceId: entry.importedSourceId,
		});
	}

	/**
	 * 把条目中的相对 filePath 修正为绝对路径（通过注入的 resolver）。
	 * 返回新数组表示有变更；未注入 resolver 或无需修正时返回 undefined。
	 */
	private repairRelativeFilePaths(
		entries: SessionCatalogEntry[],
	): SessionCatalogEntry[] | undefined {
		const resolve = this.resolveFilePath;
		if (!resolve) return undefined;
		let changed = false;
		const next = entries.map((entry) => {
			if (!entry.filePath) return entry;
			const resolved = resolve(
				entry.projectId,
				entry.filePath,
				entry.environment,
			);
			if (!resolved || resolved === entry.filePath) return entry;
			changed = true;
			const repaired = { ...entry, filePath: resolved };
			// originKey 随路径变化重算，否则后续 mergeScanned/attachRuntime 仍按旧 key 去重
			if (repaired.originKey) repaired.originKey = this.originKeyForEntry(repaired);
			return repaired;
		});
		return changed ? next : undefined;
	}

	private requireEntry(
		entries: SessionCatalogEntry[],
		id: string,
	): SessionCatalogEntry {
		const entry = entries.find((candidate) => candidate.id === id);
		if (!entry) throw new Error(`Session not found: ${id}`);
		return entry;
	}

	private assertLoaded(): void {
		if (!this.loaded) throw new Error("SessionCatalog.load() must complete before use");
	}

	private enqueueMutation<T>(
		mutate: (entries: SessionCatalogEntry[]) => { value: T; changed: boolean },
	): Promise<T> {
		const operation = this.writeQueue
			.catch(() => undefined)
			.then(async () => {
				const nextEntries = this.entries.map(cloneEntry);
				const result = mutate(nextEntries);
				if (result.changed) {
					await this.writeSnapshot(nextEntries);
					this.entries = nextEntries;
				}
				return result.value;
			});
		this.writeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private backupFilePath(): string {
		return `${this.filePath}.bak`;
	}

	private async readEntries(filePath: string): Promise<SessionCatalogEntry[]> {
		const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<SessionCatalogFile>;
		if (!Array.isArray(parsed.sessions)) {
			throw new Error(`Invalid Session catalog: ${filePath}`);
		}
		const entries = parsed.sessions.filter((entry): entry is SessionCatalogEntry => (
			typeof entry?.id === "string" &&
			typeof entry.projectId === "string" &&
			typeof entry.title === "string" &&
			(entry.environment === "native" || entry.environment === "wsl") &&
			(entry.status === "draft" || entry.status === "active")
		));
		if (entries.length !== parsed.sessions.length) {
			throw new Error(`Session catalog contains invalid records: ${filePath}`);
		}
		return entries.map(cloneEntry);
	}

	private async writeSnapshot(entries: SessionCatalogEntry[]): Promise<void> {
		const snapshot: SessionCatalogFile = {
			version: 1,
			sessions: entries.map(cloneEntry),
		};
		await mkdir(dirname(this.filePath), { recursive: true });
		const nonce = randomUUID();
		const tempPath = `${this.filePath}.${nonce}.tmp`;
		const backupPath = this.backupFilePath();
		const backupTempPath = `${backupPath}.${nonce}.tmp`;
		try {
			const handle = await open(tempPath, "w");
			try {
				await handle.writeFile(JSON.stringify(snapshot, null, 2), "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}

			if (!this.skipNextBackup) {
				try {
					await copyFile(this.filePath, backupTempPath);
					await renameWithRetry(backupTempPath, backupPath);
				} catch (error) {
					await unlink(backupTempPath).catch(() => undefined);
					if (isMissingFileError(error)) {
						// 首次写入：主文件还不存在，没有可备份的内容，属正常情况
					} else {
						// 备份轮换失败不能阻断 catalog 写入（新建会话等操作会因此失败）：
						// .bak 只是崩溃恢复的冗余副本，主文件仍是原子替换，旧内容在失败时原样保留。
						void getAppLogger()?.warn("session-catalog", "Backup rotation failed, continuing without backup", {
							cause: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
			await renameWithRetry(tempPath, this.filePath);
			this.skipNextBackup = false;
		} finally {
			await unlink(tempPath).catch(() => undefined);
			await unlink(backupTempPath).catch(() => undefined);
		}
	}
}

export function didSessionPreferencesChange(
	entry: SessionCatalogEntry,
	patch: Pick<SessionCatalogEntry, "model" | "thinkingLevel">,
): boolean {
	return !equalModel(entry.model, patch.model) || entry.thinkingLevel !== patch.thinkingLevel;
}
