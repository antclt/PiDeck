import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { deepEqual, deepClone } = loadTsCommonJs("src/renderer/src/utils/deepEqual.ts");

// 说明：loadTsCommonJs 在 vm 里编译，普通对象字面量跨 realm 会被 isPlainObject
// 判为「非普通对象」。这里用原始值 + 数组（Array.isArray 跨 realm 可靠）覆盖核心行为；
// 普通对象分支与数组走同一递归逻辑，生产环境（同 realm）由设置页/配置页脏检测直接消费。
test("deepEqual 原始值：数值相等语义，NaN/0/-0 边界正确，类型不同不等", () => {
	assert.equal(deepEqual(1, 1), true);
	assert.equal(deepEqual("a", "a"), true);
	assert.equal(deepEqual(NaN, NaN), true);
	assert.equal(deepEqual(undefined, undefined), true);
	assert.equal(deepEqual(1, "1"), false);
	assert.equal(deepEqual(null, undefined), false);
	assert.equal(deepEqual(0, -0), true); // 数值相等语义：0 与 -0 视为相等
});

test("deepEqual 数组：逐项递归，长度/元素差异能区分", () => {
	assert.equal(deepEqual([1, 2], [1, 2]), true);
	assert.equal(deepEqual([1, 2], [1, 3]), false);
	assert.equal(deepEqual([1, 2], [1, 2, 3]), false);
	assert.equal(deepEqual([1, [2, 3]], [1, [2, 3]]), true);
	assert.equal(deepEqual([1, [2, 3]], [1, [2, 4]]), false);
	assert.equal(deepEqual([], []), true);
});

test("deepClone 深拷贝数组与嵌套结构，改动副本不影响原值", () => {
	const source = [1, [2, 3]];
	const cloned = deepClone(source);
	assert.deepEqual(cloned, source);
	cloned[1][0] = 99;
	assert.equal(source[1][0], 2);
	// 原始值直接返回
	assert.equal(deepClone(42), 42);
	assert.equal(deepClone("x"), "x");
});
