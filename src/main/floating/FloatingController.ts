import { app, BrowserWindow, ipcMain, Menu, screen, type MenuItemConstructorOptions } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import { ipcChannels } from "../../shared/ipc";
import { mainProcessT, normalizeMainProcessLocale, type MainProcessLocale } from "../../shared/i18n/mainProcessCopy";
import { preparePreloadPath } from "../preloadPath";
import { rendererHeapAdditionalArguments } from "../v8HeapLimits";
import { readElectronChromiumSandboxPreference } from "../settings/SettingsStore";
import type { SettingsStore } from "../settings/SettingsStore";
import { getAppLogger } from "../logging/sharedLogger";

/** 悬浮球尺寸（圆形 64px，与工作台主窗口无关）。 */
export const FLOATER_SIZE = 64;
/** 状态气泡宽度（悬浮球上方展示运行状态文本）。 */
const FLOATER_BADGE_H = 22;

function posPath(): string {
	return join(app.getPath("userData"), "floater-position.json");
}

interface FloaterPos {
	x: number;
	y: number;
}

async function loadPos(): Promise<FloaterPos | null> {
	try {
		const raw = await readFile(posPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed.x === "number" && typeof parsed.y === "number") return parsed;
		return null;
	} catch {
		return null;
	}
}

async function savePos(bounds: FloaterPos): Promise<void> {
	try {
		await mkdir(app.getPath("userData"), { recursive: true });
		await writeFile(posPath(), JSON.stringify(bounds, null, 2), "utf8");
	} catch {
		/* 保存失败不影响运行 */
	}
}

/** 悬浮球状态快照：渲染层据此渲染状态气泡与 Logo。 */
export interface FloatingBallState {
	visible: boolean;
	alwaysOnTop: boolean;
	snapToEdge: boolean;
	expandTarget: "mini" | "compact";
	activeCount: number;
	runningCount: number;
	recentTitles: string[];
	locale: MainProcessLocale;
}

export interface FloatingControllerDeps {
	settingsStore: SettingsStore;
	/** 主窗口引用（隐藏/显示主窗口）。 */
	getMainWindow: () => BrowserWindow | null;
	/** 点击悬浮球展开 mini 浮窗：主进程只负责转发，由 useQuickTask 或 mini overlay 接管。 */
	onExpandMini: () => Promise<void>;
	/** 点击悬浮球展开 compact 紧凑模式。 */
	onExpandCompact: () => Promise<void>;
	/** 显示主窗口并退出悬浮模式。 */
	onShowMainWindow: () => void;
	/** 订阅 agent 状态变化（返回 unsubscribe）。 */
	addAgentStateListener: (listener: (tabs: Array<{ id: string; status: string; title?: string }>) => void) => () => void;
	/** 当前活跃 agent 数。 */
	getActiveAgentCount: () => number;
	/** 当前运行中 agent 数。 */
	getRunningAgentCount: () => number;
	/** 最近运行中的 agent 标题（最多 3 个，用于悬浮球气泡）。 */
	getRecentRunningTitles: () => string[];
}

/**
 * FloatingController —— 悬浮球生命周期管理。
 * 主窗口隐藏后，屏幕角落常驻一个 64px 圆形悬浮球；
 * 单击展开（mini 浮窗 / compact 紧凑模式），右键切换展开目标或退出悬浮模式。
 * 位置持久化到 floater-position.json，重启后恢复。
 */
export class FloatingController {
	private win: BrowserWindow | null = null;
	private readonly deps: FloatingControllerDeps;
	private removeAgentStateListener: (() => void) | null = null;
	private state: FloatingBallState;
	private destroyed = false;

	constructor(deps: FloatingControllerDeps) {
		this.deps = deps;
		const settings = deps.settingsStore.get();
		this.state = {
			visible: false,
			alwaysOnTop: settings.floatingBallAlwaysOnTop ?? true,
			snapToEdge: settings.floatingBallSnapToEdge ?? true,
			expandTarget: settings.floatingBallExpandTarget ?? "mini",
			activeCount: 0,
			runningCount: 0,
			recentTitles: [],
			locale: normalizeMainProcessLocale(settings.language),
		};
	}

	/** 进入悬浮模式：隐藏主窗口，显示悬浮球。 */
	async enter(): Promise<void> {
		if (this.destroyed) return;
		const settings = this.deps.settingsStore.get();
		if (!settings.floatingBallEnabled) return;
		const mainWin = this.deps.getMainWindow();
		if (mainWin && !mainWin.isDestroyed()) {
			mainWin.hide();
		}
		await this.show();
	}

	/** 退出悬浮模式：显示主窗口，关闭悬浮球。 */
	async exit(): Promise<void> {
		this.deps.onShowMainWindow();
		this.hide();
	}

	isActive(): boolean {
		return this.state.visible;
	}

	getState(): FloatingBallState {
		return { ...this.state };
	}

	async show(): Promise<void> {
		if (this.destroyed || this.win) return;
		const settings = this.deps.settingsStore.get();
		if (!settings.floatingBallEnabled) return;
		const pos = (await loadPos()) ?? this.defaultPos();
		const sourcePreloadPath = join(__dirname, "../preload/index.js");
		const preloadPath = await preparePreloadPath(sourcePreloadPath, "floater-preload.js");
		this.win = new BrowserWindow({
			width: FLOATER_SIZE,
			height: FLOATER_SIZE + FLOATER_BADGE_H,
			x: pos.x,
			y: pos.y,
			frame: false,
			transparent: true,
			resizable: false,
			skipTaskbar: true,
			alwaysOnTop: settings.floatingBallAlwaysOnTop,
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
		this.win.setAlwaysOnTop(settings.floatingBallAlwaysOnTop, "screen-saver");
		this.attachDragHandlers(this.win);
		this.win.on("closed", () => {
			this.win = null;
			this.state.visible = false;
		});
		this.win.once("ready-to-show", () => {
			this.win?.show();
			this.state.visible = true;
			this.pushState();
		});
		this.win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
			getAppLogger()?.error("floating-ball", "Floater load failed", { errorCode, errorDescription, url: validatedURL });
		});
		if (is.dev && process.env.ELECTRON_RENDERER_URL) {
			await this.win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/floater.html`);
		} else {
			await this.win.loadFile(join(__dirname, "../renderer/floater.html"));
		}
		this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		this.removeAgentStateListener = this.deps.addAgentStateListener(() => this.refreshAgentState());
		this.refreshAgentState();
	}

	hide(): void {
		if (this.win && !this.win.isDestroyed()) {
			this.win.close();
		}
		this.win = null;
		this.state.visible = false;
		this.removeAgentStateListener?.();
		this.removeAgentStateListener = null;
	}

	destroy(): void {
		this.destroyed = true;
		this.hide();
	}

	/** 设置变更热更（alwaysOnTop/snapToEdge/expandTarget）。 */
	onSettingsChanged(): void {
		const settings = this.deps.settingsStore.get();
		this.state.alwaysOnTop = settings.floatingBallAlwaysOnTop;
		this.state.snapToEdge = settings.floatingBallSnapToEdge;
		this.state.expandTarget = settings.floatingBallExpandTarget;
		this.state.locale = normalizeMainProcessLocale(settings.language);
		if (this.win && !this.win.isDestroyed()) {
			this.win.setAlwaysOnTop(settings.floatingBallAlwaysOnTop, "screen-saver");
		}
		this.pushState();
	}

	/** 设置页 toggle：enabled 变化时 show/hide 悬浮球。 */
	async setEnabled(enabled: boolean): Promise<void> {
		if (enabled) {
			await this.show();
		} else {
			this.hide();
		}
	}

	/** 设置页切换展开目标。 */
	setExpandTarget(target: "mini" | "compact"): void {
		this.state.expandTarget = target;
		void this.deps.settingsStore.update({ floatingBallExpandTarget: target });
		this.pushState();
	}

	/** 悬浮球点击：按当前 expandTarget 展开对应模式。 */
	handleClick(): void {
		if (this.state.expandTarget === "compact") {
			void this.deps.onExpandCompact();
		} else {
			void this.deps.onExpandMini();
		}
	}

	/** 悬浮球右键菜单。 */
	showContextMenu(): void {
		const expandTarget = this.state.expandTarget;
		const template: MenuItemConstructorOptions[] = [
			{
				label: mainProcessT(this.state.locale, "floater.expandMini"),
				type: "radio",
				checked: expandTarget === "mini",
				click: () => {
					this.state.expandTarget = "mini";
					void this.deps.settingsStore.update({ floatingBallExpandTarget: "mini" });
					this.pushState();
					this.deps.onExpandMini();
				},
			},
			{
				label: mainProcessT(this.state.locale, "floater.expandCompact"),
				type: "radio",
				checked: expandTarget === "compact",
				click: () => {
					this.state.expandTarget = "compact";
					void this.deps.settingsStore.update({ floatingBallExpandTarget: "compact" });
					this.pushState();
					this.deps.onExpandCompact();
				},
			},
			{ type: "separator" },
			{
				label: mainProcessT(this.state.locale, "floater.exitToWorkbench"),
				click: () => void this.exit(),
			},
			{ type: "separator" },
			{
				label: mainProcessT(this.state.locale, "floater.quit"),
				click: () => {
					this.destroy();
					app.quit();
				},
			},
		];
		const menu = Menu.buildFromTemplate(template);
		menu.popup({ window: this.win ?? undefined });
	}

	private refreshAgentState(): void {
		this.state.activeCount = this.deps.getActiveAgentCount();
		this.state.runningCount = this.deps.getRunningAgentCount();
		this.state.recentTitles = this.deps.getRecentRunningTitles().slice(0, 3);
		this.pushState();
	}

	private pushState(): void {
		if (this.win && !this.win.isDestroyed()) {
			this.win.webContents.send(ipcChannels.floatingBallState, this.state);
		}
	}

	private attachDragHandlers(win: BrowserWindow): void {
		let dragOffset: { x: number; y: number } | null = null;
		let moved = false;
		ipcMain.removeHandler(ipcChannels.floatingBallDragStart);
		ipcMain.handle(ipcChannels.floatingBallDragStart, (event) => {
			if (event.sender !== win.webContents) return;
			const [boundsX, boundsY] = win.getPosition();
			const cursor = screen.getCursorScreenPoint();
			dragOffset = { x: cursor.x - boundsX, y: cursor.y - boundsY };
			moved = false;
		});
		// 拖动经 polling 而非 IPC move（渲染层 rAF 直推位置，主进程只做落盘与吸附）
		const poll = setInterval(() => {
			if (!dragOffset || win.isDestroyed()) return;
			const cursor = screen.getCursorScreenPoint();
			const x = cursor.x - dragOffset.x;
			const y = cursor.y - dragOffset.y;
			const [cx, cy] = win.getPosition();
			if (Math.abs(cx - x) > 2 || Math.abs(cy - y) > 2) moved = true;
			win.setPosition(x, y);
		}, 16);
		win.on("closed", () => clearInterval(poll));
		ipcMain.removeHandler(ipcChannels.floatingBallDragEnd);
		ipcMain.handle(ipcChannels.floatingBallDragEnd, (event) => {
			if (event.sender !== win.webContents) return;
			dragOffset = null;
			const [x, y] = win.getPosition();
			const snap = this.deps.settingsStore.get().floatingBallSnapToEdge;
			const finalPos = snap ? this.snapToEdge(x, y) : { x, y };
			if (snap && (finalPos.x !== x || finalPos.y !== y)) {
				win.setPosition(finalPos.x, finalPos.y);
			}
			void savePos(finalPos);
			// 拖动距离过小视为点击
			if (!moved) this.handleClick();
		});
		ipcMain.removeHandler(ipcChannels.floatingBallContextMenu);
		ipcMain.handle(ipcChannels.floatingBallContextMenu, (event) => {
			if (event.sender !== win.webContents) return;
			this.showContextMenu();
		});
	}

	private snapToEdge(x: number, y: number): { x: number; y: number } {
		const display = screen.getDisplayNearestPoint({ x, y });
		const { workArea } = display;
		const midX = workArea.x + workArea.width / 2;
		const targetX = x + FLOATER_SIZE / 2 < midX ? workArea.x : workArea.x + workArea.width - FLOATER_SIZE;
		const clampedY = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - FLOATER_SIZE - FLOATER_BADGE_H));
		return { x: targetX, y: clampedY };
	}

	private defaultPos(): FloaterPos {
		const display = screen.getPrimaryDisplay();
		const { workArea } = display;
		return {
			x: workArea.x + workArea.width - FLOATER_SIZE - 24,
			y: workArea.y + Math.floor(workArea.height * 0.4),
		};
	}
}
