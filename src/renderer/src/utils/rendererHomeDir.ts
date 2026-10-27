/**
 * 渲染层家目录（app.getPath("home") → AppInfo.homeDir），由应用引导阶段写入一次。
 *
 * 为什么需要它（issue #426）：文件链接解析 `~/桌面/x.html` 必须知道家目录才能在
 * 「是否在项目内」判断之前把它变成绝对路径，否则 `~` 会被当成字面目录名，
 * 有 projectRoot 的会话入口一律判成「项目外」，右键菜单的绝对/相对路径与系统动作也拿不到真路径。
 *
 * 为什么不放进 atoms：`resolveFileLinkPath` 这类解析函数是渲染期同步调用的纯函数，
 * 传 atom 会把每个调用点都变成 hook；家目录是「进程生命周期内基本不变、启动后才有」的
 * 环境事实，用模块级缓存 + 启动时写入最贴合（与 MarkdownLink 里的平台常量同一类做法）。
 * 解析函数本身仍显式接收 homeDir 参数（纯函数），只是取值点统一收在这里。
 */

let rendererHomeDir: string | undefined;

/** 写入家目录（appInfo 到达/变化时调用；空串表示未知，退回旧行为：`~` 不展开）。 */
export function setRendererHomeDir(homeDir: string | undefined): void {
	const trimmed = typeof homeDir === "string" ? homeDir.trim() : "";
	rendererHomeDir = trimmed === "" ? undefined : trimmed;
}

/** 当前已知的渲染层家目录；未就绪（启动首帧 / 浏览器预览态）时为 undefined。 */
export function getRendererHomeDir(): string | undefined {
	return rendererHomeDir;
}
