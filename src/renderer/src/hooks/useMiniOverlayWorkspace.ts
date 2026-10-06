import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import type { AgentBackend, AvailableModel, ResolvedLaunchDefaults, SessionLaunchPreferences, SessionModelPreference, SessionRecord } from "../../../shared/types";
import { createSessionModelPreference } from "../../../shared/modelDisplayName";
import { currentSessionAtom, effectiveAgentBackendAtom, projectInventoryAtom } from "../atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

export type MiniOverlayWorkspaceOptions = {
	activeProjectId?: string;
	onCreateSession: (projectId: string, preferences: SessionLaunchPreferences, backend: AgentBackend) => Promise<SessionRecord | undefined>;
	onOpenSession: (projectId: string, sessionId: string) => Promise<string | undefined>;
};

/** 小窗导航与新建草稿的唯一 owner；复用会话命令，不自建第二套激活/目录状态。 */
export function useMiniOverlayWorkspace(options: MiniOverlayWorkspaceOptions) {
	const projects = useAtomValue(projectInventoryAtom);
	const session = useAtomValue(currentSessionAtom);
	const backend = useAtomValue(effectiveAgentBackendAtom);
	const [view, setView] = useState<"home" | "new" | "session">(session ? "session" : "home");
	const [projectId, setProjectId] = useState(session?.projectId ?? options.activeProjectId);
	const [selectedModel, setSelectedModel] = useState<{ projectId?: string; backend: AgentBackend; model: SessionModelPreference }>();
	const [defaults, setDefaults] = useState<ResolvedLaunchDefaults>();
	const [recentSessions, setRecentSessions] = useState<SessionRecord[]>([]);
	const [recentLoading, setRecentLoading] = useState(false);
	const [recentFailed, setRecentFailed] = useState(false);
	const [creating, setCreating] = useState(false);
	const [openingSessionId, setOpeningSessionId] = useState<string>();
	const pendingRef = useRef(false);
	const mountedRef = useRef(true);
	const commandsRef = useRef(options);
	commandsRef.current = options;
	const previousSessionIdRef = useRef(session?.id);
	const project = projects.find((item) => item.id === projectId);
	// 点选只属于当前项目/后端，切目录不能带入另一项目的局部模型。
	const model = selectedModel?.projectId === projectId && selectedModel?.backend === backend ? selectedModel.model : undefined;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		if (session && session.id !== previousSessionIdRef.current) {
			setProjectId(session.projectId);
			setView("session");
		}
		previousSessionIdRef.current = session?.id;
	}, [session?.id, session?.projectId]);

	useEffect(() => {
		let cancelled = false;
		setDefaults(undefined);
		void desktopApi.sessions
			.resolveLaunchDefaults({ backend })
			.then((next) => {
				if (!cancelled) setDefaults(next);
			})
			.catch(() => {
				// 默认值展示失败不阻止创建；主进程仍按创建瞬间的配置解析。
			});
		return () => {
			cancelled = true;
		};
	}, [backend]);

	useEffect(() => {
		let cancelled = false;
		setRecentSessions([]);
		setRecentFailed(false);
		setRecentLoading(Boolean(projectId && !project?.missing && view === "home"));
		if (projectId && !project?.missing && view === "home") {
			void desktopApi.sessions
				.listCatalog(projectId)
				.then((records) => {
					if (cancelled) return;
					setRecentSessions(
						records
							.filter((item) => !item.parentSessionId && !item.parentSessionPath && !item.noSession)
							.sort((a, b) => b.updatedAt - a.updatedAt)
							.slice(0, 5),
					);
					setRecentLoading(false);
				})
				.catch(() => {
					if (cancelled) return;
					setRecentFailed(true);
					setRecentLoading(false);
				});
		}
		return () => {
			cancelled = true;
		};
	}, [projectId, project?.missing, view, session?.id]);

	const selectProject = useCallback((id: string) => {
		setProjectId(id);
		setSelectedModel(undefined);
	}, []);
	const selectModel = useCallback(
		(next: AvailableModel) => {
			setSelectedModel({ projectId, backend, model: createSessionModelPreference(next.provider, next.id, next.name) });
		},
		[projectId, backend],
	);
	const showNewSession = useCallback(() => {
		setSelectedModel(undefined);
		setView("new");
	}, []);
	const showHome = useCallback(() => setView("home"), []);
	const showSession = useCallback(() => {
		if (session) setView("session");
	}, [session]);

	const createSession = useCallback(async () => {
		if (!project || project.missing || pendingRef.current) return;
		pendingRef.current = true;
		setCreating(true);
		try {
			// 只有用户显式点选才传 model；只读预览的默认值不能固化成创建偏好。
			const record = await commandsRef.current.onCreateSession(project.id, model ? { model } : {}, backend);
			if (record && mountedRef.current) setView("session");
		} catch {
			if (mountedRef.current) showNotice(t("miniOverlay.createSessionFailed"), 4000, "error");
		} finally {
			pendingRef.current = false;
			if (mountedRef.current) setCreating(false);
		}
	}, [project, model, backend]);
	const openSession = useCallback(
		async (id: string) => {
			if (!project || project.missing || pendingRef.current) return;
			pendingRef.current = true;
			setOpeningSessionId(id);
			try {
				const opened = await commandsRef.current.onOpenSession(project.id, id);
				if (opened && mountedRef.current) setView("session");
			} catch {
				if (mountedRef.current) showNotice(t("miniOverlay.openSessionFailed"), 4000, "error");
			} finally {
				pendingRef.current = false;
				if (mountedRef.current) setOpeningSessionId(undefined);
			}
		},
		[project],
	);

	return {
		view,
		projects,
		project,
		session,
		backend,
		displayModel: model ?? defaults?.model,
		selectedModel: model,
		recentSessions,
		recentLoading,
		recentFailed,
		creating,
		openingSessionId,
		selectProject,
		selectModel,
		clearModel: () => setSelectedModel(undefined),
		showNewSession,
		showHome,
		showSession,
		createSession,
		openSession,
	};
}

export type MiniOverlayWorkspace = ReturnType<typeof useMiniOverlayWorkspace>;
