import assert from "node:assert/strict";
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

/**
 * 沙箱加载 PiProcess：mock spawn 以捕获传入子进程的环境变量，mock locator 让 resolveCommand
 * 返回 "wsl://" 触发 WSL 分支，其余依赖（fs/extensions/logging）给最小桩，避免触碰真实文件系统。
 */
function loadPiProcess() {
	const wslPaths = loadWslPaths();
	/** spawn 收到的 env；mockSpawn 被调用时写入 */
	let captured = null;
	const mockSpawn = (_command, _args, opts) => {
		captured = { env: opts?.env ?? null };
		// 返回一个最小 ChildProcess 形状：PiProcess 后续会 new PiRpcClient(proc.stdin/stdout)
		// 并注册 stderr/error/exit 监听，全部用 stream + noop 满足。
		return {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			on() {},
			kill() {},
			pid: 12345,
		};
	};
	class MockRpcClient {
		on() { return this; }
		close() {}
		request() { return Promise.resolve({ success: true, data: {} }); }
	}
	// locator 决定 command 是否进入 WSL 分支；createProcessEnv 给空 env 让注入逻辑可观测
	const mockLocator = {
		resolveCommand: () => "wsl://pi",
		createInvocation: (command, args) => ({
			command,
			args,
			shell: false,
			pathPrefix: "",
			wsl: true,
			windowsVerbatimArguments: false,
		}),
		createProcessEnv: () => ({}),
	};
	const sandbox = {
		Buffer,
		console: { log() {}, warn() {}, error() {} },
		exports: {},
		process: { ...process, platform: "win32" },
		require: (id) => {
			if (id === "node:child_process") {
				return {
					spawn: mockSpawn,
					// ensureVersionCheck 异步探针：立即回调完成，避免 pending promise 残留
					execFile: (_cmd, _args, _opts, cb) => {
						if (typeof cb === "function") cb(null, "1.2.3\n");
					},
				};
			}
			if (id === "node:events") return require("node:events");
			if (id === "node:os") return { homedir: () => "C:\\Users\\tester" };
			if (id === "node:path") return require("node:path").win32;
			if (id === "./PiRpcClient") return { PiRpcClient: MockRpcClient };
			if (id === "./PiLocator") return { PiLocator: class {} };
			if (id === "./piExtensionFilter") {
				return { parkBlockedExtensionsInDir: () => [], unparkBlockedExtensions: () => {} };
			}
			if (id === "../wsl/WslPaths") return wslPaths;
			if (id === "../extensions/builtInExtensions") {
				return { appendBuiltInExtensionArgs: (args) => args };
			}
			if (id === "../logging/sharedLogger") return { getAppLogger: () => undefined };
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/pi/PiProcess.ts"), sandbox, { filename: "PiProcess.ts" });
	return { PiProcess: sandbox.exports.PiProcess, mockLocator, getCaptured: () => captured };
}

test("WSL 模式下 PIDECK_SESSION_ID（UUID 身份 key）原样注入，不经 Linux 路径转换", async () => {
	// 回归：临时会话 deckSessionId 是新生成的 UUID（无 sessionPath 兜底），
	// 旧代码把它当 Windows 路径喂给 toWslLinuxPath——UUID 既非 UNC/盘符/绝对 Linux 路径，
	// WslPaths 必抛 INVALID_WSL_PATH，导致 WSL 下临时会话起不来（spawn 之前就崩）。
	// 但 PIDECK_SESSION_ID 对扩展只是 sessionLevels 字典查表 key（不 fs 打开），
	// 任何模式都应原样注入；只有 securitySnapshotPath（真实 Windows 路径，扩展要 fs 读）才需要转换。
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const uuid = "550e8400-e29b-41d4-a716-446655440000";
	const snapshotPath = "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json";

	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root", piRpcNoExtensions: true, piRpcOffline: true },
		mockLocator,
		{ securitySnapshotPath: snapshotPath, securitySessionId: uuid },
	);

	// noSession=true：临时会话不传 sessionPath，securitySessionId 仅剩 UUID（最易触发 bug 的路径）
	await proc.start(undefined, undefined, true);

	const captured = getCaptured();
	assert.ok(captured?.env, "spawn 应被调用并捕获到 env");
	// 身份 key 原样透传：扩展按它命中 sessionLevels 覆盖
	assert.equal(captured.env.PIDECK_SESSION_ID, uuid);
	// snapshotPath 是真实 Windows 路径（扩展需 fs 打开），WSL 下仍要转成 /mnt/c/...
	assert.equal(
		captured.env.PIDECK_SECURITY_CONFIG,
		"/mnt/c/Users/tester/AppData/Roaming/PiDeck-dev/security-policy.json",
	);
});
