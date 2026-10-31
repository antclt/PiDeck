import type { RemoteHostConnectionState } from "../../../shared/types/remoteHost";

/**
 * 侧栏远端项目行要显示的「这台主机是谁 + 现在通不通」。
 *
 * 纯收窄/映射层：IPC 回来的载荷一律在边界重新校验，渲染层不把任意字符串当标签、也不把未知状态
 * 当成「已连接」。两类事实分开存：目录（label/sshHost/verified/disabled）来自一次只读列表，
 * 连接状态只来自 main 的推送——两者合成后仍是同一份索引，避免两个 atom 各自漂移。
 */
export type RemoteHostIdentity = {
	label: string;
	sshHost: string;
	verified: boolean;
	disabled: boolean;
};

export type RemoteHostIdentityIndex = Record<string, RemoteHostIdentity & { state?: RemoteHostConnectionState }>;

/** 状态点的语义色：绿=可用、黄=正在连、灰=未连接、红=需要处理。 */
export type RemoteHostConnectionTone = "online" | "connecting" | "offline" | "error";

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/;
const MAX_LABEL = 128;
const MAX_HOST = 1024;

export const REMOTE_HOST_CONNECTION_STATES: readonly RemoteHostConnectionState[] = ["disconnected", "connecting", "probing", "bootstrapping", "ready", "degraded", "reconnecting", "offline", "needs-attention"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const label = value.trim();
	if (label.length === 0 || label.length > MAX_LABEL || CONTROL_BYTES.test(label)) return undefined;
	return label;
}

function readHostName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const host = value.trim();
	if (host.length === 0 || host.length > MAX_HOST || CONTROL_BYTES.test(host)) return undefined;
	return host;
}

/**
 * `remoteHosts.list()` → hostId 索引。
 *
 * 功能未启用/目录不可读时返回 `undefined`：调用方保留已有索引，不把「读不到」伪装成「没有主机」——
 * 后者会让侧栏把每台主机都显示成「未知主机」。
 */
export function readRemoteHostDirectory(raw: unknown): Record<string, RemoteHostIdentity> | undefined {
	if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.hosts)) return undefined;
	const directory: Record<string, RemoteHostIdentity> = {};
	for (const entry of raw.hosts) {
		if (!isRecord(entry)) continue;
		if (typeof entry.id !== "string" || !HOST_ID.test(entry.id)) continue;
		const label = readLabel(entry.label);
		const sshHost = readHostName(entry.sshHost);
		// verified/disabled 缺失时按「未验证 + 未禁用」处理：连接状态点不据此推断，仅用于 title 文案。
		if (label === undefined || sshHost === undefined) continue;
		directory[entry.id] = { label, sshHost, verified: entry.verified === true, disabled: entry.disabled === true };
	}
	return directory;
}

/** `remote:state-changed` 推送 → 一条可落地的状态变化；UUID/枚举不合法的载荷整体丢弃。 */
/**
 * `remoteHosts.list()` 顺带带回的状态快照。
 *
 * 推送只覆盖「视图挂载期间发生的变化」：离开设置页再回来、或应用刚启动时，没有任何事件可重放，
 * 界面只能把已连接的主机显示成未连接。列表把当前状态一起带回来，用来补这一次。
 */
export function readRemoteHostStates(raw: unknown): Record<string, RemoteHostConnectionState> {
	if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.states)) return {};
	const states: Record<string, RemoteHostConnectionState> = {};
	for (const [hostId, value] of Object.entries(raw.states)) {
		if (!HOST_ID.test(hostId) || typeof value !== "string") continue;
		const state = REMOTE_HOST_CONNECTION_STATES.find((candidate) => candidate === value);
		if (state !== undefined) states[hostId] = state;
	}
	return states;
}

export function readRemoteHostStateChange(raw: unknown): { hostId: string; state: RemoteHostConnectionState } | undefined {
	if (!isRecord(raw)) return undefined;
	if (typeof raw.hostId !== "string" || !HOST_ID.test(raw.hostId)) return undefined;
	if (typeof raw.state !== "string") return undefined;
	const state = REMOTE_HOST_CONNECTION_STATES.find((candidate) => candidate === raw.state);
	return state === undefined ? undefined : { hostId: raw.hostId, state };
}

/**
 * 连接状态 → 状态点语义。
 *
 * 没有状态（尚未连过/窗口重载后还没收到推送）按「未连接」显示，而不是猜测可用；`degraded` 仍能
 * 工作（manager 会自愈），因此归到 online，不用红色吓人。
 */
export function resolveRemoteHostConnectionTone(state: RemoteHostConnectionState | undefined): RemoteHostConnectionTone {
	switch (state) {
		case "ready":
		case "degraded":
			return "online";
		case "connecting":
		case "probing":
		case "bootstrapping":
		case "reconnecting":
			return "connecting";
		case "needs-attention":
			return "error";
		default:
			return "offline";
	}
}

/**
 * 状态点配色（单一来源）。侧栏项目行与设置页主机列表共用，避免两处对「失败」用不同颜色。
 * 连接中不用圆点：黄色圆点在会话行已表示「Agent 在跑」，这里改用转圈（见两处消费端）。
 */
export const REMOTE_HOST_TONE_DOT_CLASS: Record<Exclude<RemoteHostConnectionTone, "connecting">, string> = {
	online: "bg-success",
	offline: "bg-muted-foreground/45",
	error: "bg-destructive",
};

/** 目录与状态合并：目录缺这台主机时也保留状态，避免先到的推送被后到的列表覆盖掉。 */
export function mergeRemoteHostIdentity(index: RemoteHostIdentityIndex, directory: Record<string, RemoteHostIdentity>): RemoteHostIdentityIndex {
	const next: RemoteHostIdentityIndex = {};
	for (const [hostId, identity] of Object.entries(index)) {
		const known = directory[hostId];
		next[hostId] = known === undefined ? identity : { ...known, ...(identity.state === undefined ? {} : { state: identity.state }) };
	}
	for (const [hostId, identity] of Object.entries(directory)) {
		if (next[hostId] === undefined) next[hostId] = identity;
	}
	return next;
}

/**
 * 把一条推送合并进索引。
 *
 * 目录还没到（list 未返回或功能未启用）时先只记状态，label 留空由渲染层显示「未知主机」；
 * 之后目录到达时 `mergeRemoteHostIdentity` 会保留这条状态。
 */
export function applyRemoteHostStateChange(index: RemoteHostIdentityIndex, change: { hostId: string; state: RemoteHostConnectionState }): RemoteHostIdentityIndex {
	const current = index[change.hostId];
	const next: RemoteHostIdentity = current ?? { label: "", sshHost: "", verified: false, disabled: false };
	return { ...index, [change.hostId]: { ...next, state: change.state } };
}
