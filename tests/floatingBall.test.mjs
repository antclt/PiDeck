import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const require = createRequire(import.meta.url);
const floatingSandbox = createTsSandbox({
	stubs: {
		"@electron-toolkit/utils": { is: { dev: true } },
		electron: { BrowserWindow: class {}, ipcMain: { handle() {}, removeHandler() {} }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, app: { getPath: () => "/tmp" } },
	},
});

function resolveUnstubbedRequire(specifier) {
	if (!specifier.startsWith(".")) return require(specifier);
	const target = resolve("src/main/floating", /\.(ts|tsx|js)$/.test(specifier) ? specifier : `${specifier}.ts`);
	return floatingSandbox(target);
}

function loadModule(file, mockDeps = {}) {
	const source = readFileSync(`src/main/floating/${file}`, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const module = { exports: {} };
	const context = vm.createContext({
		...floatingSandbox,
		module,
		exports: module.exports,
		require: (id) => {
			if (id === "@electron-toolkit/utils") return { is: { dev: true } };
			if (id === "electron") return mockDeps.electron ?? {};
			if (Object.hasOwn(mockDeps, id)) return mockDeps[id];
			return resolveUnstubbedRequire(id);
		},
	});
	vm.runInContext(outputText, context);
	return module.exports;
}

test("FloatingController: enabled=false 时不显示", async () => {
	const { FloatingController } = loadModule("FloatingController.ts", {
		electron: { BrowserWindow: class {}, ipcMain: { handle() {}, removeHandler() {} }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, app: { getPath: () => "/tmp" } },
	});
	const settings = { get: () => ({ floatingBallEnabled: false }) };
	const agentManager = { addStateListener: () => () => undefined, list: () => [] };
	const ctrl = new FloatingController({ settingsStore: settings, agentManager, getMainWindow: () => null, onExpandMini: async () => {}, onExpandCompact: async () => {}, onShowMainWindow: () => {} });
	await ctrl.show();
	assert.equal(ctrl.isActive(), false);
});

test("FloatingController: getState 返回默认值", async () => {
	const { FloatingController } = loadModule("FloatingController.ts", {
		electron: { BrowserWindow: class {}, ipcMain: { handle() {}, removeHandler() {} }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, app: { getPath: () => "/tmp" } },
	});
	const settings = { get: () => ({ floatingBallEnabled: true }) };
	const agentManager = { addStateListener: () => () => undefined, list: () => [] };
	const ctrl = new FloatingController({ settingsStore: settings, agentManager, getMainWindow: () => null, onExpandMini: async () => {}, onExpandCompact: async () => {}, onShowMainWindow: () => {} });
	const state = ctrl.getState();
	assert.equal(state.visible, false);
	assert.equal(state.expandTarget, "mini");
	assert.equal(state.runningCount, 0);
	assert.equal(state.activeCount, 0);
});

test("MiniOverlayWindow 尺寸常量", async () => {
	const { MINI_OVERLAY_W, MINI_OVERLAY_H, MiniOverlayWindow } = loadModule("MiniOverlayWindow.ts", {
		electron: { BrowserWindow: class {}, ipcMain: { handle() {}, removeHandler() {} }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, app: { getPath: () => "/tmp" } },
	});
	assert.ok(typeof MiniOverlayWindow === "function");
	assert.equal(MINI_OVERLAY_W, 480);
	assert.equal(MINI_OVERLAY_H, 640);
});
