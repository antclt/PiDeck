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
	collapse: "收起为悬浮球",
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
	collapse: "Collapse to floating ball",
};

const dragRegion = { WebkitAppRegion: "drag" } as CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties;

const cardStyle: CSSProperties = {
	borderRadius: 16,
	overflow: "hidden",
	background: "var(--color-bg-app, #1a1a1e)",
	border: "1px solid var(--border, rgba(255,255,255,0.08))",
	boxShadow: "0 12px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05)",
	...(noDrag as object),
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
		<div className="flex h-screen w-screen flex-col" style={{ background: "transparent", ...dragRegion }}>
			<div className="flex h-full w-full flex-col" style={cardStyle}>
				{/* 顶部：状态总览 + 关闭 */}
				<header className="flex shrink-0 items-center justify-between border-b px-3 py-2" style={{ borderColor: "var(--border, rgba(255,255,255,0.08))", ...noDrag }}>
					<div className="flex items-center gap-2">
						<span className="text-xs font-medium" style={{ color: "var(--color-text-secondary, rgba(255,255,255,0.6))" }}>
							{copy.title}
						</span>
						<span className="text-[10px]" style={{ color: "var(--color-text-tertiary, rgba(255,255,255,0.35))" }}>
							{copy.running(running)} · {copy.active(active)}
						</span>
					</div>
					<div className="flex items-center gap-1">
						<button type="button" className="flex h-5 w-5 items-center justify-center rounded hover:bg-white/10" onClick={() => void desktopApi.miniOverlay.collapse()} aria-label={copy.collapse} title={copy.collapse}>
							<ChevronDown size={12} style={{ color: "var(--color-text-secondary, rgba(255,255,255,0.6))" }} />
						</button>
						<button type="button" className="flex h-5 w-5 items-center justify-center rounded hover:bg-white/10" onClick={() => void desktopApi.miniOverlay.close()} aria-label={copy.close} title={copy.close}>
							<X size={12} style={{ color: "var(--color-text-secondary, rgba(255,255,255,0.6))" }} />
						</button>
					</div>
				</header>

				{/* 快捷输入区 */}
				<div className="shrink-0 border-b px-3 py-2.5" style={{ borderColor: "var(--border, rgba(255,255,255,0.08))", ...noDrag }}>
					<div className="flex items-center gap-1.5">
						<select
							className="h-7 flex-1 rounded-md border px-2 text-xs"
							style={{
								background: "var(--color-bg-elevated, rgba(255,255,255,0.06))",
								borderColor: "var(--border, rgba(255,255,255,0.1))",
								color: "var(--color-text-primary, rgba(255,255,255,0.9))",
								...noDrag,
							}}
							value={projectId}
							onChange={(e) => setProjectId(e.target.value)}
						>
							{projects.length === 0 ? <option value="">{copy.emptyProjects}</option> : null}
							{projects.map((p) => (
								<option key={p.id} value={p.id}>
									{p.name}
								</option>
							))}
						</select>
						<button type="button" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md disabled:opacity-40" style={{ background: "var(--color-accent, #4f8ef7)", color: "var(--color-accent-foreground, #fff)", ...noDrag }} disabled={!canSend} onClick={() => void handleSend()} aria-label={copy.send}>
							{sending ? <span className="animate-spin text-[10px]">…</span> : <Plus size={14} />}
						</button>
					</div>
					<textarea
						className="mt-2 w-full resize-none rounded-md border px-2 py-1.5 text-xs"
						style={{
							background: "var(--color-bg-elevated, rgba(255,255,255,0.06))",
							borderColor: "var(--border, rgba(255,255,255,0.1))",
							color: "var(--color-text-primary, rgba(255,255,255,0.9))",
							...noDrag,
						}}
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
					/>
					{sendError ? (
						<p className="mt-1 text-[10px]" style={{ color: "var(--color-error, #f87171)" }}>
							{sendError}
						</p>
					) : null}
				</div>

				{/* 最近会话 */}
				<div className="flex-1 overflow-y-auto px-2 py-2" style={noDrag}>
					<p className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--color-text-tertiary, rgba(255,255,255,0.35))" }}>
						{copy.recent}
					</p>
					{sessions.length === 0 ? (
						<p className="px-1 text-xs" style={{ color: "var(--color-text-secondary, rgba(255,255,255,0.5))" }}>
							{copy.noSessions}
						</p>
					) : (
						<ul className="space-y-0.5">
							{sessions.map((s) => (
								<li key={s.id}>
									<button type="button" className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-white/8" onClick={() => handleJump(s.id, s.projectId)} style={{ color: "var(--color-text-primary, rgba(255,255,255,0.9))", ...noDrag }}>
										<span className="truncate">{s.title}</span>
										<ArrowRight size={12} className="shrink-0" style={{ color: "var(--color-text-tertiary, rgba(255,255,255,0.35))" }} />
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</div>
	);
}
