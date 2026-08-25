import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModelsTabModule() {
	const source = readFileSync("src/renderer/src/config/modelsUtils.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			jsx: ts.JsxEmit.ReactJSX,
		},
	});
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "react" || id === "react/jsx-runtime") return {};
			if (id === "lucide-react") return {};
			if (id === "../i18n") return { t: (key) => key };
			if (id === "./ConfigShared") return {};
			if (id === "./providerHeaders") {
				return {
					CUSTOM_USER_AGENT_VALUE: "__custom__",
					getUserAgentOptions: () => [],
					getHeaderValue: () => "",
					setHeaderValue: () => ({}),
				};
			}
			throw new Error(`Unexpected require: ${id}`);
		},
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "ModelsTab.tsx",
	});
	return sandbox.exports;
}

test("builds multiple fetched models and skips duplicates", () => {
	const { buildModelsFromFetchedSelection } = loadModelsTabModule();

	const models = buildModelsFromFetchedSelection(
		[
			{ id: "gpt-4o", name: "GPT 4o" },
			{ id: "gpt-4o-mini", name: "GPT 4o mini" },
			{ id: "reasoner" },
		],
		["gpt-4o", "gpt-4o-mini", "gpt-4o", "already-added"],
		[{ id: "already-added" }],
	);

	assert.deepEqual(JSON.parse(JSON.stringify(models)), [
		{ id: "gpt-4o", name: "GPT 4o" },
		{ id: "gpt-4o-mini", name: "GPT 4o mini" },
	]);
});

test("carries listing capacities onto new models and leaves missing fields empty", () => {
	const { buildModelsFromFetchedSelection } = loadModelsTabModule();
	const models = buildModelsFromFetchedSelection(
		[
			{
				id: "listed",
				name: "Listed",
				contextWindow: 64000,
				maxTokens: 4096,
				reasoning: true,
				thinkingLevelMap: { off: null, high: "high", max: "max" },
				input: ["text", "image"],
			},
			{ id: "empty" },
		],
		["listed", "empty"],
		[],
	);
	assert.deepEqual(JSON.parse(JSON.stringify(models)), [
		{
			id: "listed",
			name: "Listed",
			contextWindow: 64000,
			maxTokens: 4096,
			reasoning: true,
			thinkingLevelMap: { off: null, high: "high", max: "max" },
			input: ["text", "image"],
		},
		{ id: "empty", name: "empty" },
	]);
});
