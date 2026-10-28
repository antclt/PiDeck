import { useCallback, useEffect, useRef, useState } from "react";
import { toggleTaskCheckbox as toggleTaskLine } from "../components/scratchPad/scratchPadLists";
import type { DraftMeta, ScratchPadScope } from "../../../shared/types";
import type { WorkspaceDrawerPanel } from "./useWorkspacePanels";

const AUTOSAVE_DELAY = 1500;
/** 旧调用方/测试不传 scope 时保持历史行为：全局一份草稿。 */
const GLOBAL_SCOPE: ScratchPadScope = { kind: "global" };

type UseScratchPadMode = "edit" | "preview";

type ScratchPadDrawerControls = {
	drawer: WorkspaceDrawerPanel | null;
	drawerCollapsed: boolean;
	openDrawerForce: (panel: WorkspaceDrawerPanel) => void;
	closeDrawer: () => void;
	/** 草稿作用域：project=当前项目一份（列表含全局草稿）；global=全局共用。缺省 global。 */
	scope?: ScratchPadScope;
};

type UseScratchPadResult = {
	isOpen: boolean;
	drafts: DraftMeta[];
	currentDraftPath: string | null;
	content: string;
	mode: UseScratchPadMode;
	isSaving: boolean;
	hasError: boolean;
	open: () => void;
	close: () => void;
	toggle: () => void;
	setContent: (value: string) => void;
	setMode: (mode: UseScratchPadMode) => void;
	toggleTaskCheckbox: (lineIndex: number) => void;
	saveNow: () => Promise<void>;
	exportFile: () => Promise<void>;
	/** 切换当前草稿，同时保存当前草稿 */
	selectDraft: (draftPath: string) => Promise<void>;
	/** 创建新草稿（落在当前作用域） */
	createDraft: () => Promise<void>;
	/** 删除指定草稿，如果删除的是当前草稿则自动切换到第一个可用草稿 */
	deleteDraft: (draftPath: string) => Promise<void>;
};

function scopeKeyOf(scope: ScratchPadScope): string {
	return scope.kind === "global" ? "global" : `project:${scope.projectId}`;
}

/**
 * 草稿内容常驻 App；可见性、切换与关闭动画由工作区抽屉单一管理。
 *
 * 作用域（2026-10）：项目/全局两档。切换作用域时先把上一份草稿的未落盘内容写回原路径，
 * 再装载新作用域的列表；异步装载用 generation 防竞态（快速切项目时旧响应不得覆盖新列表）。
 * 作用域内没有草稿时，首次输入才懒创建——不在每次切项目时凭空生成空文件。
 */
export function useScratchPad({ drawer, drawerCollapsed, openDrawerForce, closeDrawer, scope = GLOBAL_SCOPE }: ScratchPadDrawerControls): UseScratchPadResult {
	const isOpen = drawer === "scratchPad" && !drawerCollapsed;
	const [drafts, setDrafts] = useState<DraftMeta[]>([]);
	const [currentDraftPath, setCurrentDraftPath] = useState<string | null>(null);
	const [content, setContentState] = useState("");
	const [mode, setMode] = useState<UseScratchPadMode>("edit");
	const [isSaving, setIsSaving] = useState(false);
	const [hasError, setHasError] = useState(false);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** 懒创建进行中的 create：带上作用域 key，切作用域后不得复用旧作用域的 Promise。 */
	const createStateRef = useRef<{ scopeKey: string; promise: Promise<string | null> } | null>(null);

	// 用于回调中获取最新 scope/content/currentDraftPath，避免闭包过期
	const scopeRef = useRef(scope);
	scopeRef.current = scope;
	const scopeKey = scopeKeyOf(scope);
	const scopeKeyRef = useRef(scopeKey);
	scopeKeyRef.current = scopeKey;
	const contentRef = useRef(content);
	contentRef.current = content;
	const currentDraftPathRef = useRef(currentDraftPath);
	currentDraftPathRef.current = currentDraftPath;
	/** 当前列表/内容属于哪个作用域；null = 尚未装载。切走时用它把未落盘内容写回旧作用域。 */
	const loadedScopeRef = useRef<{ key: string; scope: ScratchPadScope } | null>(null);
	/** 作用域装载代际：异步响应回来时对不上就丢弃。 */
	const loadGenerationRef = useRef(0);

	const setDraftPath = useCallback((draftPath: string | null) => {
		currentDraftPathRef.current = draftPath;
		setCurrentDraftPath(draftPath);
	}, []);

	const setContentValue = useCallback((value: string) => {
		contentRef.current = value;
		setContentState(value);
	}, []);

	/** 列表刷新（保存后更新 updatedAt），不改变当前选中项。 */
	const refreshDrafts = useCallback(async (targetScope: ScratchPadScope, generation: number) => {
		const api = window.piDesktop?.scratchPad;
		if (!api) return;
		try {
			const list = await api.list(targetScope);
			if (generation !== loadGenerationRef.current) return;
			setDrafts(list);
		} catch {
			// 列表刷新失败不影响已保存内容
		}
	}, []);

	/** 加载指定草稿内容；调用方负责 generation 校验（装载/切换共用）。 */
	const loadDraftContent = useCallback(
		async (draftPath: string) => {
			const api = window.piDesktop?.scratchPad;
			if (!api) return;
			const generation = loadGenerationRef.current;
			try {
				const data = await api.load(draftPath);
				if (generation !== loadGenerationRef.current) return;
				setContentValue(data.content ?? "");
			} catch {
				if (generation !== loadGenerationRef.current) return;
				setContentValue("");
			}
		},
		[setContentValue],
	);

	/** 装载一个作用域：先列表，再自动选中最近更新的一份。 */
	const loadScope = useCallback(
		async (targetScope: ScratchPadScope, generation: number) => {
			const api = window.piDesktop?.scratchPad;
			if (!api) return;
			try {
				const list = await api.list(targetScope);
				if (generation !== loadGenerationRef.current) return;
				setDrafts(list);
				// 进入项目时优先打开本项目草稿：否则最近编辑过的全局草稿会被自动选中，
				// 看起来像「切了项目但草稿没跟着变」；全局草稿仍可从下拉里选。
				const preferredScope = targetScope.kind === "project" ? "project" : "global";
				const first = list.find((draft) => draft.scope === preferredScope) ?? list[0];
				if (!first) {
					setDraftPath(null);
					setContentValue("");
					return;
				}
				setDraftPath(first.path);
				const data = await api.load(first.path);
				if (generation !== loadGenerationRef.current) return;
				setContentValue(data.content ?? "");
			} catch {
				if (generation !== loadGenerationRef.current) return;
				setDrafts([]);
				setDraftPath(null);
				setContentValue("");
			}
		},
		[setContentValue, setDraftPath],
	);

	// 作用域切换：先把上一份草稿的未落盘内容写回原路径，再装载新列表。
	// 初始挂载同样走这里（loadedScopeRef 为 null）。
	useEffect(() => {
		const api = window.piDesktop?.scratchPad;
		if (!api) return;
		const previous = loadedScopeRef.current;
		if (previous?.key === scopeKey) return;
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		const previousContent = contentRef.current;
		const previousPath = currentDraftPathRef.current;
		if (previousPath) {
			// 作用域切换期间的落盘失败不阻断新作用域装载；原草稿仍在磁盘上，最多丢最后一次未保存编辑。
			void api.save(previousPath, previousContent, 0).catch(() => undefined);
		} else if (previous && previousContent) {
			// 旧作用域还没有草稿但已经打了字：先懒创建再落盘，否则切项目/切全局会丢这段输入。
			void (async () => {
				try {
					const created = await api.create(previous.scope);
					await api.save(created.path, previousContent, 0);
				} catch {
					// 兜底落盘失败不阻断新作用域装载
				}
			})();
		}
		loadedScopeRef.current = { key: scopeKey, scope: scopeRef.current };
		const generation = ++loadGenerationRef.current;
		setDrafts([]);
		setDraftPath(null);
		setContentValue("");
		setHasError(false);
		void loadScope(scopeRef.current, generation);
	}, [loadScope, scopeKey, setContentValue, setDraftPath]);

	/** 立即保存指定草稿 */
	const flushSave = useCallback(
		async (draftPath: string, value: string) => {
			if (!window.piDesktop?.scratchPad || !draftPath) return;
			setIsSaving(true);
			setHasError(false);
			const generation = loadGenerationRef.current;
			try {
				await window.piDesktop.scratchPad.save(draftPath, value, 0);
				// 保存后刷新列表以更新 updatedAt 时间
				void refreshDrafts(scopeRef.current, generation);
			} catch {
				setHasError(true);
			} finally {
				setIsSaving(false);
			}
		},
		[refreshDrafts],
	);

	/**
	 * 保证当前作用域有一份草稿可写：作用域内还没有草稿时，首次输入/关闭面板时懒创建。
	 * 并发输入共用同一个 create Promise；作用域在创建期间切换则丢弃结果（新草稿仍属旧作用域）。
	 */
	const ensureDraftPath = useCallback(
		async (expectedScopeKey = scopeKeyRef.current): Promise<string | null> => {
			const api = window.piDesktop?.scratchPad;
			if (!api) return null;
			// 作用域已切换：不要拿旧作用域的待保存内容到新作用域里建草稿。
			if (scopeKeyRef.current !== expectedScopeKey) return null;
			if (currentDraftPathRef.current) return currentDraftPathRef.current;
			if (createStateRef.current?.scopeKey === expectedScopeKey) return createStateRef.current.promise;
			const targetScope = scopeRef.current;
			const targetKey = scopeKeyRef.current;
			const promise = (async () => {
				try {
					const created = await api.create(targetScope);
					if (scopeKeyRef.current !== targetKey) return null;
					setDraftPath(created.path);
					setDrafts((prev) => [created, ...prev]);
					return created.path;
				} catch {
					setHasError(true);
					return null;
				}
			})();
			const state = { scopeKey: targetKey, promise };
			createStateRef.current = state;
			try {
				return await promise;
			} finally {
				if (createStateRef.current === state) createStateRef.current = null;
			}
		},
		[setDraftPath],
	);

	const savePending = useCallback(async () => {
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		const value = contentRef.current;
		const targetKey = scopeKeyRef.current;
		let draftPath = currentDraftPathRef.current;
		if (!draftPath) {
			// 空内容不凭空建草稿（避免每个打开过的项目都多一份空文件）。
			if (!value) return;
			draftPath = await ensureDraftPath(targetKey);
			if (!draftPath) return;
		}
		// 作用域在等待期间变了：这份内容属于旧作用域，已由切换逻辑写回原路径。
		if (scopeKeyRef.current !== targetKey) return;
		// 等 create 期间用户可能又输入了：落盘时取最新内容，避免旧值覆盖新编辑。
		await flushSave(draftPath, contentRef.current);
	}, [ensureDraftPath, flushSave]);

	const setContent = useCallback(
		(value: string) => {
			contentRef.current = value;
			setContentState(value);
			setHasError(false);
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(() => {
				saveTimerRef.current = null;
				void savePending();
			}, AUTOSAVE_DELAY);
		},
		[savePending],
	);

	const close = useCallback(() => {
		if (drawer === "scratchPad") closeDrawer();
	}, [drawer, closeDrawer]);

	const open = useCallback(() => openDrawerForce("scratchPad"), [openDrawerForce]);

	const toggle = useCallback(() => {
		if (isOpen) {
			close();
		} else {
			open();
		}
	}, [isOpen, open, close]);

	const saveNow = useCallback(() => savePending(), [savePending]);

	// 侧栏关闭、切到其他面板或切换项目都走同一可见性边界，不能只在 X 按钮保存。
	const wasOpenRef = useRef(isOpen);
	useEffect(() => {
		if (wasOpenRef.current && !isOpen) void saveNow();
		wasOpenRef.current = isOpen;
	}, [isOpen, saveNow]);

	// 快捷键常驻，不依赖草稿面板挂载；菜单已消费的 Escape 不再关闭整个侧栏。
	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "s") {
				event.preventDefault();
				toggle();
			} else if (event.key === "Escape" && isOpen) {
				event.stopPropagation();
				close();
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [close, isOpen, toggle]);

	useEffect(
		() => () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		},
		[],
	);

	const exportFile = useCallback(async () => {
		await saveNow();
		const draftPath = currentDraftPathRef.current;
		if (draftPath) {
			await window.piDesktop?.scratchPad?.export(draftPath);
		}
	}, [saveNow]);

	/** 切换草稿：先保存当前，再加载新草稿 */
	const selectDraft = useCallback(
		async (draftPath: string) => {
			if (draftPath === currentDraftPathRef.current) return;
			// 先保存当前草稿（没有草稿路径时会在当前作用域懒创建）
			await savePending();
			setDraftPath(draftPath);
			await loadDraftContent(draftPath);
		},
		[loadDraftContent, savePending, setDraftPath],
	);

	/** 创建新草稿：落在当前作用域（项目作用域即使正看着全局草稿，也新建到本项目）。 */
	const createDraft = useCallback(async () => {
		const api = window.piDesktop?.scratchPad;
		if (!api) return;
		await savePending();
		const targetScope = scopeRef.current;
		const targetKey = scopeKeyRef.current;
		try {
			const newDraft = await api.create(targetScope);
			if (scopeKeyRef.current !== targetKey) return;
			setDrafts((prev) => [newDraft, ...prev]);
			setDraftPath(newDraft.path);
			setContentValue("");
		} catch {
			setHasError(true);
		}
	}, [savePending, setContentValue, setDraftPath]);

	/** 删除草稿 */
	const deleteDraft = useCallback(
		async (draftPath: string) => {
			const api = window.piDesktop?.scratchPad;
			if (!api) return;
			try {
				await api.delete(draftPath);
			} catch {
				setHasError(true);
				return;
			}
			// 本地更新列表
			const remaining = drafts.filter((d) => d.path !== draftPath);
			setDrafts(remaining);
			// 如果删除的是当前草稿，切换到第一个可用草稿
			if (draftPath === currentDraftPathRef.current) {
				const first = remaining[0];
				if (first) {
					setDraftPath(first.path);
					await loadDraftContent(first.path);
				} else {
					setDraftPath(null);
					setContentValue("");
				}
			}
		},
		[drafts, loadDraftContent, setContentValue, setDraftPath],
	);

	// 应用退出前保存
	useEffect(() => {
		const handler = () => {
			const draftPath = currentDraftPathRef.current;
			const value = contentRef.current;
			if (draftPath && window.piDesktop?.scratchPad) {
				void window.piDesktop.scratchPad.save(draftPath, value, 0);
			}
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, []);

	const setModeValue = useCallback((m: UseScratchPadMode) => setMode(m), []);

	/* 切换指定行（task list 项）的选中状态：直接根据源 markdown 行号反转 */
	const toggleTaskCheckbox = useCallback(
		(lineIndex: number) => {
			setContent(toggleTaskLine(content, lineIndex));
		},
		[content, setContent],
	);

	return {
		isOpen,
		drafts,
		currentDraftPath,
		content,
		mode,
		isSaving,
		hasError,
		open,
		close,
		toggle,
		setContent,
		setMode: setModeValue,
		toggleTaskCheckbox,
		saveNow,
		exportFile,
		selectDraft,
		createDraft,
		deleteDraft,
	};
}
