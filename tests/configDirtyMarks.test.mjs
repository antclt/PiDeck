import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// configDirtyMarks.ts 现引入 deepEqual（运行时依赖），用 loadTsCommonJs 走完整依赖图加载。
const {
	dirtyKeysClearedByReload,
	ALL_CONFIG_DIRTY_KEYS,
	reconcileConfigDirty,
} = loadTsCommonJs("src/renderer/src/config/configDirtyMarks.ts");

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
	assert.deepEqual(Array.from(ALL_CONFIG_DIRTY_KEYS), [
		"config:models",
		"config:auth",
		"config:settings",
		"config:trust",
		"config:mcp",
		"config:raw",
	]);
});

// ── reconcileConfigDirty：改回原值自动摘掉脏标记 ──
// 说明：普通对象字面量跨 vm realm 会被 deepEqual 的 isPlainObject 判为非普通对象
// （见 deepEqual.test.mjs 说明），这里用数组/原始值（Array.isArray 跨 realm 可靠）验证
// 「改回原值自动摘掉脏标记」的核心语义；对象分支由 deepEqual.test.mjs 自测覆盖。

test("改回原值后脏标记自动消失（假脏标记根因）", () => {
	const keys = new Set(["config:models"]);
	const baseline = ["m1", "m2"];
	reconcileConfigDirty(keys, "config:models", ["m1", "m2"], baseline);
	assert.deepEqual(Array.from(keys), []);
});

test("真实差异加入脏标记；再改回又清除（幂等）", () => {
	const baseline = ["m1", "m2"];
	const keys = new Set();
	// 修改
	reconcileConfigDirty(keys, "config:models", ["m1", "m3"], baseline);
	assert.deepEqual(Array.from(keys), ["config:models"]);
	// 改回原值
	reconcileConfigDirty(keys, "config:models", ["m1", "m2"], baseline);
	assert.deepEqual(Array.from(keys), []);
});

test("嵌套数组按结构比较：内容相同无差异，顺序变化算差异", () => {
	const keys = new Set();
	const baseline = [[1, 2], [3, 4]];
	// 同内容：无差异
	reconcileConfigDirty(keys, "config:settings", [[1, 2], [3, 4]], baseline);
	assert.deepEqual(Array.from(keys), []);
	// 数组元素顺序变化：真实差异
	reconcileConfigDirty(keys, "config:settings", [[3, 4], [1, 2]], baseline);
	assert.deepEqual(Array.from(keys), ["config:settings"]);
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
	assert.match(source, /import \{ ALL_CONFIG_DIRTY_KEYS, dirtyKeysClearedByReload, dirtyKeysPreservedOnReload, reconcileConfigDirty \} from "\.\/config\/configDirtyMarks"/);
	// reconcile 已收敛到 configDirtyMarks（不再在 ConfigModal 内重复定义）
	assert.match(source, /reconcileConfigDirty\(next, "config:models", modelsData, baselineModelsRef\.current\)/);
	// 旧的仅清当前 tab 的写法必须移除
	assert.doesNotMatch(source, /clearDirty\(target === "raw" \? "config:raw" : `config:\$\{target\}`\)/);
});
