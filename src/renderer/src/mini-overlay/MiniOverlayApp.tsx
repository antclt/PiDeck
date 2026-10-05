import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowRight, ChevronDown, Plus, X } from "lucide-react";
import type { MiniOverlayState } from "../../../main/floating/MiniOverlayWindow";
import { desktopApi } from "../desktopApi";

const zh = {
	title: "PiDeck 极简浮窗",
	running: (n: number) => `${n} 个任务运行中`,
	active: (n: number) => `${n} 个活跃`,
	recent: "最近会话",
	quickPromptPlaceholder: "输入消息，选择项目后回车发送…",
	send: "发送",
	noSessions: "暂无活跃会话",
	emptyProjects: "暂无项目，请先在主窗口添加",
	close: "关闭",
};
const en = {
	title: "PiDeck Mini Overlay",
	running: (n: number) => `${n} running`,
	active: (n: number) => `${n} active`,
	recent: "Recent sessions",
	quickPromptPlaceholder: "Type a message, pick a project, press Enter…",
	send: "Send",
	noSessions: "No active sessions",
	emptyProjects: "No projects yet. Add one in the main window.",
	close: "Close",
};

export function MiniOverlayApp() {
	const [state, setState] = useState<MiniOverlayState | null>(null);
	const [prompt, setPrompt] = useState("");
	const [projectId, setProjectId] = useState("");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const copy = state?.locale === "en-US" ? en : zh;

	useEffect(() => {
		const unsub = desktopApi.miniOverlay.onStateChanged((s) => {
			setState(s);
			if (s.projects.length > 0 && !projectId) setProjectId(s.projects[0].id);
		});
		return unsub;
	}, [projectId]);

	const canSend = useMemo(() => prompt.trim().length > 0 && projectId.length > 0 && !sending, [prompt, projectId, sending]);

	const handleSend = async () => {
		if (!canSend) return;
		setSending(true);
		setSendError(null);
		const result = await desktopApi.miniOverlay.quickPrompt(projectId, prompt.trim());
		setSending(false);
		if (!result.ok) {
			setSendError(result.message ?? "failed");
		}
	};

	const handleJump = (sessionId: string, projectId: string) => {
		void desktopApi.miniOverlay.jumpToSession(sessionId, projectId);
	};

	const running = state?.runningCount ?? 0;
	const active = state?.activeCount ?? 0;
	const sessions = state?.recentSessions ?? [];
	const projects = state?.projects ?? [];

	return (
		<div className="flex h-screen w-screen flex-col bg-background text-foreground" style={{ borderRadius: 12, overflow: "hidden", border: "1px solid var(--border)", boxShadow: "0 8px 32px rgba(0,0,0,0.24)" }}>
			{/* 顶部：状态总览 + 关闭 */}
			<header className="flex shrink-0 items-center justify-between border-b border-border/60 px-3 py-2" style={{} as CSSProperties}>
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-muted-foreground">{copy.title}</span>
					<span className="text-[10px] text-muted-foreground/70">
						{copy.running(running)} · {copy.active(active)}
					</span>
				</div>
				<button type="button" className="flex h-5 w-5 items-center justify-center rounded hover:bg-accent" onClick={() => void desktopApi.miniOverlay.close()} style={{} as CSSProperties} aria-label={copy.close}>
					<X size={12} />
				</button>
			</header>

			{/* 快捷输入区 */}
			<div className="shrink-0 border-b border-border/60 px-3 py-2.5">
				<div className="flex items-center gap-1.5">
					<select className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-xs" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{} as CSSProperties}>
						{projects.length === 0 ? <option value="">{copy.emptyProjects}</option> : null}
						{projects.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
					<button type="button" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-50" disabled={!canSend} onClick={() => void handleSend()} aria-label={copy.send} style={{} as CSSProperties}>
						{sending ? <span className="animate-spin text-[10px]">…</span> : <Plus size={14} />}
					</button>
				</div>
				<textarea
					className="mt-2 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs"
					rows={3}
					placeholder={copy.quickPromptPlaceholder}
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							void handleSend();
						}
					}}
					style={{} as CSSProperties}
				/>
				{sendError ? <p className="mt-1 text-[10px] text-destructive">{sendError}</p> : null}
			</div>

			{/* 最近会话 */}
			<div className="flex-1 overflow-y-auto px-2 py-2">
				<p className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{copy.recent}</p>
				{sessions.length === 0 ? (
					<p className="px-1 text-xs text-muted-foreground">{copy.noSessions}</p>
				) : (
					<ul className="space-y-0.5">
						{sessions.map((s) => (
							<li key={s.id}>
								<button type="button" className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent" onClick={() => handleJump(s.id, s.projectId)} style={{} as CSSProperties}>
									<span className="truncate">{s.title}</span>
									<ArrowRight size={12} className="shrink-0 text-muted-foreground" />
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
