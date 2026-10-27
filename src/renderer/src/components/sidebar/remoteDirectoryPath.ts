/**
 * 远端目录浏览的纯路径规则（渲染层）。
 *
 * 只做字符串层面的父级/拼接/叶子名校验；真正的绝对路径与越界检查仍在主进程
 * （`assertListablePath` + canonical 复核）。这里不把渲染层判断当授权。
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function remoteParentPath(path: string): string {
	if (path === "" || path === "/") return "/";
	const index = path.lastIndexOf("/");
	return index <= 0 ? "/" : path.slice(0, index);
}

export function joinRemotePath(parent: string, name: string): string {
	if (parent === "" || parent === "/") return `/${name}`;
	return `${parent}/${name}`;
}

/** 面包屑：`/srv/app` → [{path:"/",label:"/"},{path:"/srv",label:"srv"},{path:"/srv/app",label:"app"}] */
export function remotePathSegments(path: string): { path: string; label: string }[] {
	if (path === "" || path === "/") return [{ path: "/", label: "/" }];
	const parts = path.slice(1).split("/");
	const segments = [{ path: "/", label: "/" }];
	let current = "";
	for (const part of parts) {
		if (part.length === 0) continue;
		current += `/${part}`;
		segments.push({ path: current, label: part });
	}
	return segments;
}

/** 新目录的叶名：单段、非 . / ..、无斜杠与控制字节、长度有界。 */
export function isValidNewLeaf(value: string): boolean {
	if (value.length === 0 || value.length > 255) return false;
	if (value === "." || value === "..") return false;
	if (value.includes("/") || value.includes("\\") || CONTROL_CHARS.test(value)) return false;
	return true;
}

/** 隐藏目录默认不显示：点目录（`.`/`..`）不是可导航项，服务端已经排除。 */
export function isVisibleRemoteDirectory(name: string, showHidden: boolean): boolean {
	return showHidden || !name.startsWith(".");
}
