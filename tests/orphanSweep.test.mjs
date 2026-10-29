import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 孤儿进程回收（issue #450）。
 *
 * 这里是纯函数 + 注入 IO 的边界测试：不枚举真实进程、不杀任何东西。
 * 真实链路（PowerShell CIM 快照 → taskkill /T /F）只由数量与选择结果约束。
 */

const { deriveOrphanSweepMarkers, selectOrphanedManagedProcesses, sweepOrphanedManagedProcesses } = loadTsCommonJs("src/main/process/orphanSweep.ts");

test("标记派生：只取包名/可执行名，丢掉启动器、flag、URL 与版本号", () => {
	const markers = deriveOrphanSweepMarkers({
		mcpServers: [
			{ command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
			{ command: "node", args: ["C:\\Users\\u\\.config\\magpie\\mcp-npm\\hash\\node_modules\\chrome-devtools-mcp\\build\\src\\bin\\chrome-devtools-mcp.js"] },
			{ command: "uvx", args: ["mcp-server-time"] },
			{ url: "https://mcp.example.com/mcp" },
			{ command: "node", args: ["C:\\x\\node_modules\\@playwright\\mcp\\cli.js"] },
		],
		acpTools: [{ command: "npx", args: ["-y", "@tencent-ai/codebuddy-code@2.178.0", "--acp", "--agent", "ptc", "--effort", "high"] }],
	});

	// 跨 vm realm 的数组原型不同：复制成本 realm 数组再比较。
	assert.deepEqual([...markers], ["@modelcontextprotocol/server-memory", "@playwright/mcp", "@tencent-ai/codebuddy-code", "chrome-devtools-mcp", "mcp-server-time", "pi-coding-agent"]);
});

test("孤儿判定：父进程还活着的绝不选；父进程消失且命中标记才选", () => {
	const snapshot = {
		ids: [100, 200],
		processes: [
			// 活着的 pi（100）下面的 MCP：不是孤儿
			{ pid: 201, ppid: 100, cmd: "node npx-cli.js -y chrome-devtools-mcp" },
			// 父进程已消失 + 命中标记：孤儿
			{ pid: 301, ppid: 999, cmd: "node C:/x/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js" },
			// 父进程活着：即使命中也不碰
			{ pid: 302, ppid: 200, cmd: "node C:/x/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js" },
			// 父进程消失但没命中标记：别的进程，不动
			{ pid: 303, ppid: 999, cmd: "node C:/work/scripts/build.js" },
			// 父进程 PID 缺失（0）也算孤儿
			{ pid: 304, ppid: 0, cmd: "npx-cli.js -y mcp-server-time" },
			// npx 型 MCP 的链顶常是 cmd.exe：选中它，/T 会带走整棵子树
			{ pid: 305, ppid: 997, cmd: 'cmd.exe /d /s /c "npx -y chrome-devtools-mcp@latest"' },
		],
	};

	assert.deepEqual([...selectOrphanedManagedProcesses(snapshot, ["chrome-devtools-mcp", "mcp-server-time"])], [301, 304, 305]);
});

test("sweep：非 Windows / 无标记 / 快照失败都不动作，Windows 才按选择结果杀", async () => {
	const snapshot = {
		ids: [],
		processes: [
			{ pid: 401, ppid: 999, cmd: "npx-cli.js -y chrome-devtools-mcp" },
			{ pid: 402, ppid: 998, cmd: "node other.js" },
		],
	};
	const killed = [];
	// 跨 vm realm 的对象原型不同：复制成本 realm 对象再比较。
	const run = async (options) => ({ ...(await sweepOrphanedManagedProcesses(options)) });

	// 非 Windows：不枚举、不杀
	let snapshotCalls = 0;
	assert.deepEqual(
		await run({
			markers: ["chrome-devtools-mcp"],
			platform: "linux",
			snapshot: async () => {
				snapshotCalls += 1;
				return snapshot;
			},
			kill: (pid) => killed.push(pid),
		}),
		{ found: 0, killed: 0 },
	);
	assert.equal(snapshotCalls, 0);

	// 无标记：不枚举
	assert.deepEqual(
		await run({
			markers: [],
			platform: "win32",
			snapshot: async () => {
				snapshotCalls += 1;
				return snapshot;
			},
			kill: (pid) => killed.push(pid),
		}),
		{ found: 0, killed: 0 },
	);
	assert.equal(snapshotCalls, 0);

	// 快照失败：安静返回
	assert.deepEqual(await run({ markers: ["chrome-devtools-mcp"], platform: "win32", snapshot: async () => null, kill: (pid) => killed.push(pid) }), { found: 0, killed: 0 });
	assert.deepEqual(killed, []);

	// Windows：只杀命中的孤儿
	assert.deepEqual(await run({ markers: ["chrome-devtools-mcp"], platform: "win32", snapshot: async () => snapshot, kill: (pid) => killed.push(pid) }), { found: 1, killed: 1 });
	assert.deepEqual(killed, [401]);
});
