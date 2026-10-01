import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	projectResourceEnabled,
	setResourceRuleEnabled,
	stripExactResourceRules,
	hasExactResourceEntry,
	resolveBuiltinExtensionState,
	setBuiltinExtensionEnabled,
	disablePackageFilters,
	isPackageFullyDisabled,
	disablePackageDeltaFilters,
	enablePackageDeltaFilters,
	isPackageDeltaFullyDisabled,
	PACKAGE_DELTA_DISABLE_PATTERNS,
	normalizeResourceValue,
} = loadTsCommonJs("src/main/config/piResourceRules.ts");

test("setResourceRuleEnabled adds exact +/- without touching user globs", () => {
	// 用户写了广域排除：PiDeck 启用时必须补精确 +，否则资源仍然不加载
	const entries = ["!*", "/home/me/keep.ts", "+/home/me/other.ts"];
	const on = setResourceRuleEnabled({ entries, value: "/home/me/keep.ts", enabled: true, platform: "linux" });
	assert.deepEqual([...on], ["!*", "/home/me/keep.ts", "+/home/me/other.ts", "+/home/me/keep.ts"]);
	// 停用：显式路径保留（删了再也匹配不到），加精确 -
	const off = setResourceRuleEnabled({ entries: on, value: "/home/me/keep.ts", enabled: false, platform: "linux" });
	assert.deepEqual([...off], ["!*", "/home/me/keep.ts", "+/home/me/other.ts", "-/home/me/keep.ts"]);
	// 再启用：不残留反向 token
	assert.deepEqual([...setResourceRuleEnabled({ entries: off, value: "/home/me/keep.ts", enabled: true, platform: "linux" })], ["!*", "/home/me/keep.ts", "+/home/me/other.ts", "+/home/me/keep.ts"]);
});

test("exact matching is case/separator tolerant on win32 only", () => {
	assert.equal(normalizeResourceValue("C:\\Users\\A\\x.ts", "win32"), "c:/users/a/x.ts");
	assert.equal(normalizeResourceValue("/home/A/x.ts", "linux"), "/home/A/x.ts");
	assert.equal(hasExactResourceEntry(["-c:\\users\\a\\x.ts"], "C:/Users/A/x.ts", "win32"), true);
	assert.equal(hasExactResourceEntry(["-c:\\users\\a\\x.ts"], "C:/Users/A/x.ts", "linux"), false);
	// 更宽的 glob 不算精确条目
	assert.equal(hasExactResourceEntry(["!/*.ts"], "/a/x.ts", "linux"), false);
});

test("stripExactResourceRules only removes rules pointing at the same value", () => {
	assert.deepEqual([...stripExactResourceRules(["-/a/x.ts", "-/a/y.ts", "!/a/*"], "/a/x.ts", "linux")], ["-/a/y.ts", "!/a/*"]);
});

test("builtin extension toggles use +builtin:/−builtin: specifiers", () => {
	const off = setBuiltinExtensionEnabled({ entries: ["!builtin:*"], name: "mcp", enabled: false });
	assert.deepEqual([...off], ["!builtin:*", "-builtin:mcp"]);
	const on = setBuiltinExtensionEnabled({ entries: off, name: "mcp", enabled: true });
	assert.deepEqual([...on], ["!builtin:*", "+builtin:mcp"]);
});

test("resolveBuiltinExtensionState reflects layer and inherited exact rules", () => {
	const state = resolveBuiltinExtensionState({ entries: ["-builtin:codemode"], name: "codemode", platform: "linux" });
	assert.equal(state.enabled, false);
	assert.equal(state.explicitInLayer, true);
	// 项目层 +builtin:mcp 覆盖全局 -builtin:mcp
	const project = resolveBuiltinExtensionState({ entries: ["+builtin:mcp"], name: "mcp", platform: "linux" });
	assert.equal(project.enabled, true);
	// 未显式写过 → 默认启用、继承
	const inherit = resolveBuiltinExtensionState({ entries: [], name: "llama.cpp", platform: "linux" });
	assert.equal(inherit.enabled, true);
	assert.equal(inherit.explicitInLayer, false);
});

test("package whole-disable writes empty filters for all four kinds", () => {
	const entry = { source: "npm:demo", version: "1.2.3", futureField: { keep: true } };
	const disabled = disablePackageFilters(entry);
	assert.equal(disabled.source, "npm:demo");
	assert.equal(disabled.version, "1.2.3");
	assert.deepEqual(JSON.parse(JSON.stringify(disabled.futureField)), { keep: true });
	for (const kind of ["extensions", "skills", "prompts", "themes"]) assert.deepEqual([...disabled[kind]], []);
	assert.equal(isPackageFullyDisabled(disabled), true);
	// 部分过滤不算整包停用
	assert.equal(isPackageFullyDisabled({ source: "npm:demo", extensions: [] }), false);
});

test("project package delta disable/enable use native pattern sets, not empty arrays", () => {
	const delta = { source: "npm:demo", autoload: false };
	const disabled = disablePackageDeltaFilters(delta);
	assert.deepEqual([...disabled.extensions], [...PACKAGE_DELTA_DISABLE_PATTERNS]);
	assert.equal(disabled.autoload, false);
	assert.equal(isPackageDeltaFullyDisabled(disabled), true);
	const enabled = enablePackageDeltaFilters(delta);
	assert.deepEqual([...enabled.skills], ["*", ".*"]);
	assert.equal(isPackageDeltaFullyDisabled(enabled), false);
	// 空的 delta 数组是「没有覆盖」，绝不能被当成停用
	assert.equal(isPackageDeltaFullyDisabled({ source: "npm:demo", autoload: false, extensions: [] }), false);
});

test("projectResourceEnabled reflects native include/exclude ordering", () => {
	// 无规则 → 启用
	assert.equal(projectResourceEnabled({ entries: [], value: "/a/x/SKILL.md", baseDir: "/a/x" }), true);
	// 精确 - 停用
	assert.equal(projectResourceEnabled({ entries: ["-/a/x/SKILL.md"], value: "/a/x/SKILL.md", baseDir: "/a/x" }), false);
	// + 覆盖更宽的 ! 排除
	assert.equal(projectResourceEnabled({ entries: ["!*.md", "+/a/x/SKILL.md"], value: "/a/x/SKILL.md", baseDir: "/a/x" }), true);
	// - 又覆盖 +
	assert.equal(projectResourceEnabled({ entries: ["!*.md", "+/a/x/SKILL.md", "-/a/x/SKILL.md"], value: "/a/x/SKILL.md", baseDir: "/a/x" }), false);
	// 目录名匹配（技能的父目录形态）
	assert.equal(projectResourceEnabled({ entries: ["-x"], value: "/a/x/SKILL.md", baseDir: "/a/x" }), false);
});
