import type { PiResourceOptions, PiResourceTarget } from "../../../shared/piConfig";
import type { PiConfigTargetHost, WslConfigTargetHost } from "./piConfigTargetModel";

/**
 * 资源作用域（W1）的纯规则：可选档案、IPC options、本轮哪些动作只支持本机。
 *
 * 与配置目标（PiConfigTarget）刻意分开：资源域只有 local/wsl 两个值，ssh 不能出现在资源选择器里
 * （主进程对 ssh 目标回 PI_RESOURCE_SSH_UNSUPPORTED）。放在纯模块里便于单测「带不带 target」这类
 * 直接决定读写作用域的判断。
 */

/** 资源选择器项：只保留 WSL 档案（label/distro/user 即档案唯一展示信息）。 */
export function toResourceTargetHosts(hosts: readonly PiConfigTargetHost[]): WslConfigTargetHost[] {
	return hosts.filter((host): host is WslConfigTargetHost => host.kind === "wsl");
}

/** local 是兼容缺省：不带 options，存量调用逐字不变；wsl 才带 target。 */
export function resourceTargetOptions(target: PiResourceTarget): PiResourceOptions | undefined {
	return target.kind === "wsl" ? { target } : undefined;
}

/**
 * 本轮路由范围：技能/扩展只有 list，提示词有 list/read/save。其余写操作仍属于本机单例，
 * WSL 目标必须显式拦住并提示——静默写 Windows HOME 比不显示更危险。
 */
export function resourceMutationAllowed(target: PiResourceTarget): boolean {
	return target.kind === "local";
}
