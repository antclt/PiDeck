import { Folder, FolderOpen, Globe2 } from "lucide-react";

/**
 * 远端项目的文件夹图标：保留本机的开/合形态，右下角叠一个蓝色地球角标。
 *
 * 只做识别，不承担连接状态（状态点单独在行尾）。角标用 `ring-sidebar` 垫出与行底的细缝，
 * 贴在任何行背景上都不会糊成一团；`aria-hidden` 让读屏只读行内文字与状态标签。
 */
export function RemoteProjectFolderIcon(props: { collapsed: boolean }) {
	const Icon = props.collapsed ? Folder : FolderOpen;
	return (
		<span className="relative grid size-5 shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
			<Icon size={14} />
			<span className="absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-sidebar ring-1 ring-sidebar">
				<Globe2 className="size-2.5 text-info" strokeWidth={2.25} />
			</span>
		</span>
	);
}
