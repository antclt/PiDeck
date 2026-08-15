import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveDshHomeDir } = loadTsCommonJs("src/main/dsh/DshHost.ts");

test("resolveDshHomeDir: 设置覆盖优先于 ~/.dsh", () => {
	const result = resolveDshHomeDir("D:/custom-dsh", "C:/userData", true);
	assert.equal(result, "D:/custom-dsh");
});

test("resolveDshHomeDir: 覆盖为空白时回退 ~/.dsh", () => {
	const result = resolveDshHomeDir("   ", "C:/userData", true);
	assert.ok(result.endsWith(".dsh"), `应为 ~/.dsh，实际: ${result}`);
});

test("resolveDshHomeDir: 无覆盖且 ~/.dsh 存在 → 直接用 ~/.dsh（与 dsh CLI 共用）", () => {
	const result = resolveDshHomeDir(undefined, "C:/userData", true);
	assert.ok(result.endsWith(".dsh"), `应为 ~/.dsh，实际: ${result}`);
	assert.ok(!result.includes("userData"), "不得落到应用私有目录");
});

test("resolveDshHomeDir: 无覆盖且 ~/.dsh 不存在 → 应用私有 dsh-home（全新用户兜底）", () => {
	const result = resolveDshHomeDir(undefined, "C:/userData", false);
	assert.ok(result.endsWith("dsh-home"), `应为 userData/dsh-home，实际: ${result}`);
});
