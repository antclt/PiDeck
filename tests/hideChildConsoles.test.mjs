import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// ESM `import * as` 命名空间只读，无法在上面做补丁/还原断言；
// 走 CJS exports 对象（与 hideChildConsoles.ts 编译后 require 到的是同一实例）。
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");

const { hiddenConsoleOptions, installHiddenConsolePatch } = loadTsCommonJs(
	"src/main/dsh/hideChildConsoles.ts",
);

test("hiddenConsoleOptions：未指定 windowsHide 时注入 true，已指定则尊重原值", () => {
	// loadTsCommonJs 在独立 vm realm 执行 TS：产物对象原型不同，deepStrictEqual 恒失败，
	// 逐字段断言（行为等价）。
	const injected = hiddenConsoleOptions({ stdio: "pipe" });
	assert.equal(injected.stdio, "pipe");
	assert.equal(injected.windowsHide, true);
	assert.equal(hiddenConsoleOptions({ windowsHide: false }).windowsHide, false);
	assert.equal(hiddenConsoleOptions({ windowsHide: true }).windowsHide, true);
	assert.equal(hiddenConsoleOptions(undefined), undefined);
});

test("installHiddenConsolePatch：非 win32 不安装，win32 安装且可还原", () => {
	const originalSpawn = childProcess.spawn;

	const restoreLinux = installHiddenConsolePatch("linux");
	assert.equal(childProcess.spawn, originalSpawn, "linux 不应安装补丁");
	restoreLinux();

	const restoreWin = installHiddenConsolePatch("win32");
	try {
		assert.notEqual(childProcess.spawn, originalSpawn, "win32 应安装补丁");
	} finally {
		restoreWin();
	}
	assert.equal(childProcess.spawn, originalSpawn, "还原后 spawn 应恢复原引用");
});

test("win32 补丁：spawn 各形态都注入 windowsHide（pwsh 黑窗口治理）", () => {
	const originalSpawn = childProcess.spawn;
	const calls = [];
	// 先放一个捕获参数的间谍，再安装补丁：补丁捕获到的「原函数」就是间谍，
	// 调用链验证 windowsHide 注入而不真正拉起进程。
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {}; // 不真正 spawn
	};
	const restore = installHiddenConsolePatch("win32");
	try {
		// spawn(command, args) → options 缺失时补 { windowsHide: true }
		childProcess.spawn("pwsh", ["-Command", "Get-Location"]);
		// spawn(command, args, options) → 未显式指定时注入
		childProcess.spawn("pwsh", ["-Command", "Get-Location"], { cwd: "C:\\work" });
		// spawn(command, options) → options 在第 2 位
		childProcess.spawn("pwsh", { cwd: "C:\\work" });
		// 显式 windowsHide: false 尊重原值
		childProcess.spawn("pwsh", ["-Command", "x"], { windowsHide: false });
		// spawn(command) → 无 options 时补
		childProcess.spawn("pwsh");
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls.length, 5);
	// options 对象在 vm realm 构造，逐字段断言
	assert.equal(calls[0][2].windowsHide, true);
	assert.equal(calls[1][2].cwd, "C:\\work");
	assert.equal(calls[1][2].windowsHide, true);
	assert.equal(calls[2][1].cwd, "C:\\work");
	assert.equal(calls[2][1].windowsHide, true);
	assert.equal(calls[3][2].windowsHide, false, "显式 windowsHide:false 尊重原值");
	assert.equal(calls[4][1].windowsHide, true);
});

test("win32 补丁：execFile（带 callback）与 exec 也注入 windowsHide", () => {
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	const originalExecFile = childProcess.execFile;
	const originalExec = childProcess.exec;
	childProcess.execFile = (...args) => {
		calls.push(args);
		return {};
	};
	childProcess.exec = (...args) => {
		calls.push(args);
		return {};
	};
	const restore = installHiddenConsolePatch("win32");
	try {
		// execFile(file, args, callback)：options 缺席，插到 callback 前
		childProcess.execFile("taskkill", ["/PID", "123"], () => undefined);
		// execFile(file, args, options)：注入
		childProcess.execFile("pwsh.exe", ["-c", "x"], { encoding: "utf8" });
		// exec(command, options)
		childProcess.exec("where pwsh", { encoding: "utf8" });
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
		childProcess.execFile = originalExecFile;
		childProcess.exec = originalExec;
	}
	const execFileCalls = calls.filter((args) => args[0] === "taskkill" || args[0] === "pwsh.exe");
	const execCalls = calls.filter((args) => args[0] === "where pwsh");
	assert.equal(execFileCalls.length, 2);
	assert.equal(execFileCalls[0][2].windowsHide, true, "callback 形态：options 插入 callback 前");
	assert.equal(typeof execFileCalls[0][3], "function");
	assert.equal(execFileCalls[1][2].encoding, "utf8");
	assert.equal(execFileCalls[1][2].windowsHide, true);
	assert.equal(execCalls.length, 1);
	assert.equal(execCalls[0][1].encoding, "utf8");
	assert.equal(execCalls[0][1].windowsHide, true);
});
