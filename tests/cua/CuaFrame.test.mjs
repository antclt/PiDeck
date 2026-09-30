import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const CuaFrame = loadTsCommonJs("src/main/cua/CuaFrame.ts");

test("default capture options match probe5 budget", () => {
	// 1280 long edge / quality 75 keeps 2560x1440 frames under ~190KB base64.
	assert.strictEqual(CuaFrame.DEFAULT_MAX_LONG_EDGE, 1280);
	assert.strictEqual(CuaFrame.DEFAULT_QUALITY, 75);
});
