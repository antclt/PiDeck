/**
 * PiDeck 插件 Demo —— 用一个文件演示「给 PiDeck 写插件」的三层能力。
 *
 * 【这是什么】
 * PiDeck 的插件 = pi 扩展（TypeScript 单文件，pi 用 jiti 直接加载，无需编译）。
 * 放进扩展目录后重启会话即可生效；PiDeck 设置 → 扩展页可以禁用/启用它。
 *
 * 【怎么装】
 *   用户级（所有项目生效）：~/.pi/agent/extensions/pi-deck-demo-plugin.ts
 *   项目级（仅当前项目）：<项目>/.pi/extensions/pi-deck-demo-plugin.ts
 *
 * 【演示了什么】
 * 1. /demo 命令（pi 原生能力，任何宿主可用）
 * 2. 事件监听：统计本会话的回合数与工具调用（pi 原生能力）
 * 3. ctx.ui.setWidget：状态条渲染（终端与 PiDeck 都可用）
 * 4. ctx.ui.gui：PiDeck 专属 UI 落点——侧栏面板 + 输入区工具条 + 状态区/时间线/终端工具区
 * 5. 宿主原生服务：gui.filePicker（原生文件选择）与 gui.openPath（系统默认程序打开）
 *
 * 【改我】
 * 这个文件就是你的起步模板：改 key、改文案、改节点树，重启会话看效果。
 * 完整能力清单（42 种节点、19 个落点、事件表）见扩展目录里的 AI-PLUGIN-GUIDE.md。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 本地结构类型（避免依赖 PiDeck 内部模块；完整类型见文档）────────
// GuiNode 是普通可序列化对象：{ kind: "...", ...字段, children?: GuiNode[] }。
// 安全约束：不能出现 React 元素；颜色只能用语义 tone（"accent" | "success" | ...）；
// 单次序列化上限 2000 节点 / 深度 32。
type GuiNode = Record<string, unknown> & { kind: string; children?: GuiNode[] };

/** ctx.ui.gui 的形状（只在 PiDeck 里存在；纯终端下为 undefined，用前必须判空）。 */
type GuiLike = {
	setSidebarPanel: (key: string, factory: unknown, options?: { title?: string; order?: number }) => void;
	setComposerToolbar: (key: string, factory: unknown, options?: { title?: string; order?: number }) => void;
	setStatusbarItem: (key: string, factory: unknown, options?: { title?: string; order?: number }) => void;
	setTerminalToolbar: (key: string, factory: unknown, options?: { title?: string; order?: number }) => void;
	setTimelineEvent: (key: string, factory: unknown, options?: { title?: string; order?: number }) => void;
	command: (id: string, handler: () => void) => void;
	toast: (message: string, options?: { tone?: string }) => void;
	overlay: (node: GuiNode) => { close: () => void };
	filePicker: (options?: { title?: string; multiple?: boolean; directory?: boolean; filters?: { name: string; extensions: string[] }[] }) => Promise<string[] | null>;
	openPath: (path: string) => Promise<boolean>;
};

/** 从事件 ctx 上安全取 GUI 命名空间（推荐入口：ctx.ui.gui，桥挂载后所有事件里可用）。 */
function getGui(ctx: { ui?: { gui?: GuiLike } }): GuiLike | undefined {
	return ctx.ui?.gui;
}

// ── 插件状态（闭包持有；动态面板的 render() 每次都读它，改了下一帧就刷新）──
type DemoState = {
	turns: number;
	toolCalls: number;
	lastTool: string;
	startedAt: string;
	greetings: number;
	lastPicked: string;
};

const state: DemoState = {
	turns: 0,
	toolCalls: 0,
	lastTool: "-",
	startedAt: "",
	greetings: 0,
	lastPicked: "",
};

const state: DemoState = {
	turns: 0,
	toolCalls: 0,
	lastTool: "-",
	startedAt: "",
	greetings: 0,
	lastPicked: "",
};

export default function demoPlugin(pi: ExtensionAPI): void {
	// ── 1. /demo 命令：pi 原生扩展点 ─────────────────────────────
	pi.registerCommand("demo", {
		description: "PiDeck 插件 Demo：打开说明浮层",
		handler: async (_args, ctx) => {
			const gui = getGui(ctx);
			if (gui) {
				gui.toast("Demo 插件已就绪：侧栏统计面板 + 输入区按钮都在工作", { tone: "success" });
				showAboutOverlay(gui);
			} else {
				// 纯终端宿主：ctx.ui.notify 退化可用，永远要有非 GUI 兜底
				ctx.ui.notify("Demo 插件已就绪（当前宿主无 GUI 落点，仅命令与事件生效）", "info");
			}
		},
	});

	// ── 2. 事件监听：pi 原生扩展点（任何宿主可用）────────────────
	pi.on("session_start", (_event, ctx) => {
		state.startedAt = new Date().toISOString().slice(11, 19);
		mountGui(ctx);
		// 兜底：若本扩展先于桥加载，session_start 时 ctx.ui.gui 还没挂上，agent_start 必然可用
		ctx.ui.setWidget("demo-status", ["Demo 插件已加载（会话开始于 " + state.startedAt + "）"]);
	});

	pi.on("agent_start", (_event, ctx) => {
		mountGui(ctx);
	});

	pi.on("tool_call", (event) => {
		// tool_call 携带本次工具调用信息；这里只读不改（返回 undefined = 放行）
		state.toolCalls += 1;
		state.lastTool = String((event as { name?: string }).name ?? "-");
		return undefined;
	});

	pi.on("agent_end", (_event, ctx) => {
		state.turns += 1;
		// setWidget(key, string[])：终端与 PiDeck 都能渲染的最低成本状态条
		ctx.ui.setWidget("demo-status", [`回合 ${state.turns} · 工具 ${state.toolCalls} · 最近 ${state.lastTool}`]);
	});

	// 会话结束：清掉自己占的落点（生命周期配对，不留幽灵 UI）
	pi.on("session_shutdown", () => {
		unmounted = true;
	});
}

// ── 4. PiDeck 专属：GUI 落点挂载（幂等）────────────────────────
let mounted = false;
let unmounted = false;

function mountGui(ctx: { ui?: { gui?: GuiLike } }): void {
	if (mounted || unmounted) return;
	const gui = getGui(ctx);
	if (!gui) return; // 纯终端宿主：静默跳过，绝不抛错
	mounted = true;

	// 侧栏面板 —— 动态内容必须返回 GuiComponent（render() 每帧重建节点；
	// 直接返回 GuiNode 只求值一次，适合静态内容）。桥以 10Hz tick 轮询 + 哈希去重推送。
	gui.setSidebarPanel(
		"demo-stats",
		() => ({
			render: () => statsPanelNode(),
			handleAction(actionId: string) {
				if (actionId === "demo.reset") {
					state.turns = 0;
					state.toolCalls = 0;
					state.lastTool = "-";
				}
			},
		}),
		{ title: "Demo 统计", order: 500 },
	);

	// 输入区工具条 —— 静态按钮组，直接返回 GuiNode 即可
	gui.setComposerToolbar("demo-actions", () => toolbarNode(), { order: 500 });

	// 会话头部状态区 —— 动态紧凑条目（setStatusbarItem；render 每帧重建，读闭包状态）
	gui.setStatusbarItem("demo-status", () => ({
		render: () => ({
			kind: "hstack",
			gap: 8,
			children: [
				{ kind: "badge", label: "Demo", tone: "accent" },
				{ kind: "text", text: `回合 ${state.turns} · 工具 ${state.toolCalls} · 问候 ${state.greetings}`, style: ["dim"] },
			],
		}),
	}));

	// 终端面板工具区 —— 另一处共享 chrome 落点示例
	gui.setTerminalToolbar("demo-terminal", () => ({
		kind: "hstack",
		gap: 6,
		children: [{ kind: "button", label: "终端 × Demo", actionId: "demo.hello", variant: "ghost" }],
	}));

	// 时间线底部事件条 —— 静态标记
	gui.setTimelineEvent("demo-note", () => ({
		kind: "hstack",
		gap: 6,
		children: [
			{ kind: "badge", label: "Demo", tone: "success" },
			{ kind: "text", text: "会话开始于 " + (state.startedAt || "-") + "；本条由 setTimelineEvent 渲染", style: ["dim"] },
		],
	}));

	// 交互回调：按钮 actionId → gui.command 注册（与节点树解耦）
	gui.command("demo.hello", () => {
		state.greetings += 1;
		gui.toast(`Hello from your plugin! （第 ${state.greetings} 次问候）`, { tone: "accent" });
	});
	gui.command("demo.about", () => showAboutOverlay(gui));

	// 宿主原生服务：文件选择 + 系统打开（Promise 往返，取消/失败都要兑底）
	gui.command("demo.pickfile", () => {
		void (async () => {
			try {
				const picked = await gui.filePicker({ title: "Demo：选一个文件", filters: [{ name: "TypeScript", extensions: ["ts"] }] });
				if (!picked || picked.length === 0) {
					gui.toast("未选择文件（用户取消）", { tone: "default" });
					return;
				}
				state.lastPicked = picked[0];
				gui.toast(`已选：${picked[0]}`, { tone: "success" });
			} catch (error) {
				// 老版 PiDeck 不支持该服务 / 超时会 reject —— 插件必须兑底
				gui.toast(`filePicker 失败：${error instanceof Error ? error.message : String(error)}`, { tone: "warning" });
			}
		})();
	});
	gui.command("demo.openpicked", () => {
		void (async () => {
			if (!state.lastPicked) {
				gui.toast("先点「选文件」再打开", { tone: "warning" });
				return;
			}
			try {
				const ok = await gui.openPath(state.lastPicked);
				gui.toast(ok ? "已用系统默认程序打开" : "openPath 返回失败", { tone: ok ? "success" : "warning" });
			} catch (error) {
				gui.toast(`openPath 失败：${error instanceof Error ? error.message : String(error)}`, { tone: "warning" });
			}
		})();
	});
}

/** 侧栏面板内容：vstack + keyvalue + button 的组合示例。 */
function statsPanelNode(): GuiNode {
	return {
		kind: "vstack",
		gap: 8,
		children: [
			{ kind: "badge", label: "插件 Demo", tone: "accent" },
			{
				kind: "keyvalue",
				entries: [
					{ key: "会话开始", value: state.startedAt || "-" },
					{ key: "回合数", value: String(state.turns) },
					{ key: "工具调用", value: String(state.toolCalls) },
					{ key: "最近工具", value: state.lastTool },
					{ key: "问候次数", value: String(state.greetings) },
				],
			},
			{ kind: "button", label: "重置统计", actionId: "demo.reset", variant: "outline" },
		],
	};
}

/** 输入区工具条：hstack + button。actionId 对应上面 gui.command 注册的处理器。 */
function toolbarNode(): GuiNode {
	return {
		kind: "hstack",
		gap: 6,
		children: [
			{ kind: "button", label: "👋 Hello", actionId: "demo.hello", variant: "ghost" },
			{ kind: "button", label: "选文件", actionId: "demo.pickfile", variant: "ghost" },
			{ kind: "button", label: "打开所选", actionId: "demo.openpicked", variant: "ghost" },
			{ kind: "button", label: "关于 Demo", actionId: "demo.about", variant: "ghost" },
		],
	};
}

/** 说明浮层：modal 节点示例。 */
function showAboutOverlay(gui: GuiLike): void {
	gui.overlay({
		kind: "card",
		title: "PiDeck 插件 Demo",
		children: [
			{
				kind: "markdown",
				md: [
					"这个面板由 `ctx.ui.gui.overlay()` 渲染——你的插件可以在 PiDeck 里：",
					"",
					"- 注册 `/命令`（本文件的 `/demo`）",
					"- 监听会话/消息/工具事件",
					"- 在侧栏、输入区、横幅等 **19 个落点**渲染 UI",
					"- 使用 42 种声明式节点（本浮层就是 `card + markdown + button`）",
					"",
					"改这个文件 → 重启会话 → 立即看效果。",
				].join("\n"),
			},
			{ kind: "divider" },
			{ kind: "text", text: "完整能力清单见扩展目录里的 AI-PLUGIN-GUIDE.md", style: ["dim"] },
		],
	});
}
