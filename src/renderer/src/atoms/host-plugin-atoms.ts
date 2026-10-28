import { atom } from "jotai";
import type { HostPluginCatalog, HostPluginPanelPresentation } from "../../../shared/types/hostPlugin";
import { desktopApi } from "../desktopApi";
import { deactivateWorkspacePageAtom } from "./workspace-page-atoms";

export type HostPluginCatalogState = { catalog?: HostPluginCatalog; error?: string };
/** One catalog subscription for the settings page, command palette and panel host. */
export const hostPluginCatalogAtom = atom<HostPluginCatalogState>({});
hostPluginCatalogAtom.onMount = (set) => {
	let disposed = false;
	let revision = 0;
	const refresh = async () => {
		const current = ++revision;
		try {
			const result = await desktopApi.hostPlugins.list();
			if (!disposed && current === revision) set(result.ok ? { catalog: result.value } : { error: result.code });
		} catch {
			if (!disposed && current === revision) set({ error: "plugin-host-unavailable" });
		}
	};
	let unsubscribe: (() => void) | undefined;
	try {
		unsubscribe = desktopApi.hostPlugins.onChanged(() => void refresh());
	} catch {
		/* Missing desktop preload has no plugin host. */
	}
	void refresh();
	return () => {
		disposed = true;
		revision += 1;
		unsubscribe?.();
	};
};

/** Phase one has one independent surface per desktop window, not one per pi process. */
export const hostPluginPanelAtom = atom<{ pluginId: string; panelId: string } | null>(null);

/**
 * 面板形态查询：catalog 还没加载或面板已不存在时按 modal 处理（那种情况下两端都不会渲染）。
 */
export function isHostPluginPagePanel(selected: { pluginId: string; panelId: string }, catalog?: HostPluginCatalog): boolean {
	const plugin = catalog?.plugins.find((item) => item.enabled && item.manifest.id === selected.pluginId);
	const panel = plugin?.manifest.contributes.panels.find((item) => item.id === selected.panelId);
	const presentation: HostPluginPanelPresentation = panel?.presentation ?? "modal";
	return presentation === "page";
}

/**
 * 打开/收起面板的统一入口（侧栏入口、设置页「预览面板」、命令面板共用）。
 *
 * 会话列同一时刻只呈现一层**页面**：页面式插件面板与「定时任务 / 智能体 / 收藏」页面都占
 * `absolute inset-0`，同时存在会互相遮挡。所以打开页面式面板时在这里让工作区页面失活
 * （页面 Tab 保留、切回来状态还在）。反过来由 App 的互斥 effect 负责：激活页面时收起页面式面板。
 *
 * 不在打开时让页面失活的话，App 那个 effect 会在同一次提交里把刚打开的面板关掉，
 * 表现为「停在定时任务/智能体页面时点会话分组没有任何反应」。
 * 对话框/浮层只是浮在页面之上，不需要让页面失活。
 */
export const openHostPluginPanelAtom = atom(null, (get, set, target: { pluginId: string; panelId: string } | null) => {
	set(hostPluginPanelAtom, target);
	if (target && isHostPluginPagePanel(target, get(hostPluginCatalogAtom).catalog)) set(deactivateWorkspacePageAtom);
});
