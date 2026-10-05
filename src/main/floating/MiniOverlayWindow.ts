import { app, BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import { ipcChannels } from "../../shared/ipc";
import { preparePreloadPath } from "../preloadPath";
import { rendererHeapAdditionalArguments } from "../v8HeapLimits";
import { readElectronChromiumSandboxPreference } from "../settings/SettingsStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AgentManager } from "../pi/AgentManager";
import type { ProjectStore } from "../projects/ProjectStore";
import { getAppLogger } from "../logging/sharedLogger";

/** 极简浮窗尺寸：状态总览 + 快捷输入 + 最近会话，刚好一屏放得下。 */
export const MINI_OVERLAY_W = 480;
export const MINI_OVERLAY_H = 640;

/** 极简浮窗状态快照：渲染层据此渲染状态区、快捷输入与最近会话列表。 */
export interface MiniOverlayState {
	visible: boolean;
	runningCount: number;
	activeCount: number;
	recentSessions: Array<{ id: string; title: string; projectId: string }>;
	projects: Array<{ id: string; name: string; path: string }>;
	locale: "zh-CN" | "en-US";
}

export interface MiniOverlayWindowDeps {
	settingsStore: SettingsStore;
	agentManager: AgentManager;
	projectStore: ProjectStore;
	/** 跳转到会话（复用 tray/pet 的 focusMainWindow + queueFocusTarget 链路）。 */
	onJumpToSession: (sessionId: string, projectId: string) => void;
	/** 快捷输入：创建草稿会话并发送 prompt。 */
	onQuickPrompt: (projectId: string, text: string) => Promise<{ ok: boolean; message?: string }>;
	/** 退出浮窗：关闭悬浮球模式，回主窗口。 */
	onExit?: () => void;
	/** 收起浮窗：回悬浮球，保持悬浮球模式。 */
	onCollapse?: () => void;
}

/**
 * MiniOverlayWindow —— 悬浮球点击展开的极简浮窗。
 * 360×480 无边框窗口：顶部状态总览（运行中/活跃数）+ 快捷输入框 + 最近会话列表 + 底部工具行。
 * 主窗口隐藏时仍可独立工作（agent 状态经 AgentManager 订阅推送）。
 */
export class MiniOverlayWindow {
	private win: BrowserWindow | null = null;
	private readonly deps: MiniOverlayWindowDeps;
	private removeAgentStateListener: (() => void) | null = null;
	private destroyed = false;

	constructor(deps: MiniOverlayWindowDeps) {
		this.deps = deps;
	}

	isActive(): boolean {
		return this.win !== null && !this.win.isDestroyed();
	}

	async show(): Promise<void> {
		if (this.destroyed || this.win) return;
		const sourcePreloadPath = join(__dirname, "../preload/index.js");
		const preloadPath = await preparePreloadPath(sourcePreloadPath, "mini-overlay-preload.js");
		const display = screen.getPrimaryDisplay();
		const { workArea } = display;
		this.win = new BrowserWindow({
			width: MINI_OVERLAY_W,
			height: MINI_OVERLAY_H,
			x: workArea.x + workArea.width - MINI_OVERLAY_W - 24,
			y: workArea.y + Math.floor((workArea.height - MINI_OVERLAY_H) / 2),
			frame: false,
			transparent: true,
			backgroundColor: "#00000000",
			resizable: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			hasShadow: false,
			show: false,
			webPreferences: {
				preload: preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: readElectronChromiumSandboxPreference(),
				additionalArguments: rendererHeapAdditionalArguments(),
			},
		});
		this.win.setMenu(null);
		this.win.setAlwaysOnTop(true, "floating");
		this.win.on("closed", () => {
			this.win = null;
			this.removeAgentStateListener?.();
			this.removeAgentStateListener = null;
			this.deps.onExit?.();
		});
		this.win.once("ready-to-show", () => {
			this.win?.show();
			this.win?.focus();
			this.pushState();
		});
		if (is.dev && process.env.ELECTRON_RENDERER_URL) {
			await this.win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/index.html?mini-overlay=1`);
		} else {
			await this.win.loadFile(join(__dirname, "../renderer/index.html"), { query: { "mini-overlay": "1" } });
		}
		this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		this.win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
			getAppLogger()?.error("mini-overlay", "Mini overlay load failed", { errorCode, errorDescription, url: validatedURL });
		});
		this.removeAgentStateListener = this.deps.agentManager.addStateListener(() => this.pushState());
		this.registerIpcHandlers();
	}

	hide(): void {
		if (this.win && !this.win.isDestroyed()) {
			this.win.close();
		}
		this.win = null;
		this.removeAgentStateListener?.();
		this.removeAgentStateListener = null;
	}

	destroy(): void {
		this.destroyed = true;
		this.hide();
	}

	private pushState(): void {
		if (!this.win || this.win.isDestroyed()) return;
		const tabs = this.deps.agentManager.list();
		const running = tabs.filter((t) => t.status === "running");
		const settings = this.deps.settingsStore.get();
		const state: MiniOverlayState = {
			visible: true,
			runningCount: running.length,
			activeCount: tabs.filter((t) => t.status !== "closed").length,
			recentSessions: tabs
				.filter((t) => t.status !== "closed")
				.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
				.slice(0, 5)
				.map((t) => ({ id: t.sessionId ?? t.id, title: t.title ?? "未命名", projectId: t.projectId })),
			projects: this.deps.projectStore.list().map((p) => ({ id: p.id, name: p.name, path: p.path })),
			locale: settings.language === "en-US" ? "en-US" : "zh-CN",
		};
		this.win.webContents.send(ipcChannels.miniOverlayState, state);
	}

	private registerIpcHandlers(): void {
		const win = this.win;
		if (!win) return;
		ipcMain.removeHandler(ipcChannels.miniOverlayJumpToSession);
		ipcMain.handle(ipcChannels.miniOverlayJumpToSession, (event, sessionId: string, projectId: string) => {
			if (event.sender !== win.webContents) return;
			if (typeof sessionId !== "string" || typeof projectId !== "string") return;
			this.deps.onJumpToSession(sessionId, projectId);
			this.hide();
		});
		ipcMain.removeHandler(ipcChannels.miniOverlayQuickPrompt);
		ipcMain.handle(ipcChannels.miniOverlayQuickPrompt, async (event, projectId: string, text: string) => {
			if (event.sender !== win.webContents) return { ok: false, message: "forbidden" };
			if (typeof projectId !== "string" || typeof text !== "string") return { ok: false, message: "invalid input" };
			const result = await this.deps.onQuickPrompt(projectId, text);
			if (result.ok) this.hide();
			return result;
		});
		ipcMain.removeHandler(ipcChannels.miniOverlayClose);
		ipcMain.handle(ipcChannels.miniOverlayClose, (event) => {
			if (event.sender !== win.webContents) return;
			this.hide();
			// 关闭浮窗后退出悬浮球模式（回主窗口）
			this.deps.onExit?.();
		});
		ipcMain.removeHandler(ipcChannels.miniOverlayCollapse);
		ipcMain.handle(ipcChannels.miniOverlayCollapse, (event) => {
			if (event.sender !== win.webContents) return;
			this.hide();
			// 收起浮窗后回悬浮球（保持悬浮球模式）
			this.deps.onCollapse?.();
		});
	}
}
