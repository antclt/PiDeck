/**
 * 会话列「页面式工作区」的 Tab 状态纯逻辑（定时任务 / 智能体）。
 *
 * 页面 Tab 与会话 Tab 同栏并列，但不是会话：不进 sessionTabIds、不参与固定/拖拽/分屏，
 * 也不参与 pi 的自动会话标题。行为约定：
 * - 切到会话只是「失活」：页面 Tab 保留、页面子树保持挂载，搜索/编辑/滚动状态不丢；
 * - 关闭页面 Tab 才从列表移除，页面子树卸载（下次打开是全新状态）；
 * - 已打开的页面重复点入口只激活，不重复建 Tab。
 */
export type WorkspacePageId = "automation" | "agents";

export type WorkspacePageTabState = {
	/** 已打开的页面 Tab（按打开顺序）。 */
	tabs: readonly WorkspacePageId[];
	/** 当前呈现的页面；null = 呈现会话（页面 Tab 可仍打开，只是失活）。 */
	active: WorkspacePageId | null;
};

export const EMPTY_WORKSPACE_PAGE_TAB_STATE: WorkspacePageTabState = { tabs: [], active: null };

export function isWorkspacePageId(value: unknown): value is WorkspacePageId {
	return value === "automation" || value === "agents";
}

/** 打开并激活页面：已打开的 Tab 只激活，不重复登记（侧栏入口重复点回到已有页面）。 */
export function openWorkspacePage(state: WorkspacePageTabState, pageId: WorkspacePageId): WorkspacePageTabState {
	const tabs = state.tabs.includes(pageId) ? state.tabs : [...state.tabs, pageId];
	if (tabs === state.tabs && state.active === pageId) return state;
	return { tabs, active: pageId };
}

/** 切到会话：页面 Tab 保留，只让出呈现位。 */
export function deactivateWorkspacePage(state: WorkspacePageTabState): WorkspacePageTabState {
	return state.active === null ? state : { ...state, active: null };
}

/** 关闭页面 Tab；关的正是当前呈现页面时回到会话。 */
export function closeWorkspacePage(state: WorkspacePageTabState, pageId: WorkspacePageId): WorkspacePageTabState {
	if (!state.tabs.includes(pageId)) return state;
	return { tabs: state.tabs.filter((id) => id !== pageId), active: state.active === pageId ? null : state.active };
}
