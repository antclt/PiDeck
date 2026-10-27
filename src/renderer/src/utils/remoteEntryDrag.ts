/**
 * 远端文件面板的拖放决策（纯函数，供面板与 hook 共用与单测）。
 *
 * 面板上有两条完全不同的拖放路径，混在一起就会出现「拖一个条目松手，却去读一个不存在的本机路径」
 * 这种事故，所以路由判定必须是可测的纯函数，而不是散在 JSX lambda 里：
 * - **内部移动**：拖的是列表里的条目（dragstart 写了自己的标记），落点是目录行或根面包屑；
 * - **外部上传**：从资源管理器拖文件进来（`dataTransfer.files` 非空）；
 * - 其余（纯文本拖入、跨窗口的不认识的内容）一律忽略，不做任何动作。
 */

/** 内部拖动的 dataTransfer 标记；与「从系统拖文件上传」区分开。 */
export const REMOTE_ENTRY_DRAG_TYPE = "application/x-pideck-remote-entry";

export type RemoteDropRoute = "move" | "upload" | "ignore";

export function remoteDropRoute(input: { hasFiles: boolean; hasEntryMarker: boolean }): RemoteDropRoute {
	// 内部标记优先：它从不带 files，但显式判断能防住将来有人把两者都塞进去。
	if (input.hasEntryMarker) return "move";
	if (input.hasFiles) return "upload";
	return "ignore";
}

/** 拖到空白区域（既不是目录行也不是面包屑）时的结论：内部拖动不是移动，也不上传。 */
export function remoteDropOnBlankArea(route: RemoteDropRoute): boolean {
	return route === "move";
}

/**
 * 移动落点：目标目录 + 条目名。返回 null 表示「没有意义、不发起请求」
 * （拖到自己所在目录、条目名为空）。拖进自己的子目录由服务端拒绝，这里不重复判断。
 */
export function moveDestination(draggedPath: string, targetDirectory: string): string | null {
	const name = draggedPath.split("/").at(-1) ?? "";
	if (name === "") return null;
	const destination = targetDirectory === "" ? name : `${targetDirectory}/${name}`;
	return destination === draggedPath ? null : destination;
}
