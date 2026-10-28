/**
 * 项目能力快照（v5 §2 硬规定 3 / W3 门禁）：**「这台主机现在能做什么」只有一个定义**。
 *
 * 现在渲染层有四个地方各自判定：设置页与进度条把 `ready || degraded` 当已连接，远端 Git 面板只认
 * `ready`，于是同一台主机在同一个时刻能给出两个答案（审计发现 R3）。这里把判定收成一组纯函数：
 *
 * - `isLiveHostState`：会话还活着（读到的东西可能是旧的，但连接是通的）——设置页徽标、进度条用它；
 * - `isWritableHostState`：写面可用。降级意味着会话在但状态不健康：读错只是显示旧值，写错是数据损坏，
 *   所以写面只在 `ready` 打开——远端 Git 面板的写动词用它；
 * - `resolveProjectCapabilities`：把两类位置合成为一张能力表（含 .gitignore 权威来源与 watch 支持）。
 *
 * 放在 `shared/` 而不是 main：两层的判定必须同源，否则又会分叉。本模块不读时钟、不读全局、不碰 IPC。
 */

/** 与 `RemoteHostConnectionTypes` 的连接状态逐字相同；在契约层重新声明是为了让渲染层可依赖。 */
export type HostConnectionStateLike = "disconnected" | "connecting" | "probing" | "bootstrapping" | "ready" | "degraded" | "reconnecting" | "offline" | "needs-attention";

/** 能力被关闭的稳定原因码（给 UI 分类用，不是文案）。 */
export const PROJECT_CAPABILITY_REASONS = {
	hostNotReady: "PROJECT_CAPABILITY_HOST_NOT_READY",
	hostDegraded: "PROJECT_CAPABILITY_WRITE_NEEDS_READY_HOST",
	helperNoWatch: "PROJECT_CAPABILITY_WATCH_UNSUPPORTED",
} as const;

/** 会话还活着（读面可用）。这是「已连接」的唯一判据。 */
export function isLiveHostState(state: HostConnectionStateLike): boolean {
	return state === "ready" || state === "degraded";
}

/** 写面可用。降级主机一律关闭写：读错只是旧值，写错是数据损坏。 */
export function isWritableHostState(state: HostConnectionStateLike): boolean {
	return state === "ready";
}

export type ProjectCapabilities = {
	locationKind: "local" | "ssh";
	readFiles: boolean;
	/** 写面（create/rename/delete/save/upload）——降级主机一律关闭。 */
	writeFiles: boolean;
	gitRead: boolean;
	gitWrite: boolean;
	/** `.gitignore` 判定：git 权威（`check-ignore`）或内置规则。 */
	ignore: "git" | "builtin";
	/** helper 事件推送是否可用（不可用时上层显式降级到轮询）。 */
	watch: boolean;
	/** 第一个被关闭的原因码（全开时缺省）。 */
	reason?: string;
};

export type ProjectCapabilityInput = {
	locationKind: "local" | "ssh";
	/** 本机项目传 `"local"`（不看远端状态机）。 */
	hostState: HostConnectionStateLike | "local";
	/** helper 声明支持的方法（缺省 = 未知，按不支持处理）。 */
	helperCapabilities?: readonly string[];
};

export function resolveProjectCapabilities(input: ProjectCapabilityInput): ProjectCapabilities {
	const watch = (input.helperCapabilities ?? []).includes("fs.watch");
	const noWatch = watch ? {} : { reason: PROJECT_CAPABILITY_REASONS.helperNoWatch };
	if (input.locationKind === "local") {
		return { locationKind: "local", readFiles: true, writeFiles: true, gitRead: true, gitWrite: true, ignore: "git", watch: false };
	}
	if (isWritableHostState(input.hostState as HostConnectionStateLike)) {
		return { locationKind: "ssh", readFiles: true, writeFiles: true, gitRead: true, gitWrite: true, ignore: "git", watch, ...noWatch };
	}
	if (isLiveHostState(input.hostState as HostConnectionStateLike)) {
		// 降级：读留下、写关掉，并把原因说清楚。
		return { locationKind: "ssh", readFiles: true, writeFiles: false, gitRead: true, gitWrite: false, ignore: "git", watch, reason: PROJECT_CAPABILITY_REASONS.hostDegraded };
	}
	return { locationKind: "ssh", readFiles: false, writeFiles: false, gitRead: false, gitWrite: false, ignore: "builtin", watch, reason: PROJECT_CAPABILITY_REASONS.hostNotReady };
}
