import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { toDshAvailableModels } = loadTsCommonJs("src/main/dsh/dshModels.ts");

/** 与 DSH host llm.models / session.models 实测一致的组形状。 */
const group = (id, models) => ({ id, name: id, models });

test("toDshAvailableModels 透传 reasoningEfforts（按模型过滤思考档位）", () => {
	const models = toDshAvailableModels([
		group("llm-deepseek", [
			{
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				reasoning: {
					efforts: [
						{ id: "off", name: "Off" },
						{ id: "high", name: "High" },
						{ id: "max", name: "Max" },
					],
					defaultEffort: "high",
				},
			},
		]),
		group("opencode-go", [
			// 无 reasoning 元数据的模型：不带 reasoningEfforts 字段
			{ id: "plain-model", name: "Plain" },
		]),
	]);
	assert.equal(models.length, 2);
	assert.equal(models[0].provider, "llm-deepseek");
	assert.equal(models[0].id, "deepseek-v4-flash");
	assert.deepEqual(models[0].reasoningEfforts?.map((effort) => effort.id), ["off", "high", "max"]);
	assert.equal(models[0].reasoningEfforts?.[1].name, "High");
	// 无 reasoning 字段的模型不声明档位（选择器对 pi 语义不适用，DSH 侧原样透传）
	assert.equal("reasoningEfforts" in models[1], false);
});

test("toDshAvailableModels 过滤掉缺失 id 的档位条目", () => {
	const models = toDshAvailableModels([
		group("opencode-go", [
			{
				id: "glm-5.2",
				name: "GLM-5.2",
				reasoning: {
					efforts: [
						{ id: "high", name: "High" },
						// 形状异常的档位（无 id）不应进入结果
						{ name: "Broken" },
						{ id: "max", name: "Max" },
					],
				},
			},
		]),
	]);
	assert.deepEqual(models[0].reasoningEfforts?.map((effort) => effort.id), ["high", "max"]);
});

test("toDshAvailableModels 空目录 / 空组返回空列表", () => {
	// loadTsCommonJs 编译产物在 VM realm，数组跨 realm 不能 deepStrictEqual，断言长度
	assert.equal(toDshAvailableModels([]).length, 0);
	assert.equal(toDshAvailableModels([group("opencode-go", [])]).length, 0);
});

test("toDshAvailableModels 组缺 models 字段时安全跳过", () => {
	assert.equal(toDshAvailableModels([{ id: "no-models" }]).length, 0);
});
