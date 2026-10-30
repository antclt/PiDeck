import { useSetAtom } from "jotai";
import { FolderGit2 } from "lucide-react";
import type { Project } from "../../../../shared/types";
import { isRemoteProject } from "../../../../shared/projectLocation";
import { t } from "../../i18n";
import { GUIDE_BOOTSTRAP_SESSION_ID } from "../../utils/chatSessionBootstrap";
import { isChatProject } from "../../rendererUtils";
import { remoteEnrollDialogOpenAtom } from "../../atoms/remote-project-atoms";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { RemoteProjectPanel } from "./RemoteProjectPanel";
import { SessionStartSurface } from "./SessionStartSurface";

/**
 * 无会话空态（启动 / 清空全部 Tab / 空项目）。
 *
 * 有项目：直接挂「新建页面」同源的 SessionStartSurface（居中 ComposerArea +
 * 快捷动作），绑定 renderer-only 虚拟会话 ID——不创建 Catalog 记录、不拉起 pi、
 * 不占用 Tab 栏；首次发送（或选择 ACP）由 App.ensureSessionForSend 创建真实会话
 * （Chat 匿名 / 非 Chat draft）并把 composer 状态整体提升过去，随后才登记 Tab。
 *
 * 无项目：同样交给 SessionStartSurface 的 no-project 模式渲染——两屏共用同一
 * 骨架（Logo / 1080px 列宽 / 18vh 重心 / 间距），无项目时正文换成与输入框同宽的
 * 引导卡，而不是另一套居中按钮。维护点只剩一个组件。
 */
export function ProjectEmptyState(props: {
	activeProject?: Project;
	/** 可切换的目标项目列表：下拉只切换 activeProjectId（selectProject 语义），
      不创建会话；首次发送 / 选择 ACP 按当前选中项目创建（App.ensureSessionForSend） */
	projects: Project[];
	onAddProject: () => void;
	onSelectProject: (projectId: string) => void;
	onOpenTerminal?: () => void;
}) {
	// 远端登记弹框由 App 统一挂载，这里只打开开关（与侧栏「+」同一条路径）。
	const setRemoteEnrollOpen = useSetAtom(remoteEnrollDialogOpenAtom);
	// 无项目时没有任何可创建会话的项目上下文，只保留添加项目入口。
	if (!props.activeProject) {
		return <SessionStartSurface mode="no-project" onAddProject={props.onAddProject} onOpenRemote={() => setRemoteEnrollOpen(true)} />;
	}

	// 有项目：引导页 = 新建页面形态。虚拟会话只存在于渲染层 composer atoms，
	// 发送时由 promoteSessionComposerStateAtom 整体搬到真实会话，输入不丢失。
	// 项目下拉只切换 activeProjectId——切项目后仍留在引导页（currentSessionId 保持
	// 空），发送时按选中项目创建；下拉列表 = 已加入的全部项目（含内置 Chat）。
	//
	// 远端项目没有本机路径：使用同源远端目录/文本编辑宿主，各本机IPC仍按locator拒绝。
	// 会话创建仍由项目行入口负责，不把无会话引导页当成本机项目。
	if (isRemoteProject(props.activeProject)) {
		return <RemoteProjectPanel projectId={props.activeProject.id} projectName={props.activeProject.name} onOpenTerminal={props.onOpenTerminal} />;
	}

	return (
		<SessionStartSurface
			sessionId={GUIDE_BOOTSTRAP_SESSION_ID}
			// 虚拟会话无 record：用选中项目加载 @ 引用文件树与模型目录。
			bootstrapProjectId={props.activeProject.id}
			projectSwitcher={
				<Select value={props.activeProject.id} onValueChange={props.onSelectProject}>
					<SelectTrigger
						aria-label={t("app.guideProjectPicker")}
						className="h-6 max-w-56 gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-caption font-normal text-text-secondary shadow-none transition-colors hover:bg-transparent hover:text-text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-transparent [&_[data-slot='select-icon']]:hidden"
					>
						<FolderGit2 size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-text-tertiary" />
						<SelectValue />
					</SelectTrigger>
					<SelectContent align="start">
						{props.projects.map((project) => (
							<SelectItem key={project.id} value={project.id}>
								{isChatProject(project) ? t("app.chatProject") : project.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
		/>
	);
}
