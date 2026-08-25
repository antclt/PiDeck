import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// configDirtyMarks.ts 仅含类型导入（编译后擦除），无运行时依赖，直接 transpile 加载。
const source = readFileSync("src/renderer/src/config/configDirtyMarks.ts", "utf8");
const { outputText } = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const module = { exports: {} };
const sandbox = { module, exports: module.exports, process, setTimeout };
vm.runInNewContext(outputText, sandbox, { filename: "configDirtyMarks.ts" });
const { dirtyKeysClearedByReload, ALL_CONFIG_DIRTY_KEYS } = module.exports;

// ── dirtyKeysClearedByReload：loadConfig 重载后应清除的脏标记 ──

test("重载 models 清除自身与 raw（rawContent 被重写），不动其他 tab", () => {
	assert.deepEqual(new Set(dirtyKeysClearedByReload("models")), new Set(["config:models", "config:raw"]));
});

test("重载 settings 同时清除被顺带重载的 models/auth 脏标记（假脏标记根因）", () => {
	assert.deepEqual(
		new Set(dirtyKeysClearedByReload("settings")),
		new Set(["config:settings", "config:raw", "config:models", "config:auth"]),
	);
});

test("重载 auth/trust/mcp 清除自身与 raw", () => {
	assert.deepEqual(new Set(dirtyKeysClearedByReload("auth")), new Set(["config:auth", "config:raw"]));
	assert.deepEqual(new Set(dirtyKeysClearedByReload("trust")), new Set(["config:trust", "config:raw"]));
	assert.deepEqual(new Set(dirtyKeysClearedByReload("mcp")), new Set(["config:mcp", "config:raw"]));
});

test("重载 raw 只清除自身（去重，不产生重复 key）", () => {
	assert.deepEqual(Array.from(dirtyKeysClearedByReload("raw")), ["config:raw"]);
});

test("ALL_CONFIG_DIRTY_KEYS 覆盖全部 config 组文件键（不含 skills/prompts）", () => {
	// vm 沙箱中的 Array 原型与测试域不同，展开成原生数组后再比较
	assert.deepEqual(Array.from(ALL_CONFIG_DIRTY_KEYS), [
		"config:models",
		"config:auth",
		"config:settings",
		"config:trust",
		"config:mcp",
		"config:raw",
	]);
});

// ── 装配契约：ConfigModal 已接入核算规则 ──

test("ConfigModal 的 loadConfig 与 handleImport 使用统一核算规则", () => {
	const source = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	// 脏草稿保留：被重载覆盖的 key 若仍是脏的（preserved）则跳过 setState + clearDirty，
	// 否则切 tab 会丢草稿；保存/导入路径 force:true 时才强制对齐磁盘。
	assert.match(source, /if \(!preserved\.has\(key\)\) clearDirty\(key\)/);
	assert.match(source, /dirtyKeysPreservedOnReload\(target, dirtyTabsRef\.current\)/);
	assert.match(source, /loadConfig\("models", \{ force: true \}\)/);
	assert.match(source, /for \(const key of ALL_CONFIG_DIRTY_KEYS\) clearDirty\(key\)/);
	assert.match(source, /import \{ ALL_CONFIG_DIRTY_KEYS, dirtyKeysClearedByReload, dirtyKeysPreservedOnReload \} from "\.\/config\/configDirtyMarks"/);
	// 旧的仅清当前 tab 的写法必须移除
	assert.doesNotMatch(source, /clearDirty\(target === "raw" \? "config:raw" : `config:\$\{target\}`\)/);
});
