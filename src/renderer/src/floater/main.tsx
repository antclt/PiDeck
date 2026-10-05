import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { LogoMark } from "../components/app/LogoMark";
import "./floater.css";

/** 悬浮球窗口的窄状态类型（与 main/floating/FloatingController.ts 对齐）。 */
interface FloatingBallState {
	visible: boolean;
	alwaysOnTop: boolean;
	snapToEdge: boolean;
	expandTarget: "mini" | "compact";
	activeCount: number;
	runningCount: number;
	recentTitles: string[];
	locale: "zh-CN" | "en-US";
}

const api = (
	window as unknown as {
		piDesktop: {
			floatingBall: {
				getState: () => Promise<FloatingBallState>;
				onStateChanged: (cb: (state: FloatingBallState) => void) => () => void;
				dragStart: () => Promise<void>;
				dragEnd: () => Promise<void>;
				contextMenu: () => Promise<void>;
			};
		};
	}
).piDesktop;

function statusText(state: FloatingBallState): string {
	if (state.runningCount > 0) {
		const title = state.recentTitles[0];
		const suffix = state.runningCount > 1 ? ` +${state.runningCount - 1}` : "";
		return title ? `${title}${suffix}` : `${state.runningCount} 个任务运行中`;
	}
	if (state.activeCount > 0) return `${state.activeCount} 个会话`;
	return "PiDeck";
}

function FloaterApp() {
	const [state, setState] = useState<FloatingBallState | null>(null);
	const [dragging, setDragging] = useState(false);
	const draggingRef = useRef(false);

	useEffect(() => {
		let cancelled = false;
		void api.floatingBall.getState().then((s) => {
			if (!cancelled) setState(s);
		});
		const off = api.floatingBall.onStateChanged(setState);
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	const onMouseDown = (e: React.MouseEvent) => {
		if (e.button !== 0) return;
		draggingRef.current = true;
		setDragging(true);
		void api.floatingBall.dragStart();
		const onMove = () => {
			/* 位置由主进程 polling 光标坐标更新，渲染层无需处理 move */
		};
		const onUp = () => {
			draggingRef.current = false;
			setDragging(false);
			void api.floatingBall.dragEnd();
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	const onContextMenu = (e: React.MouseEvent) => {
		e.preventDefault();
		void api.floatingBall.contextMenu();
	};

	if (!state) return <div style={{ width: "100%", height: "100%", background: "transparent" }} />;

	const text = statusText(state);
	const showBadge = state.runningCount > 0 && Boolean(state.recentTitles[0]);

	return (
		<div className="floater-root">
			{showBadge ? (
				<div className="floater-badge" title={state.recentTitles.join("、")}>
					<span className="floater-badge-dot" />
					<span className="floater-badge-text">{text}</span>
				</div>
			) : null}
			<button type="button" className={`floater-ball${dragging ? " floater-ball--dragging" : ""}${state.runningCount > 0 ? " floater-ball--running" : ""}`} onMouseDown={onMouseDown} onContextMenu={onContextMenu} aria-label={text} title={text}>
				<LogoMark size={40} />
				{state.runningCount > 0 ? <span className="floater-count">{state.runningCount}</span> : null}
			</button>
		</div>
	);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<FloaterApp />
	</React.StrictMode>,
);
