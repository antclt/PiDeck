import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadWslPaths() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/wsl/WslPaths.ts"), sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

function loadPiExtensionFilter() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/pi/piExtensionFilter.ts"), sandbox, { filename: "piExtensionFilter.ts" });
	return sandbox.exports;
}

function createChildProcess() {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => true;
	return child;
}

/**
 * 加载 PiProcess 并把 --version 探测结果固定为 probeVersion。
 * builtInExtensions 用真实实现（appendBuiltInExtensionArgs 是纯函数），
 * 这样降级分支是否真的把内置扩展补回命令行可以被行为断言（#307 第二层回归守卫）。
 */
function loadPiProcess(spawnCalls, probeVersion) {
	const paths = loadWslPaths();
	const extensionFilter = loadPiExtensionFilter();
	class FakeRpcClient extends EventEmitter {
		close() {}
	}
	class FakePiLocator {}
	const sandbox = {
		Buffer,
		console: { log() {}, warn() {}, error() {} },
		exports: {},
		process,
		require: (id) => {
			if (id === "node:child_process") {
				return {
					execFile: (_command, _args, _options, callback) => {
						callback(null, `${probeVersion}\n`, "");
						return new EventEmitter();
					},
					spawn: (command, args, options) => {
						const child = createChildProcess();
						spawnCalls.push({ command, args, options, child });
						return child;
					},
				};
			}
			if (id === "./PiRpcClient") return { PiRpcClient: FakeRpcClient };
			if (id === "./PiLocator") return { PiLocator: FakePiLocator };
			if (id === "../wsl/WslPaths") return paths;
			if (id === "./piExtensionFilter") return extensionFilter;
			if (id === "./piSpawnFailure") return require("../src/main/pi/piSpawnFailure.ts");
			if (id === "../git/gitProcess") return require("../src/main/git/gitProcess.ts");
			if (id === "../extensions/builtInExtensions") {
				return loadTsCommonJs("src/main/extensions/builtInExtensions.ts");
			}
			if (id === "../extensions/extensionVersionGate") {
				return loadTsCommonJs("src/main/extensions/extensionVersionGate.ts");
			}
			if (id === "../logging/sharedLogger") {
				return { getAppLogger: () => null };
			}
			if (id === "../sessions/sessionProxyPolicy") {
				return { applyPiProxyMode: (env) => env };
			}
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/pi/PiProcess.ts"), sandbox, { filename: "PiProcess.ts" });
	return sandbox.exports;
}

function createLocator() {
	return {
		resolveCommand: () => "pi",
		resolveArgCharBudget: () => 26000,
		createInvocation: (_command, args, options = {}) => ({ command: "pi", args: [...args], options }),
		createProcessEnv: () => ({}),
	};
}

const BUILT_IN_PATHS = ["/app/resources/extensions/pi-deck-session-title.ts", "/app/resources/extensions/pi-deck-gui-bridge.ts"];
const USER_EXTENSION = "/home/u/.pi/agent/extensions/my-ext.ts";
const SETTINGS = { piProxyEnabled: false, piProxyUrl: "", piProxyBypass: "" };

function createProcess(PiProcess, extraOptions = {}) {
	// 生产 resolver 返回的白名单列表包含内置扩展（未禁用时），mock 对齐这一行为
	return new PiProcess("/home/u/project", SETTINGS, createLocator(), {
		resolveEnabledExtensionPaths: () => [USER_EXTENSION, ...BUILT_IN_PATHS],
		resolveBuiltInExtensionPaths: () => [...BUILT_IN_PATHS],
		...extraOptions,
	});
}

test("pi 1.0.0 走扩展白名单：--no-extensions + 逐条 -e 注入（含内置扩展）", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, "1.0.0");
	await createProcess(PiProcess).start();

	const args = spawnCalls[0].args;
	assert.ok(args.includes("--no-extensions"), `应有 --no-extensions，实际: ${JSON.stringify(args)}`);
	for (const path of [...BUILT_IN_PATHS, USER_EXTENSION]) {
		assert.ok(args.includes(path), `白名单应注入 ${path}，实际: ${JSON.stringify(args)}`);
	}
});

test("版本过老降级时必须补回内置扩展注入，而不是整条丢弃（#307 第二层）", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, "0.59.0");
	await createProcess(PiProcess).start();

	const args = spawnCalls[0].args;
	assert.ok(!args.includes("--no-extensions"), `降级不应有 --no-extensions，实际: ${JSON.stringify(args)}`);
	assert.ok(!args.includes(USER_EXTENSION), "降级不注入用户扩展白名单（恢复默认发现）");
	for (const path of BUILT_IN_PATHS) {
		// 纯函数返回值曾被丢弃：finalPiArgs 未接收 appendBuiltInExtensionArgs 的结果，
		// 降级后命令行里一个 --extension 都没有（session-title 扩展随之失效）。
		assert.ok(args.includes(path), `降级后内置扩展 ${path} 必须仍在命令行，实际: ${JSON.stringify(args)}`);
	}
});
