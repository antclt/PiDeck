/**
 * 远端项目域的 IPC 注册（G1：按域从 remoteHostIpc.ts 拆出，纯搬迁）。
 *
 * 这里只放「连上一台主机之后，按 projectId 只读地看什么」：项目登记 + 确认回答 + 列表 + 读取 + 搜索
 * + 项目级 root 复核状态（第四批设计 (i)）。
 * hosts 域（连得上吗、诊断、修复）留在 remoteHostIpc.ts。拆分的动因是体量红线，域边界本来就在：
 * 两个域共用同一套窄依赖（enabled / service / userDataDir 与懒构建的连接服务），但 handler、校验
 * 与错误码各自独立。
 *
 * 两个域刻意互不 import：`HOST_ID`、`senderIdOf`、`codeOf` 在本文件按 hosts 域的同一判据重新声明
 * （仓库里 `HOST_ID` 本来就是每个远端模块各自持有的闭集判据）；若让项目域 import hosts 域，拆分
 * 只是把耦合换了个文件名。稳定码判据本身走 `shared/op`（全仓唯一一份实现）。
 *
 * 信封形状是 `Op<T>`（v5 §2「单信封」）：成功 `{ok:true, value}`，失败 `{ok:false, code, outcome}`。
 */

import { createHash } from "node:crypto";
import { createRemoteProjectTargetResolver } from "./remoteProjectTarget";
import { ipcMain, type WebContents } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { codeOf, opFailFromCode, opOk } from "../../shared/op";
import type {
	RemoteProjectDownloadResult,
	RemoteProjectUploadResult,
	RemoteProjectEnrollAnswerResult,
	RemoteProjectEnrollMode,
	RemoteProjectEnrollRequest,
	RemoteProjectEnrollResult,
	RemoteProjectListResult,
	RemoteProjectReadResult,
	RemoteProjectRootStatusResult,
	RemoteProjectSearchResult,
	RemoteWorkspaceEntry,
} from "../../shared/types/remoteHost";
import type { ProjectDirectoryPageResult, ProjectPathState, ProjectPathsExistResult } from "../../shared/types/projectFiles";
import { registerRemoteProjectCreateFlow } from "./remoteProjectCreateIpc";
import type { RemoteHostConnectionService, RemoteProjectSession } from "../remote/RemoteHostConnectionService";
import { REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH } from "../remote/RemoteHelperContract";
import { REMOTE_PROJECT_TRASH_DIR } from "../remote/RemoteProjectEntryCommands";
import { REMOTE_UPLOAD_TEMP_NAME } from "../remote/RemoteProjectFileUpload";
import { resolveRemoteBrowseRoot } from "../remote/RemoteBrowseRoot";
import { createRemoteSearchReader, REMOTE_SEARCH_READER_CODES } from "../remote/RemoteSearchReader";
import { createRemoteWorkspaceReader, type RemoteWorkspacePort } from "../remote/RemoteWorkspaceReader";
import { createFactCache, type FactCache } from "../remote/RemoteFactCache";
import { createDirWatchRegistry, dirKeysAfterWrite, dirPathsAfterWrite } from "../remote/RemoteDirWatchRegistry";
import { createRemoteFactsHub, type RemoteFactsHub } from "../remote/RemoteFactsNotifications";
import { PendingConfirmationBroker } from "../security/PendingConfirmationBroker";

/** host id 的闭集判据，与 hosts 域逐字相同；两个域各自持有，避免项目域 import hosts 域。 */
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The broker keys on a positive integer sender; `webContents.id` is exactly that. */
function senderIdOf(sender: WebContents): number | undefined {
	const id = sender?.id;
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * 远端项目 IPC：登记、确认回答、按 projectId 的列表/读取/搜索。
 *
 * `enabled` 关掉时每个通道都返回稳定码（渲染层连「有这条路」都不该知道）；`service` 可选，因此
 * 只读目录在没有任何连接服务时也返回稳定码而不是崩溃；`projects` 是装配层注入的持久化端口
 * （enroll / locator），未提供时项目相关通道返回稳定码。
 */
/** 事实层句柄：写面完成后按“我改了哪些路径”标脏，下一次读取自然重新装载。 */
export type RemoteProjectIpcHandle = {
	/** 失效矩阵：写到的路径 ⇒ 所在目录 + 其父目录（目录自身的元数据也变了）。 */
	afterWrite(projectId: string, paths: readonly string[]): void;
	/**
	 * helper 变更事件（helper 1.24.0）的入口：把 watchId 换回「哪个项目的哪些目录」。
	 *
	 * 只做**失效**，不装载：事件是「你可能要重读」的提示，重读仍由读的人决定。
	 * 未注册的 watchId（旧会话、别的项目、已撤销）直接忽略——绝不猜。
	 */
	onHelperEvent(entry: { hostId: string; watchId: string; paths: readonly string[] }): void;
	/** 断连：helper 的 watcher 已随会话一起死，登记直接丢弃（不再发退订）。 */
	onHostDisconnected(hostId: string): void;
	/** 项目关闭：退订它在各 host 上的目录订阅，不影响别的项目。 */
	closeProject(projectId: string): Promise<void>;
	/** 公共目录页（T6）：与远端 list 共用同一份事实缓存，带 truncated/revision/generation。 */
	directoryPage(projectId: string, path: string, force?: boolean): Promise<ProjectDirectoryPageResult>;
	/** 批量存在性/类型（只读 fs 面；64 路径/帧，全有或全无时按需逐项核对）。 */
	pathsExist(projectId: string, paths: readonly string[]): Promise<ProjectPathsExistResult>;
	/** 进程退出：成对退订后丢弃全部订阅登记。 */
	dispose(): Promise<void>;
	/** 只读诊断：一次会话内真实发生的目录装载次数。 */
	dirLoads(): number;
};

export function registerRemoteProjectIpc(input: {
	enabled: boolean;
	userDataDir: string;
	service?: () => RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined>;
	/** 事实变化通知出口；装配层提供时由目录与 Git 共用同一个 hub。 */
	factsEvents?: RemoteFactsHub;
	/**
	 * 远端项目登记端口（Phase 3 第二段）。
	 *
	 * 只开一个狭窄入口：`enroll` 把已确认的 canonical root 写进项目库并返回 stable projectId；
	 * `locator` 按 projectId 取回 `{ hostId, remotePath }`。主进程持有校验后的 canonical 值，
	 * 远端路径不经由渲染层或本机 fs。未提供时（旧装配/正式包）登记与项目读取/搜索都返回稳定码。
	 */
	projects?: {
		enroll: (input: { hostId: string; canonicalRemotePath: string }) => Promise<{ projectId: string }>;
		locator: (projectId: string) => { kind: "ssh"; hostId: string; remotePath: string } | undefined;
	};
}): RemoteProjectIpcHandle {
	/**
	 * Resolve the connection service, turning a discovery failure into a stable code.
	 *
	 * Building the service can fail on purpose: the SSH client is probed before it is trusted, and a
	 * missing or incapable client is a reportable condition rather than a crash. Letting that rejection
	 * escape produced an unhandled "Error invoking remote method" in the renderer, so every caller goes
	 * through here instead of awaiting the factory directly.
	 */
	const resolveService = async (): Promise<{ service: RemoteHostConnectionService } | { code: string }> => {
		try {
			const service = await input.service?.();
			return service === undefined ? { code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" } : { service };
		} catch (error) {
			return { code: codeOf(error, "REMOTE_CONNECTION_SERVICE_UNAVAILABLE") };
		}
	};

	/**
	 * Validate a path the renderer named. Relative to the confirmed root by construction: an absolute path,
	 * a traversal segment, a control byte or a backslash is refused here, so the helper only ever sees a
	 * value that stays inside the boundary regardless of what the UI sent.
	 *
	 * The empty string is this layer's spelling of "the root". The reader spells it `"."` instead (it
	 * refuses an empty path outright), so the two are translated by `readerPath` — the UI should not have to
	 * know which convention the transport chose.
	 */
	const readRelativePath = (value: unknown): string | undefined => {
		if (typeof value !== "string" || value.length > 4096) return undefined;
		if (/[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
		if (value.startsWith("/")) return undefined;
		if (value === "") return "";
		const segments = value.split("/");
		if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
		return value;
	};

	/** This layer's empty string means the root; the reader's own spelling of that is `"."`. */
	const readerPath = (relative: string): string => (relative === "" ? "." : relative);

	/**
	 * Remote project enrollment (Phase 3 第二段).
	 *
	 * A separate decision from browsing a root: this writes a **persistent project** (`ProjectStore`). It
	 * therefore has its own broker action, its own pending table and its own confirmation push channel, so
	 * a project-enrollment prompt can never arrive in the workspace panel or vice versa. The renderer submits
	 * only `{ hostId, candidatePath }`; the canonical value is resolved here and stays here.
	 */
	const enrollBroker = new PendingConfirmationBroker<{ hostId: string; canonicalPath: string }>({
		onRemoved: (requestId) => {
			enrollOffers.delete(requestId);
		},
	});
	const enrollOffers = new Map<string, { subjectId: string; digest: string }>();
	const enrollAction = "remote:project-enroll";
	/**
	 * 「新建空远端项目」确认：与「使用已有目录」是两个不同的用户决定。独立 broker/pending/推送通道
	 * 都在 remoteProjectCreateIpc 中，两者可同时挂起互不串扰。
	 */
	const createProjectFlow = registerRemoteProjectCreateFlow({
		enabled: input.enabled,
		userDataDir: input.userDataDir,
		projects: input.projects,
		resolveService: async () => {
			const service = await resolveService();
			return "code" in service ? { code: service.code } : { client: service.service.client };
		},
	});
	const enrollDigest = (hostId: string, canonicalPath: string): string =>
		createHash("sha256")
			.update(JSON.stringify(["pideck-project-enroll-v1", hostId, canonicalPath]), "utf8")
			.digest("hex");

	ipcMain.handle(ipcChannels.remoteProjectEnroll, async (event, hostIdValue: unknown, pathValue: unknown, modeValue: unknown): Promise<RemoteProjectEnrollResult> => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		if (input.projects === undefined) return opFailFromCode("REMOTE_PROJECT_ENROLL_UNAVAILABLE");
		if (typeof hostIdValue !== "string" || !HOST_ID.test(hostIdValue)) return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		if (typeof pathValue !== "string") return opFailFromCode("REMOTE_BROWSE_ROOT_INVALID");
		if (modeValue !== undefined && modeValue !== "existing" && modeValue !== "create") return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		const mode: RemoteProjectEnrollMode = modeValue === "create" ? "create" : "existing";
		// 「新建空目录」不是登记：它会在项目根之外执行一次写命令，因此必须先探针、再走独立确认 broker。
		if (mode === "create") {
			const createService = await resolveService();
			if ("code" in createService) return opFailFromCode(createService.code);
			return createProjectFlow.begin(event.sender, createService.service, hostIdValue, pathValue);
		}
		const resolvedService = await resolveService();
		if ("code" in resolvedService) return opFailFromCode(resolvedService.code);
		try {
			// Same pinned probe the workspace panel uses: the canonical value shown here is the one that will be
			// confined to, and a symlink that the handshake would reject can never be confirmed in the first place.
			const resolved = await resolveRemoteBrowseRoot({ userDataDir: input.userDataDir, hostId: hostIdValue, client: resolvedService.service.client, userPath: pathValue });
			const digest = enrollDigest(hostIdValue, resolved.canonicalPath);
			const { requestId, expiresAt } = enrollBroker.begin({ senderId, action: enrollAction, subjectId: hostIdValue, stateDigest: digest, payload: { hostId: hostIdValue, canonicalPath: resolved.canonicalPath } });
			enrollOffers.set(requestId, { subjectId: hostIdValue, digest });
			if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.remoteProjectEnrollConfirm, { requestId, expiresAt, hostId: hostIdValue, label: pathValue, requestedPath: pathValue, canonicalPath: resolved.canonicalPath } satisfies RemoteProjectEnrollRequest);
			return opOk({ status: "pending" as const, hostId: hostIdValue, canonicalPath: resolved.canonicalPath });
		} catch (error) {
			return opFailFromCode(codeOf(error, "REMOTE_PROJECT_TARGET_INVALID"));
		}
	});

	ipcMain.handle(ipcChannels.remoteProjectAnswer, async (event, requestId: unknown, choice: unknown): Promise<RemoteProjectEnrollAnswerResult> => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		if (input.projects === undefined) return opFailFromCode("REMOTE_PROJECT_ENROLL_UNAVAILABLE");
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		if (choice !== "approve" && choice !== "deny") return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		const offered = enrollOffers.get(requestId);
		if (offered === undefined) return opFailFromCode("REMOTE_PROJECT_ENROLL_CONFIRMATION_REQUIRED");
		try {
			const payload = enrollBroker.answer({ requestId, senderId, action: enrollAction, subjectId: offered.subjectId, stateDigest: offered.digest, choice });
			if (payload === null) return opOk({ enrolled: false });
			// The confirmation window is real time, and the world moves inside it: the directory can be deleted,
			// or a symlink along it can be re-pointed at something else. Writing the value the user was *shown*
			// is therefore not enough on its own — that value has to still resolve to itself right now, or the
			// user would be confirming a boundary that no longer exists (or no longer means what it did).
			//
			// Re-probing also re-runs the pinned preflight, so a host that was disabled or retired while the
			// prompt was open fails here instead of being enrolled. Nothing is persisted unless this passes,
			// and the broker already consumed the request, so the user re-enrolls rather than getting a
			// half-written record.
			const resolvedService = await resolveService();
			if ("code" in resolvedService) return opFailFromCode(resolvedService.code);
			try {
				const rechecked = await resolveRemoteBrowseRoot({ userDataDir: input.userDataDir, hostId: payload.hostId, client: resolvedService.service.client, userPath: payload.canonicalPath });
				if (rechecked.canonicalPath !== payload.canonicalPath) return opFailFromCode("REMOTE_PROJECT_ROOT_CHANGED");
			} catch (error) {
				return opFailFromCode(codeOf(error, "REMOTE_PROJECT_ROOT_UNRESOLVED"));
			}
			// Write the durable record only now, with the main-held canonical value. The renderer cannot supply
			// the path, the id or an "already confirmed" flag.
			const { projectId } = await input.projects.enroll({ hostId: payload.hostId, canonicalRemotePath: payload.canonicalPath });
			return opOk({ enrolled: true, projectId });
		} catch (error) {
			return opFailFromCode(codeOf(error, "REMOTE_PROJECT_TARGET_INVALID"));
		}
	});

	const projectReadTarget = createRemoteProjectTargetResolver({ service: input.service, locator: input.projects?.locator });

	/**
	 * Bind the reader's transport to one already-pinned session.
	 *
	 * The host id is re-checked rather than ignored: the reader names a host in its diagnostics, and a port
	 * that silently served another host would make those diagnostics lie.
	 */
	const sessionPort = (session: RemoteProjectSession, hostId: string): RemoteWorkspacePort => ({
		request: (requestHostId, method, params, options) => (requestHostId === hostId ? session.request(method, params, options) : Promise.reject(new Error("SSH_HOST_NOT_READY"))),
		cancel: (requestHostId, requestId, options) => (requestHostId === hostId ? session.cancel(requestId, options) : Promise.reject(new Error("SSH_HOST_NOT_READY"))),
	});

	/**
	 * 目录事实（W3 接线）：**一次内容变化只装载一次**。
	 *
	 * 树、搜索建议、Git 面板的“这个目录里有什么”过去各自问一遍远端；现在同一个 (projectId, 相对路径)
	 * 在同一个装载里合并，并带一个 revision——两个读者据此知道“我看到的是同一份事实”。
	 * 失效只在写面发生时标脏（`afterWrite`），装载成本由读的人决定，一次写不产生任何往返。
	 */
	const watchRegistry = createDirWatchRegistry();

	/**
	 * 事实变化通知的出口（v5 T4）：事实层只标脏，通知由这里发。
	 * 订阅按 (sender, project) 绑定；退订/窗口销毁都清登记（见 `RemoteFactsNotifications`）。
	 */
	const factsEvents: RemoteFactsHub = input.factsEvents ?? createRemoteFactsHub(ipcChannels.remoteProjectFactsChanged);
	/** projectId → 最近一次装载所用的连接代（通知里带出去，渲染层跨代丢弃缓存）。 */
	const projectGenerations = new Map<string, string>();
	/** projectId → hostId（断连时把这一代标成已断开）。 */
	const projectHosts = new Map<string, string>();
	let disconnectedGeneration = 0;
	const generationOf = (projectId: string): string => projectGenerations.get(projectId) ?? "";

	/**
	 * 根目录首次读到就订阅（非递归：覆盖根层与 `.git` 变化；更深目录仍走读的人重读）。
	 *
	 * 会话身份用 `connectionId`：同一次 helper 会话里每次读都拿到新的 session 包装对象，但订阅只能
	 * 有一个。退订绑定到同一个 session，项目关闭/连接释放时成对收回。
	 */
	async function ensureRootWatch(projectId: string, hostId: string, session: RemoteProjectSession): Promise<void> {
		await watchRegistry.ensure(
			hostId,
			session.connectionId,
			projectId,
			async (paths) => {
				try {
					const result: unknown = await session.request("fs.watch", { paths: [...paths] });
					return typeof result === "object" && result !== null && typeof (result as { watchId?: unknown }).watchId === "string" ? (result as { watchId: string }).watchId : undefined;
				} catch {
					/* 订阅不是读的前置条件：失败就退回只读刷新，不向用户报错。 */
					return undefined;
				}
			},
			{
				paths: [""],
				unwatch: (watchId) => session.request("fs.unwatch", { watchId }),
			},
		);
	}

	const dirs: FactCache<RemoteWorkspaceEntry[]> = createFactCache<RemoteWorkspaceEntry[]>(async (key) => {
		const separator = key.indexOf("\u0000");
		const projectId = key.slice(0, separator);
		const relative = key.slice(separator + 1);
		const target = await projectReadTarget(projectId);
		if ("code" in target) return opFailFromCode(target.code);
		try {
			const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				// 连接代与 host 归属记在这里：事件/写面通知带去给渲染层，断连时据此换代。
				projectGenerations.set(projectId, session.connectionId);
				projectHosts.set(projectId, target.hostId);
				const reader = createRemoteWorkspaceReader({ port: sessionPort(session, target.hostId) });
				const listed = await reader.list(target.hostId, readerPath(relative));
				// 根目录第一次读到就顺手订阅：之后 helper 的变更事件会把这个项目的事实标脏。
				if (relative === "") await ensureRootWatch(projectId, target.hostId, session);
				return listed;
			});
			if (!outcome.ok) return opFailFromCode(outcome.code);
			// 两类条目不属于用户数据：回收站命名空间（只在根目录隐藏）与本通道自己的上传临时文件。
			return opOk(outcome.value.entries.filter((entry) => (relative !== "" || entry.name !== REMOTE_PROJECT_TRASH_DIR) && !REMOTE_UPLOAD_TEMP_NAME.test(entry.name)).map((entry) => ({ name: entry.name, kind: entry.kind, ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }) })));
		} catch (error) {
			return opFailFromCode(codeOf(error, "REMOTE_PROJECT_READ_FAILED"));
		}
	});

	/**
	 * 目录事实读（list 与公共目录页共用）：暖缓存命中也要逐次重解析当前项目/连接。
	 *
	 * `force` 只给显式刷新用：越过已完成缓存；在途同代装载仍可合并。
	 */
	async function readDirSnapshot(projectId: string, relative: string, force: boolean): Promise<{ ok: true; snapshot: { value: RemoteWorkspaceEntry[]; revision: number } } | { ok: false; code: string }> {
		const target = await projectReadTarget(projectId);
		if ("code" in target) return { ok: false, code: target.code };
		const key = projectId + "\u0000" + relative;
		// 只有暖事实才要求活的同代会话；首次打开目录必须允许正常建立会话。
		const existing = dirs.peek(key);
		const connection = target.service.connectionFacts?.(target.hostId);
		if (typeof target.service.connectionFacts === "function" && existing !== undefined && (connection === undefined || connection.state !== "ready")) return { ok: false, code: "SSH_HOST_NOT_READY" };
		const snapshot = await dirs.read(key, { ...(connection === undefined ? {} : { generation: connection.connectionId }), force });
		return snapshot.ok ? { ok: true, snapshot } : { ok: false, code: snapshot.code };
	}

	ipcMain.handle(ipcChannels.remoteProjectList, async (_event, projectIdValue: unknown, pathValue: unknown): Promise<RemoteProjectListResult> => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		const relative = readRelativePath(pathValue);
		if (relative === undefined) return opFailFromCode("REMOTE_PROJECT_PATH_INVALID");
		if (typeof projectIdValue !== "string") return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		const read = await readDirSnapshot(projectIdValue, relative, false);
		if (!read.ok) return opFailFromCode(read.code);
		// revision 随值替换或标脏递增：两个读者拿到同一个数就说明他们看的是同一份事实。
		return opOk({ entries: read.snapshot.value, revision: read.snapshot.revision });
	});

	ipcMain.handle(ipcChannels.remoteProjectFactsSubscribe, (event, projectIdValue: unknown) => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		if (typeof projectIdValue !== "string" || projectIdValue.length === 0 || projectIdValue.length > 256 || projectIdValue !== projectIdValue.trim() || /[\u0000-\u001f\u007f]/.test(projectIdValue)) return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		factsEvents.subscribe(event.sender, projectIdValue);
		return opOk({ subscribed: true as const });
	});
	ipcMain.handle(ipcChannels.remoteProjectFactsUnsubscribe, (event, projectIdValue: unknown) => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		if (typeof projectIdValue !== "string" || projectIdValue.length === 0 || projectIdValue.length > 256) return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		factsEvents.unsubscribe(event.sender.id, projectIdValue);
		return opOk({ subscribed: false as const });
	});

	ipcMain.handle(ipcChannels.remoteProjectRead, async (_event, projectIdValue: unknown, pathValue: unknown): Promise<RemoteProjectReadResult> => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		// The read of the root itself is not a file; an empty path is a valid listing target but never a read.
		const relative = readRelativePath(pathValue);
		if (relative === undefined || relative === "") return opFailFromCode("REMOTE_PROJECT_PATH_INVALID");
		// 回收站不是用户可读的项目文件：读通道在这里拒绝（只读列表隐藏、回收站三通道单独授权）。
		if (relative === REMOTE_PROJECT_TRASH_DIR || relative.startsWith(REMOTE_PROJECT_TRASH_DIR + "/")) return opFailFromCode("REMOTE_FILE_PROTECTED_PATH");
		const target = await projectReadTarget(projectIdValue);
		if ("code" in target) return opFailFromCode(target.code);
		try {
			// The sizing stat, every chunk and the closing stat all happen under one host operation, so no
			// other project can switch the root between two chunks of this file.
			const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				const reader = createRemoteWorkspaceReader({ port: sessionPort(session, target.hostId) });
				return reader.readFile(target.hostId, relative);
			});
			if (!outcome.ok) return opFailFromCode(outcome.code);
			const file = outcome.value;
			return opOk({ contentBase64: Buffer.from(file.content).toString("base64"), bytes: file.bytes, mtimeMs: file.mtimeMs });
		} catch (error) {
			return opFailFromCode(codeOf(error, "REMOTE_PROJECT_READ_FAILED"));
		}
	});

	/**
	 * 项目内**文件名**搜索（不含内容搜索）。
	 *
	 * 与 listProject/readProjectFile 同构：解析 locator → host/root，整次搜索都在 withProjectSession 的受控
	 * 边界内完成，因此一次搜索不会横跨两个 root。query 来自渲染层，在这里（IPC 边界）先按契约校验一次，
	 * reader 内部还会再校验一次；非法 query 一个帧都不发出去。
	 *
	 * `truncated` 必须如实透传：它表示遍历在某一项上限处收束，界面据此显示「结果已截断」，而不是把一屏
	 * 结果伪装成完整答案。
	 */
	ipcMain.handle(ipcChannels.remoteProjectSearch, async (_event, projectIdValue: unknown, pathValue: unknown, queryValue: unknown): Promise<RemoteProjectSearchResult> => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		const relative = readRelativePath(pathValue);
		if (relative === undefined) return opFailFromCode("REMOTE_PROJECT_PATH_INVALID");
		// 渲染层来的值一律不可信：长度与控制字节在这里就拒，绝不把非法 query 发到远端。
		if (typeof queryValue !== "string" || queryValue.length === 0 || queryValue.length > REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(queryValue)) return opFailFromCode(REMOTE_SEARCH_READER_CODES.queryInvalid);
		const target = await projectReadTarget(projectIdValue);
		if ("code" in target) return opFailFromCode(target.code);
		try {
			const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				const reader = createRemoteSearchReader({ port: sessionPort(session, target.hostId) });
				return reader.search(target.hostId, readerPath(relative), queryValue);
			});
			if (!outcome.ok) return opFailFromCode(outcome.code);
			const result = outcome.value;
			// 只把界面要用的字段接过去；远端多余字段在 reader 里已被拒，这里再显式重建一次。
			// 递归搜索会命中回收站里的归档条目，但它们不是用户可搜索的文件：按首段过滤整棵 .pideck-trash。
			return opOk({
				entries: result.entries.filter((entry) => entry.path.split("/")[0] !== REMOTE_PROJECT_TRASH_DIR && !REMOTE_UPLOAD_TEMP_NAME.test(entry.path.split("/").at(-1) ?? "")).map((entry) => ({ path: entry.path, name: entry.name, kind: entry.kind, ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }) })),
				scanned: result.scanned,
				truncated: result.truncated,
			});
		} catch (error) {
			return opFailFromCode(codeOf(error, "REMOTE_PROJECT_READ_FAILED"));
		}
	});

	/**
	 * 项目级 root 复核状态（第四批设计 (i)）。
	 *
	 * 只读既往复核结果：不连主机、不发任何 helper 请求、不建立会话，也不在这里重新复核（复核只在建立/恢复
	 * 会话时发生）。projectId → (hostId, remotePath) 由 main 从项目库解析，渲染层不传路径，因此同一个 host 上
	 * 某个项目漂移不会污染另一个健康项目的答案——这正是 (i) 相对「接到主机级 needs-attention」的价值。
	 * projectReadTarget 已经做完全部入参/归属校验（非法 id、未知项目、非 ssh 项目各自的稳定码），这里复用它，
	 * 但只取 locator 与 service，不碰会话。
	 */
	ipcMain.handle(ipcChannels.remoteProjectRootStatus, async (_event, projectIdValue: unknown): Promise<RemoteProjectRootStatusResult> => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		const target = await projectReadTarget(projectIdValue);
		if ("code" in target) return opFailFromCode(target.code);
		const status = target.service.projectRootStatus(target.hostId, target.remotePath);
		return opOk(status.status === "ok" ? { status: "ok" } : { status: "needs-attention", code: status.code });
	});

	return {
		afterWrite(projectId: string, paths: readonly string[]): void {
			const touched = dirPathsAfterWrite(paths);
			for (const key of dirKeysAfterWrite(projectId, paths)) dirs.invalidate(key);
			// 只标脏 + 通知：读仍由活跃的消费者决定（一次写不产生远端往返）。
			factsEvents.publish({ projectId, generation: generationOf(projectId), scopes: touched.map((path) => ({ kind: "dir" as const, path })) });
		},
		async directoryPage(projectId: string, path: string, force = false): Promise<ProjectDirectoryPageResult> {
			const relative = readRelativePath(path);
			if (relative === undefined) return opFailFromCode("REMOTE_PROJECT_PATH_INVALID");
			const read = await readDirSnapshot(projectId, relative, force);
			if (!read.ok) return opFailFromCode(read.code);
			const prefix = relative === "" ? "" : relative + "/";
			const entries = read.snapshot.value
				.filter((entry) => entry.kind === "file" || entry.kind === "directory")
				.map((entry) => ({
					target: { projectId, relativePath: prefix + entry.name },
					relativePath: prefix + entry.name,
					type: entry.kind as "file" | "directory",
					// helper 的 fs.list 不逐项探测：远端只能是 unknown，不能伪装成“没有子项”。
					hasChildren: (entry.kind === "directory" ? "unknown" : false) as boolean | "unknown",
				}));
			return opOk({ entries: entries.slice(0, 2000), truncated: entries.length > 2000, revision: read.snapshot.revision, generation: generationOf(projectId) });
		},
		async pathsExist(projectId: string, paths: readonly string[]): Promise<ProjectPathsExistResult> {
			const relativePaths: string[] = [];
			for (const path of paths) {
				const relative = readRelativePath(path);
				if (relative === undefined) return opFailFromCode("REMOTE_PROJECT_PATH_INVALID");
				relativePaths.push(relative);
			}
			const target = await projectReadTarget(projectId);
			if ("code" in target) return opFailFromCode(target.code);
			try {
				const outcome = await target.service.withProjectSession(
					target.hostId,
					target.remotePath,
					async (session) => {
						const reader = createRemoteWorkspaceReader({ port: sessionPort(session, target.hostId) });
						const states: ProjectPathState[] = [];
						// 128 路径 = 2 帧（≤64/帧）；批量是全有或全无，含缺失路径时退回逐项只读 stat，
						// 仍然不签发任何 entry/文本授权。
						for (let offset = 0; offset < relativePaths.length; offset += 64) {
							const batch = relativePaths.slice(offset, offset + 64);
							try {
								const answer = await reader.statMany(target.hostId, batch.map(readerPath));
								for (let index = 0; index < batch.length; index += 1) states.push({ target: { projectId, relativePath: batch[index] }, exists: true, isDirectory: answer.entries[index]?.kind === "directory" });
							} catch (error) {
								if (codeOf(error, "REMOTE_PROJECT_READ_FAILED") !== "PATH_NOT_FOUND") throw error;
								for (const relativePath of batch) {
									try {
										const fileStat = await reader.stat(target.hostId, readerPath(relativePath));
										states.push({ target: { projectId, relativePath }, exists: true, isDirectory: fileStat.kind === "directory" });
									} catch (inner) {
										if (codeOf(inner, "REMOTE_PROJECT_READ_FAILED") !== "PATH_NOT_FOUND") throw inner;
										states.push({ target: { projectId, relativePath }, exists: false, isDirectory: false });
									}
								}
							}
						}
						return states;
					},
					{ requireReady: true },
				);
				return outcome.ok ? opOk(outcome.value) : opFailFromCode(outcome.code);
			} catch (error) {
				return opFailFromCode(codeOf(error, "REMOTE_PROJECT_READ_FAILED"));
			}
		},
		onHelperEvent(entry): void {
			const changed = watchRegistry.scopesForEvent(entry.hostId, entry.watchId) ?? [];
			// 先发通知再标脏：两者都是同步的，读仍由活跃的消费者决定（事件不装载）。
			for (const scope of changed) factsEvents.publish({ projectId: scope.projectId, generation: generationOf(scope.projectId), scopes: scope.paths.map((path) => ({ kind: "dir" as const, path })) });
			for (const scope of changed) {
				for (const path of scope.paths) dirs.invalidate(scope.projectId + " " + path);
			}
		},
		dirLoads(): number {
			return dirs.stats().loads;
		},
		onHostDisconnected(hostId: string): void {
			// helper 已死：旧的 watchId 不可能再回来，登记直接丢弃，不发退订。
			watchRegistry.clearHost(hostId);
			// 断连换代：旧代缓存与渲染层持有的快照都不能再被当作“现在”。
			disconnectedGeneration += 1;
			for (const [projectId, projectHost] of projectHosts) if (projectHost === hostId) projectGenerations.set(projectId, `${hostId}#disconnected#${disconnectedGeneration}`);
		},
		closeProject(projectId: string): Promise<void> {
			return watchRegistry.closeProject(projectId);
		},
		dispose(): Promise<void> {
			return watchRegistry.releaseAll();
		},
	};
}
