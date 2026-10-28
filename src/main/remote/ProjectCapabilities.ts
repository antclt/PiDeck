/**
 * 项目能力快照（v5 §2 硬规定 3 / W3 门禁）：**「这台主机现在能做什么」只有一个定义**。
 *
 * 现在渲染层有四个地方各自判定：设置页与进度条把 `ready || degraded` 当已连接，远端 Git 面板只认
 * `ready`，于是同一台主机在同一个时刻能给出两个答案。这里把判定收成一处纯函数：
 *
 * - `local`：本机项目，读写、Git、忽略规则全部可用（不看任何远端状态）；
 * - `ssh` + `ready`：全部可用；
 * - `ssh` + `degraded`：**读可用、写不可用**。降级意味着会话还在但状态不健康——读错了只是显示旧值，
 *   写错了是数据损坏，所以写面在降级时关闭并给出稳定原因码；
 * - 其它状态（`connecting` / `booting` / `reconnecting` / `offline` / `needs-attention` / `disconnected`）：
 *   全部关闭。
 *
 * `watch` 单独一条：只有 helper 明确声明了 `fs.watch` 能力才为 true（S8 推送的前提），否则调用方走轮询。
 * 这个函数不读时钟、不读全局、不碰 IPC，所以同一组输入永远给同一个答案，可以在任何层复用。
 */
import type { RemoteHostConnectionState } from "./RemoteHostConnectionTypes";

/** 能力被关闭的稳定原因码（给 UI 分类用，不是文案）。 */
export const PROJECT_CAPABILITY_REASONS = {
	hostNotReady: "PROJECT_CAPABILITY_HOST_NOT_READY",
	hostDegraded: "PROJECT_CAPABILITY_WRITE_NEEDS_READY_HOST",
	helperNoWatch: "PROJECT_CAPABILITY_WATCH_UNSUPPORTED",
} as const;

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
	hostState: RemoteHostConnectionState | "local";
	/** helper 声明支持的方法（缺省 = 未知，按不支持处理）。 */
	helperCapabilities?: readonly string[];
};

export function resolveProjectCapabilities(input: ProjectCapabilityInput): ProjectCapabilities {
	const watch = (input.helperCapabilities ?? []).includes("fs.watch");
	const noWatch = watch ? {} : { reason: PROJECT_CAPABILITY_REASONS.helperNoWatch };
	if (input.locationKind === "local") {
		return { locationKind: "local", readFiles: true, writeFiles: true, gitRead: true, gitWrite: true, ignore: "git", watch: false };
	}
	if (input.hostState === "ready") {
		return { locationKind: "ssh", readFiles: true, writeFiles: true, gitRead: true, gitWrite: true, ignore: "git", watch, ...noWatch };
	}
	if (input.hostState === "degraded") {
		// 降级：读错只是旧值，写错是数据损坏——所以只关写面，并把原因说清楚。
		return { locationKind: "ssh", readFiles: true, writeFiles: false, gitRead: true, gitWrite: false, ignore: "git", watch, reason: PROJECT_CAPABILITY_REASONS.hostDegraded };
	}
	return { locationKind: "ssh", readFiles: false, writeFiles: false, gitRead: false, gitWrite: false, ignore: "builtin", watch, reason: PROJECT_CAPABILITY_REASONS.hostNotReady };
}
