import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const CuaWin32 = loadTsCommonJs("src/main/cua/CuaWin32.ts");

test("normalizeAbsoluteCoordinate maps primary screen corners", () => {
	const sw = 2560;
	const sh = 1440;

	assert.deepStrictEqual(JSON.parse(JSON.stringify(CuaWin32.normalizeAbsoluteCoordinate(0, 0, sw, sh))), { x: 0, y: 0 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(CuaWin32.normalizeAbsoluteCoordinate(sw - 1, sh - 1, sw, sh))), { x: 65535, y: 65535 });

	const center = CuaWin32.normalizeAbsoluteCoordinate(1280, 720, sw, sh);
	assert.strictEqual(center.x, Math.round((1280 * 65535) / (sw - 1)));
	assert.strictEqual(center.y, Math.round((720 * 65535) / (sh - 1)));
});

test("normalizeAbsoluteCoordinate clamps out-of-bounds coordinates", () => {
	assert.deepStrictEqual(JSON.parse(JSON.stringify(CuaWin32.normalizeAbsoluteCoordinate(-100, -100, 1920, 1080))), { x: 0, y: 0 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(CuaWin32.normalizeAbsoluteCoordinate(9999, 9999, 1920, 1080))), { x: 65535, y: 65535 });
});

test("normalizeAbsoluteCoordinate rejects invalid dimensions", () => {
	assert.throws(() => CuaWin32.normalizeAbsoluteCoordinate(0, 0, 0, 1080), /Invalid screen dimensions/);
	assert.throws(() => CuaWin32.normalizeAbsoluteCoordinate(0, 0, 1920, 0), /Invalid screen dimensions/);
});

test("buildMouseInput produces absolute move flags", () => {
	const input = CuaWin32.buildMouseInput(1000, 2000, 0x8001);
	assert.strictEqual(input.type, 0);
	assert.strictEqual(input.mi_dx, 1000);
	assert.strictEqual(input.mi_dy, 2000);
	assert.strictEqual(input.mi_dwFlags, 0x8001);
	assert.strictEqual(input.ki_wVk, 0);
});

test("buildKeyboardInput produces unicode down input", () => {
	const input = CuaWin32.buildKeyboardInput(0, 65, 0x0004);
	assert.strictEqual(input.type, 1);
	assert.strictEqual(input.ki_wScan, 65);
	assert.strictEqual(input.ki_dwFlags, 0x0004);
	assert.strictEqual(input.mi_dx, 0);
});

/**
 * 与真实 koffi 同契约的替身：`LibraryHandle` 的方法是原生方法，receiver 必须是
 * 句柄对象本身（`proxy.func()` 抛 `TypeError: Illegal invocation`）。
 * 上面那组用例走真实 koffi，只有 Windows 才会命中这条路径；这里固定
 * `platform=win32` 让任意平台都能复现同一契约。
 */
function createReceiverSensitiveKoffi() {
	const state = { dlls: [], signatures: [], sizeofSpecs: [] };
	const load = (dllName) => {
		state.dlls.push(dllName);
		const lib = {
			dll: dllName,
			func(signature) {
				if (this !== lib) throw new TypeError("Illegal invocation");
				state.signatures.push(signature);
				return () => 0;
			},
		};
		return lib;
	};
	return {
		state,
		load,
		struct: (name) => ({ kind: "struct", name }),
		proto: (name) => ({ kind: "proto", name }),
		sizeof: (spec) => {
			state.sizeofSpecs.push(spec);
			return 40;
		},
		address: () => 0,
	};
}

test("module import binds koffi LibraryHandle methods to the handle", () => {
	// 2026-09-30 打包版启动即崩：顶层 `user32.func(...)` 经 Proxy 调用，this 被顶替
	// 成代理对象 → koffi 抛 Illegal invocation → 主进程入口模块加载失败（弹框把行号
	// 截成 `app.asar:33`，看着像 `require("koffi")` 炸了）。句柄方法必须 bind 回去。
	const koffi = createReceiverSensitiveKoffi();
	const mod = loadTsCommonJs("src/main/cua/CuaWin32.ts", {
		stubs: { koffi },
		globals: { process: { platform: "win32" } },
	});

	assert.ok(koffi.state.dlls.includes("user32.dll"));
	assert.ok(koffi.state.dlls.includes("kernel32.dll"));
	assert.ok(koffi.state.signatures.some((signature) => signature.includes("GetSystemMetrics")));

	// 运行期经同一代理的调用同样要能以句柄为 receiver
	assert.strictEqual(mod.sendInputs([mod.buildMouseInput(1, 1, 0)]), 0);
	assert.strictEqual(koffi.state.sizeofSpecs.length, 1);
});
