/** Session data port: catalog identity is resolved here; plugins never choose filesystem paths. */
import { stat } from "node:fs/promises";
import type { HostPluginContext, HostPluginEntriesPage, HostPluginEntryCursor, HostPluginSession, HostPluginSessionPage, HostPluginSessionsChangedDetail, HostPluginSessionsRevision } from "../../shared/types/hostPlugin";
import type { SessionCatalog, SessionCatalogEntry } from "../sessions/SessionCatalog";
import { SessionHistoryReader, type PluginHistoryGuard } from "../pi/SessionHistoryReader";
import { toWindowsHostPath } from "../wsl/WslPaths";
import type { SessionHistoryReaderDeps } from "../pi/SessionHistoryReader";

/** 项目登记表里插件可见的部分：目录给「会话属于哪个项目」，不含会话文件路径。 */
export type HostPluginProjectInfo = { name: string; directory?: string };

export class HostPluginSessions {
	private readonly reader: SessionHistoryReader;
	constructor(
		private readonly catalog: Pick<SessionCatalog, "listEntries" | "get">,
		private readonly projectOf?: (projectId: string) => HostPluginProjectInfo | undefined,
	) {
		// The plugin path never calls AgentManager or activates a pi runtime.
		const deps: SessionHistoryReaderDeps = {
			toHostPath: (path) => path,
			convertMessages: () => [],
			trimMessages: (messages) => messages,
			translate: (key) => key,
		};
		this.reader = new SessionHistoryReader(deps);
	}

	private path(entry: SessionCatalogEntry): string | undefined {
		if (!entry.filePath || entry.noSession || entry.backend === "dsh") return undefined;
		if (process.platform === "win32" && entry.environment === "wsl") {
			if (!entry.wslDistro) return undefined;
			return toWindowsHostPath(entry.filePath, { distro: entry.wslDistro });
		}
		return entry.filePath;
	}

	/** 工作区范围只有声明 `sessions.read.workspace` 的插件才有；scope 由宿主写入，插件伪造无效。 */
	private workspace(context: HostPluginContext): boolean {
		return context.scope === "workspace";
	}

	/**
	 * 归属判定：读列表、单会话、搜索、历史、跳转五条路径共用一套口径。
	 * 只看目录归属与归档状态——**不**要求会话有可读历史文件（DSH/ACP/生图等会话没有 JSONL，
	 * 但一样能列出、能点击跳转）；历史正文能力仍由 `path()` 决定。
	 */
	private owns(context: HostPluginContext, entry: SessionCatalogEntry): boolean {
		if (entry.noSession || entry.supersededBy) return false;
		if (this.workspace(context)) return true;
		return Boolean(context.projectId && entry.projectId === context.projectId);
	}

	/** 范围内会话（不排序）：list/search/revision 各自需要的顺序不同。 */
	private scoped(context: HostPluginContext): SessionCatalogEntry[] {
		return this.catalog.listEntries().filter((entry) => this.owns(context, entry));
	}

	/** 范围内可见会话：已保存、未归档、未缺席，按更新时间倒序（list/search 共用同一口径）。 */
	private visible(context: HostPluginContext): SessionCatalogEntry[] {
		if (!this.workspace(context) && !context.projectId) return [];
		return this.scoped(context).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
	}

	private toSession(entry: SessionCatalogEntry): HostPluginSession {
		const project = this.projectOf?.(entry.projectId);
		return {
			id: entry.id,
			projectId: entry.projectId,
			projectName: project?.name,
			directory: project?.directory,
			title: entry.title,
			updatedAt: entry.updatedAt,
			createdAt: entry.createdAt,
			model: entry.model?.modelId,
			backend: entry.backend,
			readable: Boolean(this.path(entry)),
		};
	}

	/**
	 * 范围描述：scope 由 manifest 权限算出，项目名/会话标题只来自登记表与范围内会话；
	 * 渲染层传上来的同名字段在这里被覆盖，所以插件无法用参数给自己提权。
	 */
	describe(context: HostPluginContext, permissions: readonly string[] = [], projectNameOf?: (projectId: string) => string | undefined): HostPluginContext {
		const entry = context.sessionId ? this.catalog.get(context.sessionId) : undefined;
		const owned = entry && this.owns(context, entry) ? entry : undefined;
		const scope = permissions.includes("sessions.read.workspace") ? "workspace" : "project";
		const projectName = context.projectId ? (projectNameOf?.(context.projectId) ?? this.projectOf?.(context.projectId)?.name) : undefined;
		return { ...context, scope, projectName, sessionTitle: owned?.title };
	}

	/** A missing project grants no workspace-wide browsing by default. */
	list(context: HostPluginContext, offset = 0): HostPluginSessionPage {
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error("invalid-offset");
		const entries = this.visible(context);
		const sessions = entries.slice(offset, offset + 100).map((entry) => this.toSession(entry));
		return { sessions, nextOffset: offset + 100 < entries.length ? offset + 100 : null };
	}

	/** 单会话元信息：归属判定与 list 一致，拿不到就不给（不泄露范围外会话的存在性）。 */
	get(context: HostPluginContext, id: string): HostPluginSession {
		const entry = this.catalog.get(id);
		if (!entry || !this.owns(context, entry)) throw new Error("session-not-authorized");
		return this.toSession(entry);
	}

	/** 标题搜索：只比对目录里的标题，不读历史文件，也就不需要额外扫描预算。 */
	search(context: HostPluginContext, query: string, limit = 20): HostPluginSession[] {
		const needle = query.trim().toLocaleLowerCase();
		if (!needle) return [];
		const size = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 20;
		return this.visible(context)
			.filter((entry) => entry.title.toLocaleLowerCase().includes(needle))
			.slice(0, size)
			.map((entry) => this.toSession(entry));
	}

	/** 单次插件读取的硬预算：含 fork 祖先链全部文件；超限拒绝而不是拖垮主进程。 */
	private static readonly HISTORY_BUDGET = { maxScanBytes: 64 * 1024 * 1024, maxEntries: 100_000, maxSummaryChars: 2000 };

	/**
	 * fork 祖先授权：祖先 hostPath 必须能解析回同一项目的会话文件。
	 * 跨项目 fork（祖先生成其他项目的路径）在这里被拒绝，读者降级单文件读，
	 * 绝不把其他项目的消息合并进本次插件响应。
	 */
	private authorizeAncestor(projectId: string, hostPath: string): boolean {
		return this.catalog.listEntries().some((entry) => entry.projectId === projectId && !entry.noSession && this.path(entry) === hostPath);
	}

	/**
	 * 跳转目标：返回会话的真实项目归属——工作区范围下目标项目可能与当前项目不同，
	 * 由宿主按这个 projectId 切项目再打开会话。范围外会话与「不存在」同样返回 undefined。
	 */
	resolveNavigation(context: HostPluginContext, id: string): { projectId: string; sessionId: string } | undefined {
		const entry = this.catalog.get(id);
		if (!entry || !this.owns(context, entry) || !entry.projectId) return undefined;
		return { projectId: entry.projectId, sessionId: entry.id };
	}

	async entries(context: HostPluginContext, id: string, cursor?: HostPluginEntryCursor): Promise<HostPluginEntriesPage> {
		const entry = this.catalog.get(id);
		if (!entry || !this.owns(context, entry)) throw new Error("session-not-authorized");
		const path = this.path(entry);
		if (!path) throw new Error("history-unavailable");
		const guard: PluginHistoryGuard = {
			...HostPluginSessions.HISTORY_BUDGET,
			authorizeSource: (hostPath) => this.authorizeAncestor(entry.projectId, hostPath),
			remaining: { bytes: 0, entries: 0 },
		};
		return this.reader.readPluginEntries(path, cursor, guard);
	}

	/** Bounded watcher signatures detect offline edits without maintaining per-plugin file watchers. */
	async revision(context: HostPluginContext): Promise<string> {
		return (await this.inspect(context)).catalog;
	}

	/** Structured revision plus a diff against the previous poll: `detail` drives targeted invalidation downstream. */
	async changeSince(context: HostPluginContext, previous?: HostPluginSessionsRevision): Promise<{ revision: HostPluginSessionsRevision; detail: HostPluginSessionsChangedDetail }> {
		const revision = await this.inspect(context);
		const detail: HostPluginSessionsChangedDetail = { catalogChanged: false };
		// First poll after mount/context switch: emit nothing, the initial load already covers it.
		if (previous) {
			detail.catalogChanged = previous.catalog !== revision.catalog;
			if (previous.active && revision.active && previous.active.sessionId === revision.active.sessionId && previous.active.file !== revision.active.file) {
				detail.sessionId = revision.active.sessionId;
			}
		}
		return { revision, detail };
	}

	private async inspect(context: HostPluginContext): Promise<HostPluginSessionsRevision> {
		const entries = this.scoped(context);
		const signature: unknown[] = entries.map((entry) => [entry.id, entry.updatedAt, entry.title, entry.filePath]);
		const active = context.sessionId ? this.catalog.get(context.sessionId) : undefined;
		const path = active && this.owns(context, active) ? this.path(active) : undefined;
		if (path) {
			let file: string;
			try {
				const info = await stat(path);
				file = JSON.stringify([info.size, info.mtimeMs]);
			} catch {
				file = "unavailable";
			}
			return { catalog: JSON.stringify(signature), active: { sessionId: active!.id, file } };
		}
		return { catalog: JSON.stringify(signature) };
	}
}
