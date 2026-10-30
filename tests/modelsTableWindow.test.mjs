import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { MODEL_TABLE_INITIAL_VISIBLE_ROWS, MODEL_TABLE_LOAD_MORE_STEP, resolveModelTableVisibleRowCount } = loadTsCommonJs("src/renderer/src/config/modelsUtils.ts");

test("模型表默认窗口是前缀 100 行，继续加载按步长递增", () => {
	assert.equal(MODEL_TABLE_INITIAL_VISIBLE_ROWS, 100);
	assert.equal(MODEL_TABLE_LOAD_MORE_STEP, 100);
	// 无聚焦目标（focusIndex = -1）：窗口即当前 state 值
	assert.equal(resolveModelTableVisibleRowCount(300, MODEL_TABLE_INITIAL_VISIBLE_ROWS, -1), 100);
	assert.equal(resolveModelTableVisibleRowCount(300, 200, -1), 200);
	// 小列表不引入窗口
	assert.equal(resolveModelTableVisibleRowCount(30, MODEL_TABLE_INITIAL_VISIBLE_ROWS, -1), 30);
});

test("聚焦目标行落在窗口外时扩窗到该行（新增行在表尾）", () => {
	// 手动新增：151 个模型中新增行在 index 150，窗口必须扩到看得见它
	assert.equal(resolveModelTableVisibleRowCount(151, 100, 150), 151);
	// 聚焦目标在窗口内时窗口不变
	assert.equal(resolveModelTableVisibleRowCount(151, 100, 42), 100);
});

test("窗口结果始终夹在 [0, total] 内，模型变少时不越界", () => {
	assert.equal(resolveModelTableVisibleRowCount(50, 100, -1), 50);
	assert.equal(resolveModelTableVisibleRowCount(0, 100, -1), 0);
	// 聚焦目标超过总数（聚焦键滞后于删除）也不越界
	assert.equal(resolveModelTableVisibleRowCount(50, 100, 120), 50);
});
