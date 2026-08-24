// 「+」菜单模式可见性纯函数测试（useComposerModeAvailability 抽出的 computeVisibleModes）：
// 模式收进「+」菜单后，普通/目标/规划/生图的可见顺序与过滤规则要与旧底栏 chip 一致——
// 生图独立于 pi/dsh 两种后端均可见、plan/goal 受扩展开关控制、imageGenLocked 锁死为只显示生图。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadHookModule() {
	const source = readFileSync(
		"src/renderer/src/hooks/useComposerModeAvailability.ts",
		"utf8",
	);
	// 只对纯函数求值：hook 的 React/desktopApi 是外部依赖，mock 掉副作用路径，
	// 仅转译后取 computeVisibleModes 导出做断言（行为不依赖真实扩展列表）。
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id.includes("react")) return { useCallback: () => {}, useEffect: () => {}, useState: () => [] };
			if (id.includes("desktopApi")) return {};
			throw new Error(`unexpected require: ${id}`);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "useComposerModeAvailability.ts" });
	return sandbox.exports;
}

const { computeVisibleModes } = loadHookModule();

test("pi 全扩展可用：普通/目标/规划/生图 全量可见（顺序 normal→goal→plan→imagegen）", () => {
	const result = [...computeVisibleModes({ isDsh: false, planModeAvailable: true, goalModeAvailable: true })];
	assert.deepEqual(result, ["normal", "goal", "plan", "imagegen"]);
});

test("pi 关闭 plan/goal 扩展：对应模式从菜单消失，普通与生图保留", () => {
	const result = [...computeVisibleModes({ isDsh: false, planModeAvailable: false, goalModeAvailable: false })];
	assert.deepEqual(result, ["normal", "imagegen"]);
});

test("DSH 会话：plan/goal 恒可用、生图同样可用（独立供应商，不随后端隐藏）", () => {
	// DSH 恒可用意味着 hook 会置 plan/goal 可用；生图为独立供应商，两种后端均可见。
	const result = [...computeVisibleModes({ isDsh: true, planModeAvailable: true, goalModeAvailable: true })];
	assert.deepEqual(result, ["normal", "goal", "plan", "imagegen"]);
});

test("imageGenLocked：锁定为仅生图（已有生图消息时防误切回 LLM 发送）", () => {
	const result = [...computeVisibleModes({
		isDsh: false,
		planModeAvailable: true,
		goalModeAvailable: true,
		imageGenLocked: true,
	})];
	assert.deepEqual(result, ["imagegen"]);
});