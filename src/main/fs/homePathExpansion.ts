import { homedir } from "node:os";
import { expandHomePath, isHomeRelativePath } from "../../shared/homePath.ts";

/**
 * 主进程侧 `~` 展开（issue #426）：文件 IPC 在落到 `fs.*` / `shell.*` / `fileSystemService.*` 之前统一展开家目录。
 *
 * 家目录在两条链路上不同，必须分开取：
 * - WSL 会话（Windows + wslEnabled + wslDistro）：`~` 指**发行版内**的 home，展开成 `/home/<wslUser>`
 *   后仍然交给后面的 `toWindowsPath()` 转成 `\\wsl.localhost\<distro>\home\<user>\…`。
 *   顺序反过来（先转 UNC 再展开）或展开成 Windows home，会让 WSL 项目里的 `~/x`
 *   指向另一个文件系统里的同名路径。
 * - 其余情况：本机 `homedir()`。
 *
 * WSL 会话但 `wslUser` 未配置时**不猜**：`/root` 与 `/home/<user>` 都有可能是对的，
 * 猜错只会把用户引到另一个用户的同名文件上。此时保持原样（= 修复前的行为，仍会 ENOENT，
 * 但不会打开错文件）；WSL 会话本身要求配置用户名，正常安装路径上不会走到这里。
 *
 * 单独成模块的原因：filesIpc / filesSystemIpc 两个注册点共用同一口径，
 * 且 settings 由调用方注入，便于单测不带 Electron 运行时。
 */
export type HomeExpansionSettings = {
	wslEnabled?: boolean;
	wslDistro?: string;
	wslUser?: string;
};

/** WSL 发行版内的 home：与 WslEnvironment 的 fallbackHome 同口径（linuxHome 探测失败时的兜底）。 */
function wslLinuxHome(user: string): string {
	return user === "root" ? "/root" : `/home/${user}`;
}

/**
 * 展开 `~`；非 `~` 形态、或拿不到可信家目录时原样返回（调用方无须先判形态）。
 * 注意本函数只做**词法**展开，不做 realpath/边界校验——授权仍由各 IPC 的项目边界负责。
 */
export function expandHomeForFileAccess(path: string, settings: HomeExpansionSettings | undefined, platform: NodeJS.Platform = process.platform): string {
	if (!path || !isHomeRelativePath(path)) return path;
	if (platform === "win32" && settings?.wslEnabled && settings.wslDistro) {
		const user = settings.wslUser?.trim();
		return user ? expandHomePath(path, wslLinuxHome(user)) : path;
	}
	return expandHomePath(path, homedir());
}
