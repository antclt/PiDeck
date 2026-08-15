/**
 * DSH 动态 Cordis 插件管理（G13 深化）的跨进程契约类型。
 * 与 src/main/dsh/pideckPluginBridge.ts 的视图/入参形状一一对应。
 */

/** 动态插件清单行（inventory 的安全 JSON 视图）。 */
export type DshPluginView = {
	pluginId: string;
	/** 归属会话（DSH host 的 sessionId，与 catalog 的 dshSessionId 对照）。 */
	agentId: string;
	packages: Array<{
		packageId: string;
		name: string;
		purpose: string;
		hasHostHalf: boolean;
		hasClientHalf: boolean;
	}>;
	currentPackageId?: string;
	nextPackageId?: string;
	activeRun?: { pluginRunId: string; packageId: string };
	status?: string;
	mode?: string;
	error?: string;
};

/** 静态 Loader 条目视图（pluginInventory 的安全 JSON 视图，只读）。 */
export type DshStaticPluginView = {
	entryId: string;
	moduleName: string;
	enabled: boolean;
	fiberPhase: string | null;
};

/** 安装（define）入参。 */
export type DshPluginInstallInput = {
	sessionId: string;
	/** 3-6 个小写英文字母语义前缀；host 分配最终 pluginId。 */
	idPrefix: string;
	name: string;
	purpose: string;
	hostCode?: string;
	clientCode?: string;
};

/** 生命周期操作入参（run/stop/uninstall）。 */
export type DshPluginLifecycleInput = {
	sessionId: string;
	pluginId: string;
	packageId?: string;
	mode?: "run" | "update";
};

/** 桥 RPC 响应（主进程 rawFetch 解析用；{ ok:false } 时主进程抛 error 文本）。 */
export type DshPluginBridgeResponse<T> = { ok: true; value: T } | { ok: false; error: string };
