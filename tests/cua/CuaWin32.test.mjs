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
