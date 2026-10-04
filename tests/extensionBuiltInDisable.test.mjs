import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const require = createRequire(import.meta.url);

/**
 * 生产 TS 依赖图加载器（按**源文件目录**解析相对 import，同实例内缓存）。
 *
 * 这里不用手写 require 桥：它以 tests/ 为基准解析，生产模块一新增本地 import
 * 就整片失败，而且「只给部分导出」的桩会静默变成 undefined —— 本文件 2026-09
 * 就因为 ExtensionManager 新增 `INTERNAL_BUILT_IN_EXTENSIONS` 导入而红了三条。
 */
const loadProductionTs = createTsSandbox();

/** 本地 TS 依赖 → 仓库相对路径（未列出的相对 import 会落到 Node 解析而失败，需补表）。 */
const LOCAL_TS_MODULES = {
	"../wsl/WslPaths": "src/main/wsl/WslPaths.ts",
	"./builtInExtensions": "src/main/extensions/builtInExtensions.ts",
	"./extensionVersionGate": "src/main/extensions/extensionVersionGate.ts",
	"./extensionDiscovery": "src/main/extensions/extensionDiscovery.ts",
	"../utils/versionCompare": "src/main/utils/versionCompare.ts",
};

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

/**
 * 加载 ExtensionManager，并把 homeDir 重定向到 fixture（通过 mock os.homedir）。
 * 同时可 mock runPi 输出，便于测 list 冲突路径。
 */
function loadExtensionManager({ homeDir, runPiOutput = "", fsOverrides = {} } = {}) {
	const realOs = require("node:os");
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "node:os") {
				return {
					...realOs,
					homedir: () => homeDir ?? realOs.homedir(),
				};
			}
			if (id === "node:fs/promises") {
				return { ...require(id), ...fsOverrides };
			}
			if (id === "node:child_process") {
				const real = require(id);
				return {
					...real,
					execFile: (cmd, args, opts, cb) => {
						// runPi 走 execFile；返回预设 stdout，模拟 pi list
						queueMicrotask(() => cb(null, runPiOutput, ""));
					},
				};
			}
			// 需替换为替身的依赖（外部副作用 / 需重定向 home）
			if (id === "../pi/PiLocator") return {};
			// updatePi 成功后调用 PiProcess.invalidateVersionCache；桩掉避免拉 PiProcess 依赖图。
			if (id === "../pi/PiProcess") return { PiProcess: { invalidateVersionCache: () => {} } };
			if (id === "../fs/trash") return { trashPath: async () => {} };
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			// 其余本地 TS 依赖一律加载**真模块**（含导出与行为），不再造部分导出桩
			if (LOCAL_TS_MODULES[id]) return loadProductionTs(LOCAL_TS_MODULES[id]);
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/extensions/ExtensionManager.ts"), sandbox, {
		filename: "ExtensionManager.ts",
	});
	return sandbox.exports;
}

test("disableBuiltIn records removal and deletes user extension file", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-disable-builtin-"));
	const extensionsDir = join(fixtureHome, ".pi", "agent", "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	const target = join(extensionsDir, "pi-deck-todo.ts");
	writeFileSync(target, "// builtin todo\n", "utf8");

	let settings = { removedBuiltInExtensions: [] };
	const { ExtensionManager } = loadExtensionManager({ homeDir: fixtureHome });
	const manager = new ExtensionManager(
		{
			// locator 占位：disableBuiltIn 不调用 runPi
			check: async () => ({ installed: true, version: "0.80.0" }),
			createInvocation: (cmd, args) => ({ command: cmd, args, shell: false }),
			createProcessEnv: () => process.env,
			resolveCommand: () => "pi",
		},
		() => ({}),
		() => settings,
		async (patch) => {
			settings = { ...settings, ...patch };
			return settings;
		},
	);

	assert.equal(existsSync(target), true);
	await manager.disableBuiltIn("pi-deck-todo.ts");
	assert.equal(existsSync(target), false);
	// 注意：vm 沙箱内创建的数组与外层 realm 的 deepStrictEqual 可能因原型不同失败，逐项比较。
	assert.equal(settings.removedBuiltInExtensions?.length, 1);
	assert.equal(settings.removedBuiltInExtensions?.[0], "pi-deck-todo.ts");
	// 幂等：再删一次不应抛错，也不应重复写入
	await manager.disableBuiltIn("pi-deck-todo.ts");
	assert.equal(settings.removedBuiltInExtensions?.length, 1);
	assert.equal(settings.removedBuiltInExtensions?.[0], "pi-deck-todo.ts");

	rmSync(fixtureHome, { recursive: true, force: true });
});

test("list auto-disables built-in todo and deletes file when third-party rpiv-todo is present", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-conflict-todo-"));
	const extensionsDir = join(fixtureHome, ".pi", "agent", "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	const builtinPath = join(extensionsDir, "pi-deck-todo.ts");
	writeFileSync(builtinPath, "// builtin\n", "utf8");

	let settings = { removedBuiltInExtensions: [] };
	const piListOutput = ["User packages:", "npm:@juicesharp/rpiv-todo", join(fixtureHome, ".pi", "agent", "npm", "node_modules", "@juicesharp", "rpiv-todo"), ""].join("\n");

	const { ExtensionManager } = loadExtensionManager({
		homeDir: fixtureHome,
		runPiOutput: piListOutput,
	});

	// 绕过 noApproveSupported 的版本探测：直接 stub getPiVersion 路径
	// detectPiVersion 走 locator.check；给一个有效版本即可。
	const locator = {
		check: async () => ({ installed: true, version: "0.80.0" }),
		createInvocation: (cmd, args) => ({
			command: cmd,
			args,
			shell: false,
			pathPrefix: undefined,
			wsl: false,
			windowsVerbatimArguments: false,
		}),
		createProcessEnv: () => ({ ...process.env }),
		resolveCommand: () => "pi",
	};

	const manager = new ExtensionManager(
		locator,
		() => ({}),
		() => settings,
		async (patch) => {
			settings = { ...settings, ...patch };
			return settings;
		},
	);

	assert.equal(existsSync(builtinPath), true);
	const result = await manager.list(false);

	assert.equal(settings.removedBuiltInExtensions.includes("pi-deck-todo.ts"), true);
	assert.equal(existsSync(builtinPath), false, "conflicting built-in file must be deleted");
	assert.ok(result.conflicts?.some((c) => c.builtIn === "pi-deck-todo.ts"));
	const builtin = result.extensions.find((e) => e.source === "pi-deck-todo.ts");
	assert.equal(builtin?.enabled, false);

	rmSync(fixtureHome, { recursive: true, force: true });
});

test("list purges residual built-in file already marked removed", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-residual-todo-"));
	const extensionsDir = join(fixtureHome, ".pi", "agent", "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	const builtinPath = join(extensionsDir, "pi-deck-todo.ts");
	writeFileSync(builtinPath, "// leftover after disable-without-delete\n", "utf8");

	let settings = { removedBuiltInExtensions: ["pi-deck-todo.ts"] };
	const { ExtensionManager } = loadExtensionManager({
		homeDir: fixtureHome,
		runPiOutput: "User packages:\n",
	});
	const locator = {
		check: async () => ({ installed: true, version: "0.80.0" }),
		createInvocation: (cmd, args) => ({
			command: cmd,
			args,
			shell: false,
			pathPrefix: undefined,
			wsl: false,
			windowsVerbatimArguments: false,
		}),
		createProcessEnv: () => ({ ...process.env }),
		resolveCommand: () => "pi",
	};
	const manager = new ExtensionManager(
		locator,
		() => ({}),
		() => settings,
		async (patch) => {
			settings = { ...settings, ...patch };
			return settings;
		},
	);

	assert.equal(existsSync(builtinPath), true);
	await manager.list(false);
	assert.equal(existsSync(builtinPath), false, "residual removed built-in must be purged on list");

	rmSync(fixtureHome, { recursive: true, force: true });
});

test("toggleBuiltIn opt-in writes enabledBuiltInExtensions and never touches removed", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-optin-toggle-"));
	let settings = { removedBuiltInExtensions: [], enabledBuiltInExtensions: [] };
	const { ExtensionManager } = loadExtensionManager({ homeDir: fixtureHome });
	const locator = {
		check: async () => ({ installed: true, version: "0.80.0" }),
		createInvocation: (cmd, args) => ({ command: cmd, args, shell: false }),
		createProcessEnv: () => process.env,
		resolveCommand: () => "pi",
	};
	const manager = new ExtensionManager(
		locator,
		() => ({}),
		() => settings,
		async (patch) => {
			settings = { ...settings, ...patch };
			return settings;
		},
	);

	// 开启：写 opt-in 列表，不动 removed（两套机制互斥）
	await manager.toggleBuiltIn("pi-deck-gui-bridge.ts", true);
	assert.equal(settings.enabledBuiltInExtensions?.length, 1);
	assert.equal(settings.enabledBuiltInExtensions?.[0], "pi-deck-gui-bridge.ts");
	assert.equal(settings.removedBuiltInExtensions?.length, 0);
	// 幂等：重复开启不重复写入
	await manager.toggleBuiltIn("pi-deck-gui-bridge.ts", true);
	assert.equal(settings.enabledBuiltInExtensions?.length, 1);
	// 关闭：移出 opt-in 列表
	await manager.toggleBuiltIn("pi-deck-gui-bridge.ts", false);
	assert.equal(settings.enabledBuiltInExtensions?.length, 0);
	// 非默认关的内置扩展必须走 removed 机制，拒绝用这个开关
	await assert.rejects(() => manager.toggleBuiltIn("pi-deck-todo.ts", true), /默认关闭/);
	// 自愈：曾被「移除」的 opt-in 扩展重新打开开关时，同步清除 removed 标记
	settings = { removedBuiltInExtensions: ["pi-deck-gui-bridge.ts"], enabledBuiltInExtensions: [] };
	await manager.toggleBuiltIn("pi-deck-gui-bridge.ts", true);
	assert.equal(settings.removedBuiltInExtensions?.length, 0);
	assert.equal(settings.enabledBuiltInExtensions?.[0], "pi-deck-gui-bridge.ts");

	rmSync(fixtureHome, { recursive: true, force: true });
});

// 避免 unused import 告警风格（homedir 仅文档用）
void homedir;
