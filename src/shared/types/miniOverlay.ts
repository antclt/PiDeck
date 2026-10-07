/**
 * 极简浮窗（MiniOverlayWindow）与渲染层共享的状态快照类型。
 * 主进程 buildState 产出，preload 透传，浮窗渲染层消费。
 */

/** 浮窗内展示的会话条目：会话身份 + 展示标题 + 所属项目（跨项目直达依赖 projectId）。 */
export interface MiniOverlaySessionRef {
	id: string;
	title: string;
	projectId: string;
	/** 正在运行 agent：活动会话区排序靠前并带脉冲绿点。 */
	isRunning: boolean;
}

/** 极简浮窗状态快照：渲染层据此渲染状态区、快捷输入与最近会话列表。 */
export interface MiniOverlayState {
	visible: boolean;
	runningCount: number;
	activeCount: number;
	/** 正在运行 agent 的会话：主页顶部直达入口，与悬浮球角标同语义。 */
	activeSessions: MiniOverlaySessionRef[];
	recentSessions: MiniOverlaySessionRef[];
	projects: Array<{ id: string; name: string; path: string }>;
	locale: "zh-CN" | "en-US";
}
