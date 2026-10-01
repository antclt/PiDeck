import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { builtinToggleIn, resolveBuiltinToggleStates, builtinSpecifiersToRestore } = loadTsCommonJs("src/main/extensions/builtInExtensionToggles.ts");
const { PI_BUILTIN_EXTENSIONS } = loadTsCommonJs("src/shared/types/piResources.ts");

function setup() {
	const home = mkdtempSync(join(tmpdir(), "pideck-builtin-"));
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	return { home, agentDir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const writeGlobal = (agentDir, settings) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings), "utf8");

test("builtin toggle detection reads exact entries and ignores broader globs", () => {
	assert.equal(builtinToggleIn([], "mcp"), "unset");
	assert.equal(builtinToggleIn(["!builtin:*"], "mcp"), "unset");
	assert.equal(builtinToggleIn(["-builtin:mcp"], "mcp"), "disabled");
	assert.equal(builtinToggleIn(["+builtin:mcp"], "mcp"), "enabled");
	// 后写的精确条目生效
	assert.equal(builtinToggleIn(["+builtin:mcp", "-builtin:mcp"], "mcp"), "disabled");
	assert.equal(builtinToggleIn(["-builtin:mcp", "+builtin:mcp"], "mcp"), "enabled");
	// 不误伤其它内置扩展
	assert.equal(builtinToggleIn(["-builtin:mcp"], "codemode"), "unset");
});

test("builtinSpecifiersToRestore returns all four when the user disabled nothing", () => {
	const { home, agentDir, cleanup } = setup();
	try {
		writeGlobal(agentDir, { defaultTools: ["read"] });
		const specifiers = builtinSpecifiersToRestore({ agentHomeDir: home });
		assert.deepEqual(
			[...specifiers],
			[...PI_BUILTIN_EXTENSIONS].map((name) => `builtin:${name}`),
		);
	} finally {
		cleanup();
	}
});

test("builtinSpecifiersToRestore respects an explicit native disable", () => {
	const { home, agentDir, cleanup } = setup();
	try {
		writeGlobal(agentDir, { extensions: ["-builtin:llama.cpp"] });
		const specifiers = builtinSpecifiersToRestore({ agentHomeDir: home });
		assert.equal(specifiers.includes("builtin:llama.cpp"), false);
		assert.equal(specifiers.includes("builtin:mcp"), true);
	} finally {
		cleanup();
	}
});

test("diagnostic mode loads none of the built-ins", () => {
	const { home, agentDir, cleanup } = setup();
	try {
		writeGlobal(agentDir, { extensions: [] });
		assert.deepEqual([...builtinSpecifiersToRestore({ agentHomeDir: home, loadNone: true })], []);
	} finally {
		cleanup();
	}
});

test("project-level +builtin overrides a global disable, and untrusted projects are ignored", () => {
	const { home, agentDir, cleanup } = setup();
	try {
		const project = join(home, "project");
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeGlobal(agentDir, { extensions: ["-builtin:mcp"] });
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ extensions: ["+builtin:mcp"] }), "utf8");
		// 已信任项目：项目 +builtin:mcp 覆盖全局停用
		const states = resolveBuiltinToggleStates({ agentHomeDir: home, cwd: project, includeProjectResources: true });
		assert.equal(states.mcp, "enabled");
		assert.equal(builtinSpecifiersToRestore({ agentHomeDir: home, cwd: project, includeProjectResources: true }).includes("builtin:mcp"), true);
		// 未信任：项目层不参与，沿用全局停用
		const untrusted = resolveBuiltinToggleStates({ agentHomeDir: home, cwd: project, includeProjectResources: false });
		assert.equal(untrusted.mcp, "disabled");
		assert.equal(builtinSpecifiersToRestore({ agentHomeDir: home, cwd: project, includeProjectResources: false }).includes("builtin:mcp"), false);
	} finally {
		cleanup();
	}
});

test("missing or broken settings files fall back to enabled without throwing", () => {
	const { home, agentDir, cleanup } = setup();
	try {
		// 文件不存在
		assert.equal(resolveBuiltinToggleStates({ agentHomeDir: home }).mcp, "unset");
		writeFileSync(join(agentDir, "settings.json"), "{ broken", "utf8");
		const states = resolveBuiltinToggleStates({ agentHomeDir: home });
		for (const name of PI_BUILTIN_EXTENSIONS) assert.equal(states[name], "unset");
		assert.equal(builtinSpecifiersToRestore({ agentHomeDir: home }).length, PI_BUILTIN_EXTENSIONS.length);
	} finally {
		cleanup();
	}
});
