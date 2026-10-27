import { ArrowLeft, Plus, TerminalSquare } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";

/** 远端项目面板头部：返回、项目身份、新建会话与终端入口。 */
export function RemoteProjectHeader(props: { projectName: string; onBack?: () => void; onCreateSession?: () => void; onOpenTerminal?: () => void }) {
	return (
		<div className="flex flex-wrap items-center gap-2 text-label">
			{props.onBack ? (
				<Button variant="ghost" size="sm" data-testid="remote-project-back" onClick={props.onBack}>
					<ArrowLeft className="size-4" aria-hidden="true" />
					{t("project.remote.back")}
				</Button>
			) : null}
			<span className="rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">{t("project.remote.badge")}</span>
			<strong className="text-body font-semibold text-foreground">{props.projectName}</strong>
			<span className="text-muted-foreground">{t("project.remote.title")}</span>
			{/* 无会话空态的主入口：远端项目也能一键起会话。文件浏览仍是同一页的次要动作，
			    不把「新建会话」藏在侧栏项目行的 hover 按钮里。 */}
			{props.onCreateSession && (
				<Button variant="default" size="sm" data-testid="remote-project-new-session" onClick={props.onCreateSession}>
					<Plus className="size-4" aria-hidden="true" />
					{t("project.remote.newSession")}
				</Button>
			)}
			{props.onOpenTerminal && (
				<Button variant="ghost" size="sm" onClick={props.onOpenTerminal}>
					<TerminalSquare className="size-4" aria-hidden="true" />
					{t("app.terminal")}
				</Button>
			)}
		</div>
	);
}
