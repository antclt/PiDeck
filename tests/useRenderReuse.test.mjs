import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * lib/hooks/use-render-reuse.ts 的运行时测试。
 *
 * 为什么必须存在：这一层把「派生对象引用复用」做成了 hook，结构复用的判据已搬进来，
 * 但在此之前**没有任何测试真的执行过它**——只有源码文本断言（找 useReusedList 的调用
 * 参数）。hook 内部若 ref 不更新、deps 比对写错、或缓存永不失效，那批契约测试照样全绿。
 * 源码文本断言守「有没有接线」，这里守「接上线之后行为对不对」。
 *
 * 怎么在没有 React 的情况下跑：给 useRef / useCallback 做一份按调用槽位保存的假实现
 * （React 的 hooks 本来就是「按调用顺序取槽」），每次 render 前把槽位指针归零。
 * 每个测试都用**独立的槽位数组**：真实 React 里不同组件实例各有自己的 hooks 槽，
 * 共用一份会把上一个测试的缓存带进下一个测试，测出来的行为与真实场景无关。
 */

/** 假 React hooks：按调用槽位保存状态，模拟同一组件实例的多次渲染。 */
function createHooks() {
	const cells = [];
	let slot = 0;
	const depsEqual = (previous, next) => previous !== undefined && previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
	return {
		begin() {
			slot = 0;
		},
		useRef(initial) {
			const index = slot++;
			if (cells[index] === undefined) cells[index] = { current: initial };
			return cells[index];
		},
		useCallback(fn, deps) {
			const index = slot++;
			const previous = cells[index];
			if (previous !== undefined && depsEqual(previous.deps, deps)) return previous.fn;
			cells[index] = { fn, deps };
			return fn;
		},
	};
}

/** 一个独立的「组件实例」：自己的 hooks 槽 + 自己的模块实例。 */
function createInstance() {
	const hooks = createHooks();
	const module = loadTsCommonJs("src/renderer/src/lib/hooks/use-render-reuse.ts", {
		stubs: { react: { useRef: hooks.useRef, useCallback: hooks.useCallback } },
	});
	return {
		module,
		/** 跑一次「渲染」：槽位指针归零后执行组件体。 */
		render(body) {
			hooks.begin();
			return body(module);
		},
	};
}

const sameItem = (previous, next) => previous.id === next.id && previous.text === next.text;

test("useReusedList：同一份 deps 不重跑 factory", () => {
	const { module, render } = createInstance();
	let calls = 0;
	const deps = [1];
	const factory = () => {
		calls += 1;
		return [{ id: "a", text: "1" }];
	};
	const first = render((m) => m.useReusedList(factory, deps, sameItem));
	const second = render((m) => m.useReusedList(factory, deps, sameItem));
	assert.equal(calls, 1, "deps 未变时 factory 不得重跑（否则每个流式 tick 都重建整列）");
	assert.equal(second, first, "同一份 deps 必须返回同一个数组引用");
});

test("useReusedList：deps 变了但内容等价时返回上一轮的数组本身", () => {
	const { render } = createInstance();
	let calls = 0;
	const factory = () => {
		calls += 1;
		return [
			{ id: "a", text: "1" },
			{ id: "b", text: "2" },
		];
	};
	const first = render((m) => m.useReusedList(factory, [1], sameItem));
	const second = render((m) => m.useReusedList(factory, [2], sameItem));
	assert.equal(calls, 2, "deps 变化必须重新调用 factory（内容可能真的变了）");
	assert.equal(second, first, "逐项等价且长度相同时必须复用数组本身——下游 memo 的命中前提");
	assert.equal(second[0], first[0], "逐项也要换回旧引用");
});

test("useReusedList：内容变化的项必须取新对象，未变项复用", () => {
	const { render } = createInstance();
	const first = render((m) =>
		m.useReusedList(
			() => [
				{ id: "a", text: "1" },
				{ id: "b", text: "2" },
			],
			[1],
			sameItem,
		),
	);
	const second = render((m) =>
		m.useReusedList(
			() => [
				{ id: "a", text: "1" },
				{ id: "b", text: "CHANGED" },
			],
			[2],
			sameItem,
		),
	);
	assert.notEqual(second, first, "有项变了数组必须换新");
	assert.equal(second[0], first[0], "未变项复用旧引用");
	assert.notEqual(second[1], first[1], "变化项必须取新对象，否则界面停在旧内容且不报错");
	assert.equal(second[1].text, "CHANGED");
});

test("useReusedList：长度变化时换数组但仍复用同下标命中项", () => {
	const { render } = createInstance();
	const first = render((m) => m.useReusedList(() => [{ id: "a", text: "1" }], [1], sameItem));
	const second = render((m) =>
		m.useReusedList(
			() => [
				{ id: "a", text: "1" },
				{ id: "b", text: "2" },
			],
			[2],
			sameItem,
		),
	);
	assert.notEqual(second, first);
	assert.equal(second.length, 2);
	assert.equal(second[0], first[0], "尾部追加是流式最常见的形态：已有项必须复用");
});

test("useLazyValue：render 期不执行，首次取值才算，且 deps 变化后失效", () => {
	const { render } = createInstance();
	let calls = 0;
	const read = render((m) =>
		m.useLazyValue(() => {
			calls += 1;
			return "v1";
		}, [1]),
	);
	assert.equal(calls, 0, "render 期求值等于每帧对整轮正文跑正则——惰性求值的全部意义就在这一行");
	assert.equal(read(), "v1");
	assert.equal(calls, 1);
	assert.equal(read(), "v1");
	assert.equal(calls, 1, "同 deps 命中缓存");

	// deps 变了：同一个组件实例的下一次渲染，取值函数引用不变（内部 useCallback deps 为空），
	// 但它读的是新的缓存单元 —— 所以必须返回新值，不能读到陈旧数据。
	const readAgain = render((m) =>
		m.useLazyValue(() => {
			calls += 1;
			return "v2";
		}, [2]),
	);
	assert.equal(readAgain, read, "取值函数引用必须稳定（可直接传给 memo 子组件）");
	assert.equal(readAgain(), "v2", "deps 变了必须重算");
	assert.equal(calls, 2);
});

test("useLazyValue：惰性结果只算一次，多次取值不重复执行", () => {
	const { render } = createInstance();
	let calls = 0;
	const read = render((m) =>
		m.useLazyValue(() => {
			calls += 1;
			return "x";
		}, []),
	);
	read();
	read();
	read();
	assert.equal(calls, 1);
	assert.equal(read(), "x");
	assert.equal(calls, 1);
});

test("useStableKeyedHandlers：同一 key 永远同一引用，不同 key 不同", () => {
	const { render } = createInstance();
	const get = render((m) => m.useStableKeyedHandlers((key) => () => key));
	const first = get("x");
	assert.equal(get("x"), first, "同一行的回调引用必须恒定，否则子组件 memo 全部失效");
	const other = get("y");
	assert.notEqual(other, first, "不同 key 必须是不同回调");
	assert.equal(first(), "x");
	assert.equal(other(), "y");
});

test("useStableKeyedHandlers：跨渲染仍返回同一引用（行 id 不变就不换）", () => {
	const { render } = createInstance();
	const getFirst = render((m) => m.useStableKeyedHandlers((key) => () => key));
	const a = getFirst("row-1");
	const getSecond = render((m) => m.useStableKeyedHandlers((key) => () => key));
	assert.equal(getSecond("row-1"), a, "下一次渲染拿到的仍是同一个回调引用");
});
