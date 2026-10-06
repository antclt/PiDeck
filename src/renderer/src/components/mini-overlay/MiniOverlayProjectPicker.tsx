import { useEffect, useState } from "react";
import { desktopApi } from "../../desktopApi";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";

/** 浮窗模式的项目切换：没有侧边栏，用 Select 替代。
 * 选项目后跳到该项目的最近会话（没有则新建草稿）。
 */
export function MiniOverlayProjectPicker({ onSelectProject }: { onSelectProject: (projectId: string) => void }) {
	const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);

	useEffect(() => {
		void desktopApi.projects
			.list()
			.then(setProjects)
			.catch(() => setProjects([]));
	}, []);

	if (projects.length === 0) return null;

	return (
		<Select value="" onValueChange={onSelectProject}>
			<SelectTrigger className="mini-overlay-project-picker">
				<SelectValue placeholder="项目" />
			</SelectTrigger>
			<SelectContent>
				{projects.map((p) => (
					<SelectItem key={p.id} value={p.id}>
						{p.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
