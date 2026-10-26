import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 思考强度滑条契约（ZCode 渐变强度条同构）。
 * 组件含 hooks（useShortcutBindings/useMemo），不能当普通函数调用拿元素树——
 * 统一走 renderToStaticMarkup（SSR 支持 hooks），交互节点由桩渲染时捕获 props。
 */
const passthrough = ({ children }) => children;

function createHarness() {
	const captured = { sliders: [], buttons: [] };
	const slider = (props) => {
		captured.sliders.push(props);
		return createElement("div", { role: "slider", "aria-label": props["aria-label"], className: props.className }, props.children);
	};
	const button = ({ children, onClick, disabled, ...props }) => {
		captured.buttons.push({ ...props, onClick, disabled, children });
		return createElement("button", { ...props, onClick, disabled }, children);
	};
	const { ModelThinkingChip, ThinkingLevelDropdown } = loadTsCommonJs("src/renderer/src/components/session/ModelThinkingChip.tsx", {
		stubs: {
			"../../i18n": { t: (key) => key },
			"../ui-shadcn/button": { Button: button },
			"../ui-shadcn/popover": { Popover: passthrough, PopoverTrigger: passthrough, PopoverContent: passthrough },
			"../ui-shadcn/slider": { Slider: slider },
			"../../hooks/useShortcutBindings": { useShortcutBindings: () => ({ bindings: { cycleThinking: "Control+T" }, platform: "win32" }) },
		},
	});
	return { captured, ModelThinkingChip, ThinkingLevelDropdown };
}

const noop = () => {};
const BASE = { open: true, onOpenChange: noop, onPick: noop };

test("思考强度条直接呈现（Popover 壳 + 渐变滑条），无单选菜单项/搜索框/确认按钮", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const html = renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "high" }));
	assert.match(html, /role="slider"/);
	assert.equal(captured.sliders.length, 1);
	// 7 个离散档位刻度标签
	assert.equal(captured.buttons.filter((b) => b["data-tick-value"]).length, 7);
	assert.ok(html.includes("thinking.levelLabel.high"));
	// 快捷键提示跟随生效绑定（hook 桩返回 Control+T）
	assert.ok(html.includes("Ctrl+T"));
	assert.doesNotMatch(html, /role="menuitemradio"|common\.confirm|<input/);
});

test("滑条离散吸附：min/max 覆盖全部档位，value=当前档位下标，step=1", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const levels = [{ value: "off" }, { value: "low" }, { value: "medium" }, { value: "high" }];
	renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "medium", levels }));
	const [sliderProps] = captured.sliders;
	// VM realm 的数组与本地 Array 原型不同，逐值比较（见 AGENTS 测试规约）
	assert.equal(sliderProps.value[0], 2);
	assert.equal(sliderProps.min, 0);
	assert.equal(sliderProps.max, 3);
	assert.equal(sliderProps.step, 1);
});

test("仅展示当前模型档位，保留未知未来 id、标签与说明", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const levels = [
		{ value: "low", labelKey: "thinking.levelLabel.low" },
		{ value: "future-level", label: "Future effort", description: "Provider-defined effort" },
	];
	const html = renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "future-level", levels }));
	assert.equal(captured.buttons.filter((b) => b["data-tick-value"]).length, 2);
	assert.ok(html.includes("Future effort"));
	assert.ok(html.includes('title="Provider-defined effort"'));
	assert.ok(!captured.buttons.some((b) => b["data-tick-value"] === "off" || b["data-tick-value"] === "max"));
});

test("当传入超出模型支持档位（如 max）时，滑条 clamp 到支持档位（如 high）而不泄露", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const levels = [{ value: "low" }, { value: "medium" }, { value: "high" }];
	renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "max", levels }));
	assert.equal(captured.sliders[0].value[0], 2);
	assert.ok(!captured.buttons.some((b) => b["data-tick-value"] === "max"));
});

test("拖拽只预览不提交（松手 onPointerUp 才 onPick），同值提交跳过", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const picked = [];
	const levels = [{ value: "low" }, { value: "medium" }, { value: "high" }];
	renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "low", levels, onPick: (value) => picked.push(value) }));
	// 拖拽路径（onValueChange 逐档触发）：不得提交——否则第一档应用后弹层立即关闭
	captured.sliders[0].onValueChange([1]);
	captured.sliders[0].onValueChange([2]);
	assert.deepEqual(picked, []);
	// 松手：提交拖拽终点档位
	captured.sliders[0].onPointerUp();
	assert.deepEqual(picked, ["high"]);
	// 原地点击 thumb（值未变）：跳过无意义 RPC
	captured.sliders[0].onPointerUp();
	assert.deepEqual(picked, ["high"]);
});

test("键盘方向键预览（onValueChange）、Enter/空格提交预览档位", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const picked = [];
	const levels = [{ value: "low" }, { value: "medium" }, { value: "high" }];
	renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "low", levels, onPick: (value) => picked.push(value) }));
	const key = (key) => captured.sliders[0].onKeyDown({ key, preventDefault: () => {} });
	// Radix 事件流：方向键由 Slider 内部处理并回调 onValueChange（预览），Enter 不移动值
	captured.sliders[0].onValueChange([1]);
	assert.deepEqual(picked, []);
	key("Enter");
	assert.deepEqual(picked, ["medium"]);
	key("Enter");
	assert.deepEqual(picked, ["medium"]); // 已提交值不重复发
});

test("点刻度标签立即提交原始 id", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const picked = [];
	const levels = [{ value: "low" }, { value: "medium" }, { value: "high" }];
	renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "low", levels, onPick: (value) => picked.push(value) }));
	captured.buttons.find((b) => b["data-tick-value"] === "medium").onClick();
	assert.deepEqual(picked, ["medium"]);
});

test("后端明确返回空档位时展示不可用提示，不渲染滑条", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const html = renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, levels: [] }));
	assert.ok(html.includes("app.thinkingPickerUnsupported"));
	assert.equal(captured.sliders.length, 0);
	assert.equal(captured.buttons.filter((b) => b["data-tick-value"]).length, 0);
});

test("启动中禁用触发器、滑条与刻度标签；运行中不额外禁用", () => {
	for (const disabled of [true, false]) {
		const { captured, ThinkingLevelDropdown } = createHarness();
		renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, disabled, levels: [{ value: "high" }] }));
		const trigger = captured.buttons.find((b) => !b["data-tick-value"]);
		assert.equal(trigger.disabled, disabled);
		assert.equal(captured.sliders[0].disabled, disabled);
		assert.equal(captured.buttons.find((b) => b["data-tick-value"]).disabled, disabled);
	}
});

test("模型按钮独立打开现有模型选择器，并保留待生效标签与思考入口", () => {
	const { captured, ModelThinkingChip } = createHarness();
	let opened = 0;
	const html = renderToStaticMarkup(createElement(ModelThinkingChip, { modelLabel: "Current model", modelPendingTo: "Next model", modelPendingTitle: "Next turn", onPickModel: () => opened++, thinkingControl: createElement("div", { "data-testid": "thinking-control" }, "high") }));
	assert.ok(captured.buttons.some((b) => b.title === "Next turn"));
	assert.equal(opened, 0);
	assert.ok(html.includes("Current model → Next model"));
	assert.ok(html.includes('data-testid="thinking-control"'));
});
