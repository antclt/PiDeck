/**
 * ACP configOptions 下拉的展示模型：当前值命中/未命中枚举时的 value、label 与项列表。
 * 背景：Radix Select 只在 value 命中某个 item 时才高亮并滚动到该项；agent 的
 * currentValue 可能是完整模型 id 而枚举只有别名，此前会显示原始 id 且下拉停在第 1 项。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveAcpConfigSelect, flattenAcpConfigOptions, isRenderableAcpConfigEntry } = loadTsCommonJs("src/renderer/src/components/session/acpConfigSelect.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const VALUES = [
	{ value: "sonnet", name: "Sonnet" },
	{ value: "opus", name: "Opus" },
];

test("当前值命中枚举：label 用显示名，枚举原样返回", () => {
	const model = resolveAcpConfigSelect({ id: "model", name: "Model", currentValue: "opus" }, VALUES);
	assert.equal(model.value, "opus");
	assert.equal(model.label, "Opus");
	assert.deepEqual(plain(model.values), VALUES);
});

test("当前值不在枚举：补一条当前项，供 Radix 高亮与滚动（再点选由调用方忽略）", () => {
	const raw = "claude-opus-4-1-20250805";
	const model = resolveAcpConfigSelect({ id: "model", name: "Model", currentValue: raw }, VALUES);
	assert.equal(model.value, raw);
	assert.equal(model.label, raw);
	assert.equal(model.values.length, 3);
	assert.deepEqual(plain(model.values[0]), { value: raw, name: raw, current: true });
	assert.equal(model.values[1].current, undefined);
});

test("没有 currentValue：显示选项名，不补占位项（下拉不高亮）", () => {
	for (const currentValue of [undefined, ""]) {
		const model = resolveAcpConfigSelect({ id: "model", name: "Model", currentValue }, VALUES);
		assert.equal(model.value, "");
		assert.equal(model.label, "Model");
		assert.deepEqual(plain(model.values), VALUES);
	}
});

test("boolean 项保留在平铺结果里（值列表为空），交渲染层走开关分支", () => {
	const entries = flattenAcpConfigOptions([
		{ id: "multitask", name: "Multitask", type: "boolean", currentValue: true },
		{ id: "model", name: "Model", type: "select", options: VALUES },
	]);
	assert.equal(entries.length, 2);
	assert.deepEqual(plain(entries[0]), { option: { id: "multitask", name: "Multitask", type: "boolean", currentValue: true }, values: [] });
	assert.equal(entries[1].values.length, 2);
});

test("取值 description 原样透传（模型倍率/说明由列表项渲染）", () => {
	const withDesc = [{ value: "glm-5.3", name: "GLM-5.3", description: "0.69×" }];
	const entries = flattenAcpConfigOptions([{ id: "model", name: "Model", type: "select", options: withDesc }]);
	assert.deepEqual(plain(entries[0].values), withDesc);
	const model = resolveAcpConfigSelect({ id: "model", name: "Model", currentValue: "glm-5.3" }, entries[0].values);
	assert.equal(model.values[0].description, "0.69×");
});

test("模型倍率随取值透传（主进程注解的 rate 不能在下拉模型组装时丢掉）", () => {
	const values = [{ value: "codebuddy/glm-5.3", name: "GLM-5.3", rate: { rate: 0.69, was: 0.99 } }];
	const entries = flattenAcpConfigOptions([{ id: "model", name: "Model", type: "select", options: values }]);
	assert.deepEqual(plain(entries[0].values), values);
	const model = resolveAcpConfigSelect({ id: "model", name: "Model", currentValue: "codebuddy/glm-5.3" }, entries[0].values);
	assert.deepEqual(plain(model.values[0].rate), { rate: 0.69, was: 0.99 });
});

test("分组选项的 description 属于具体取值，不被组名前缀吞掉", () => {
	const entries = flattenAcpConfigOptions([{ id: "model", name: "Model", type: "select", options: [{ group: "codebuddy", name: "CodeBuddy", options: [{ value: "glm-5.3", name: "GLM-5.3", description: "0.69×" }] }] }]);
	assert.deepEqual(plain(entries[0].values), [{ value: "glm-5.3", name: "CodeBuddy / GLM-5.3", description: "0.69×" }]);
});

test("单值 select 不渲染；boolean 与多值 select 渲染", () => {
	const [booleanEntry, singleEntry, multiEntry] = flattenAcpConfigOptions([
		{ id: "delegate", name: "Delegate", type: "boolean", currentValue: false },
		{ id: "agent", name: "Agent", type: "select", options: [{ value: "cli", name: "CLI" }] },
		{ id: "mode", name: "Mode", type: "select", options: VALUES },
	]);
	assert.equal(isRenderableAcpConfigEntry(booleanEntry), true);
	assert.equal(isRenderableAcpConfigEntry(singleEntry), false, "单值 select 是点不动的死 chip");
	assert.equal(isRenderableAcpConfigEntry(multiEntry), true);
});
