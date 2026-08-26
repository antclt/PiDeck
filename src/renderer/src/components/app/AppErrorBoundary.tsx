import { Button } from "../ui-shadcn/button";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { LogoMark } from "../app/AppParts";
import { t } from "../../i18n";
import { isLanWeb } from "../../desktopApi";
import { showNotice } from "../../utils/notice";
import { StackTrace } from "../ui-shadcn/stack-trace";

type AppErrorBoundaryProps = {
	children: ReactNode;
	/** 可选：局部边界标题，默认使用全局应用异常文案 */
	title?: string;
	/** 局部边界时提供重置回调，避免只能刷新整页 */
	onReset?: () => void;
};

type AppErrorBoundaryState = {
	error: Error | null;
};

/**
 * 全局/局部 React 错误边界。
 * 捕获子树渲染异常，避免整页白屏；同时通过 notice toast 提示用户。
 */
export class AppErrorBoundary extends Component<
	AppErrorBoundaryProps,
	AppErrorBoundaryState
> {
	override state: AppErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
		return { error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		// 渲染异常时 toast 提示；即使主界面损坏，也尽量让用户看到反馈。
		showNotice(
			`${t("app.renderErrorToast")}: ${error.message}`,
			6000,
			"error",
		);
		void window.piDesktop?.app
			.rendererLog("error", "renderer", "React render error boundary caught", {
				message: error.message,
				stack: error.stack,
				componentStack: info.componentStack,
			})
			.catch(() => undefined);
	}

	private handleReset = () => {
		this.setState({ error: null });
		this.props.onReset?.();
	};

	private handleReload = () => {
		window.location.reload();
	};

	private handleQuit = () => {
		// 全局边界会整页替换 App，自定义标题栏随之卸载；无框窗口若只留「重试/刷新」，
		// 用户无法退出。必须走 app.quit 而不是 closeWindow：开启 closeToTray 时关窗只会隐藏，
		// 崩溃页再藏起来就退不掉。preload 缺失时静默跳过，避免再抛一层。
		void window.piDesktop?.app.quit().catch(() => undefined);
	};

	override render() {
		if (!this.state.error) return this.props.children;

		const title = this.props.title ?? t("app.renderErrorTitle");
		const message = this.state.error.message || t("app.renderErrorUnknown");
		// LAN Web / 无 preload：浏览器自己有标签栏，desktopApi.quit 也不是真进程退出。
		const canQuitApp = Boolean(window.piDesktop) && !isLanWeb;

		return (
			<div className="app-error-boundary" role="alert">
				<div className="app-error-boundary-card">
					<div className="app-error-boundary-brand">
						<LogoMark />
					</div>
					<div className="app-error-boundary-badge">
						<span className="app-error-boundary-dot" aria-hidden="true" />
						{t("app.renderErrorToast")}
					</div>
					<h1 className="app-error-boundary-title">{title}</h1>
					<p className="app-error-boundary-message">{message}</p>
					<div className="app-error-boundary-stack">
						<div className="mb-1 text-caption font-medium text-text-secondary">{t("app.renderErrorStack")}</div>
						<StackTrace trace={this.state.error.stack ?? this.state.error.message} defaultOpen />
					</div>
					<div className="app-error-boundary-actions">
						<Button
							type="button"
							variant="outline"
							onClick={this.handleReset}
						>
							{t("app.renderErrorRetry")}
						</Button>
						<Button
							type="button"
							variant="default"
							onClick={this.handleReload}
						>
							{t("app.renderErrorReload")}
						</Button>
						{canQuitApp ? (
							<Button
								type="button"
								variant="outline"
								onClick={this.handleQuit}
							>
								{t("app.quit")}
							</Button>
						) : null}
					</div>
					<small className="app-error-boundary-help">
						{t("app.renderErrorHelp")}
					</small>
				</div>
			</div>
		);
	}
}
