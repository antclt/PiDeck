import type { PiConfigTarget } from "../../../shared/piConfig";
import type { RemoteHostListItem } from "../../../shared/types/remoteHost";
import type { WslHostListItem } from "../../../shared/types/wslHost";

/**
 * 配置目标（P1-1 UI 侧）的纯规则：选择器可选项、目标比较、本地编辑器是否带 target、
 * provider 探针门禁。放在纯模块里而不是 JSX lambda 里，便于单测「切目标/带不带 target」这些
 * 会直接影响写盘作用域的判断。
 */

/** 目标选择器的一项：已校验且未禁用的 ssh 主机，或一条 WSL 连接档案。 */
export type PiConfigTargetHost = { kind: "ssh"; id: string; label: string; sshHost: string } | { kind: "wsl"; id: string; label: string; distro: string; user: string };

/** WSL 档案项（来源提示、未接入页说明都只认这一种）。 */
export type WslConfigTargetHost = Extract<PiConfigTargetHost, { kind: "wsl" }>;

/** 已验证的 ssh 主机 → 选择器项（过滤条件由调用方先做，这里只做形状转换）。 */
export function toSshTargetHosts(hosts: readonly RemoteHostListItem[]): PiConfigTargetHost[] {
	return hosts.map((host) => ({ kind: "ssh", id: host.id, label: host.label, sshHost: host.sshHost }));
}

/** WSL 档案 → 选择器项：label/distro/user 是档案里唯一的展示信息（没有路径、没有凭据）。 */
export function toWslTargetHosts(hosts: readonly WslHostListItem[]): PiConfigTargetHost[] {
	return hosts.map((host) => ({ kind: "wsl", id: host.id, label: host.label, distro: host.distro, user: host.user }));
}

/** 是否存在 WSL 档案：决定「技能/提示词/扩展页仅编辑 Windows 配置」的标注要不要出现。 */
export function hasWslConfigProfile(hosts: readonly PiConfigTargetHost[]): boolean {
	return hosts.some((host) => host.kind === "wsl");
}

/**
 * 同一目标判定：同 kind 同 hostId 才算同一个。同一个 id 在 ssh/wsl 两个命名空间里是不同目标，
 * 切换时必须重载——否则界面会把上一份目标的草稿当成新目标的数据展示。
 */
export function samePiConfigTarget(left: PiConfigTarget, right: PiConfigTarget): boolean {
	if (left.kind === "local" || right.kind === "local") return left.kind === right.kind;
	return left.kind === right.kind && left.hostId === right.hostId;
}

/**
 * 本地编辑器（models/settings 表单）读写要带的 target 选项：
 * - local：缺省，不带（旧调用语义）；
 * - ssh：由远端面板接管，本地编辑器不参与；
 * - wsl：带 target，读写落到该档案的发行版 HOME。
 */
export function localEditorTargetOption(target: PiConfigTarget): { target: PiConfigTarget } | undefined {
	return target.kind === "wsl" ? { target } : undefined;
}

/** 按当前目标找 WSL 档案项；本机目标、找不到、或只有同 id 的 ssh 条目都返回 undefined。 */
export function wslTargetHostOf(hosts: readonly PiConfigTargetHost[], target: PiConfigTarget): WslConfigTargetHost | undefined {
	if (target.kind !== "wsl") return undefined;
	return hosts.find((host): host is WslConfigTargetHost => host.kind === "wsl" && host.id === target.hostId);
}

/**
 * provider 探针（连接测试 / 拉取模型 / 用量查询）只对本机开放：
 * 远端与 WSL 目标在主进程会被拒（PROVIDER_OPERATION_UNSUPPORTED），界面必须提前禁用/拒绝，
 * 不能点了才报错，也不能把请求发到错误的网络出口。
 */
export function providerOpsAllowed(target: PiConfigTarget): boolean {
	return target.kind === "local";
}
