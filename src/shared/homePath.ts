/**
 * `~` 家目录展开的共享口径（主进程文件 IPC / 渲染层文件链接共用，零依赖）。
 *
 * 背景（issue #426）：`~` 此前在全链路都被当成**字面目录名**——
 * - 渲染层把 `~/桌面/x.html` 当绝对路径参与项目边界判断，一律判成「项目外」（或直接解析失败）；
 * - 主进程拿着 `~/桌面/x.html` 直接 `fs.stat`，必然 ENOENT。
 * 于是用户看到「文件明明在，点了却提示不存在」。
 *
 * 家目录的**值**由调用方注入（主进程：本机 home / WSL 发行版内 home；渲染层：appInfo.homeDir），
 * 这样本模块保持零依赖，能被 node:test 用 type stripping 直接加载。
 */

/**
 * 是否 `~` 家目录缩写形态：`~`、`~/...`、`~\...`。
 * 刻意不认 `~user`——那是 shell 的用户名展开，语义与优先级都不同（常出现在邮箱/正则里）。
 */
export function isHomeRelativePath(path: string): boolean {
	return path === "~" || path.startsWith("~/") || path.startsWith("~\\");
}

/**
 * 把 `~` / `~/...` / `~\...` 展开成家目录下的绝对路径。
 *
 * - 非 `~` 形态、家目录未知（空串/undefined）时原样返回：调用方无须先判断形态，
 *   渲染层在 appInfo 到达前也能安全地走旧路径；
 * - 分隔符跟随家目录自身的语法（`C:\Users\x` 用 `\`，POSIX 用 `/`），
 *   并把剩余部分里的混写分隔符（`~\Documents/a.md`）统一成同一风格，
 *   否则后续词法规范化（filePathLinks.normalizeLexicalFilePath）会把混写路径当成另一种语法。
 */
export function expandHomePath(path: string, homeDir: string | undefined): string {
	if (!path || !homeDir || !isHomeRelativePath(path)) return path;
	// 家目录去掉尾分隔符后再拼：`/home/x/` + `~/a` 不能拼出 `/home/x//a`。
	const base = homeDir.replace(/[\\/]+$/, "") || homeDir;
	if (path === "~") return base;
	const windowsStyleHome = /^[A-Za-z]:[\\/]/.test(homeDir) || /^[\\/]{2}[^\\/]/.test(homeDir);
	const separator = windowsStyleHome ? "\\" : "/";
	const segments = path
		.slice(2)
		.split(/[\\/]+/)
		.filter((segment) => segment.length > 0);
	if (segments.length === 0) return base;
	return `${base}${separator}${segments.join(separator)}`;
}
