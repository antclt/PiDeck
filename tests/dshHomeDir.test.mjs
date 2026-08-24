import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveDshHomeDir } = loadTsCommonJs("src/main/dsh/DshHost.ts");

test("resolveDshHomeDir: 设置覆盖优先于 ~/.dsh", () => {
	const result = resolveDshHomeDir("D:/custom-dsh", "C:/userData");
	assert.equal(result, "D:/custom-dsh");
});

test("resolveDshHomeDir: 覆盖为空白时回退 ~/.dsh", () => {
	const result = resolveDshHomeDir("   ", "C:/userData");
	assert.ok(result.endsWith(".dsh"), `应为 ~/.dsh，实际: ${result}`);
});

test("resolveDshHomeDir: 无覆盖 → 统一用 ~/.dsh（新用户也建在 ~/.dsh，不另起炉灶）", () => {
	const result = resolveDshHomeDir(undefined, "C:/userData");
	assert.ok(result.endsWith(".dsh"), `应为 ~/.dsh，实际: ${result}`);
	assert.ok(!result.includes("userData"), "不得落到应用私有目录");
});
