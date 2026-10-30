import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * #453 会话 Tab 拖拽排序：
 * - 落点几何（sessionTabDrag）必须把缝隙、末尾空白、分组块都算进去；
 * - 写回顺序（sessionTabGroups.reorderSessionTabsByDisplayOrder）必须按**显示顺序**换算，
 *   否则分组函数会把底层 tabs 重排回原样（内部数组变了、画面没动）。
 */

const { buildSessionTabDropUnits, resolveSessionTabDropTarget } = loadTsCommonJs("src/renderer/src/utils/sessionTabDrag.ts");
const { buildSessionTabBarEntries, flattenSessionTabBarEntries, reorderSessionTabsByDisplayOrder } = loadTsCommonJs("src/renderer/src/utils/sessionTabGroups.ts");

const rects = (map) => (sessionId) => map[sessionId] ?? null;
const projectOf = (map) => (sessionId) => (map[sessionId] ? { projectId: map[sessionId], name: map[sessionId] } : undefined);
const json = (value) => JSON.stringify(value);

function display(tabs, pinned, split, projects) {
	return flattenSessionTabBarEntries(buildSessionTabBarEntries(tabs, pinned, split, projectOf(projects)));
}

// ───────────────────────── 落点几何 ─────────────────────────

test("resolveSessionTabDropTarget: Tab 左右半区分别判前/后", () => {
	const units = buildSessionTabDropUnits(
		[
			{ kind: "tab", sessionId: "a" },
			{ kind: "tab", sessionId: "b" },
		],
		rects({ a: { left: 0, width: 100 }, b: { left: 104, width: 100 } }),
	);
	assert.equal(json(resolveSessionTabDropTarget(units, 20, "b")), json({ targetId: "a", position: "before" }));
	assert.equal(json(resolveSessionTabDropTarget(units, 80, "b")), json({ targetId: "a", position: "after" }));
	// 落在自己身上：由调用方按「原位」处理（不画线、不写盘）
	assert.equal(resolveSessionTabDropTarget(units, 10, "a").targetId, "a");
});

test("resolveSessionTabDropTarget: gap 与末尾空白都是可放置区域（#453 根因一）", () => {
	const units = buildSessionTabDropUnits(
		[
			{ kind: "tab", sessionId: "a" },
			{ kind: "tab", sessionId: "b" },
		],
		rects({ a: { left: 0, width: 100 }, b: { left: 104, width: 100 } }),
	);
	// 4px gap 中点：落到相邻 slot（a 之后 = b 之前），松手不再落空
	const inGap = resolveSessionTabDropTarget(units, 102, "b");
	assert.equal(inGap.position, "after");
	assert.equal(inGap.targetId, "a");
	// 最后一个 Tab 右侧的整片空白（含「+」按钮）：恒为最后一个 Tab 的 after
	assert.equal(json(resolveSessionTabDropTarget(units, 500, "b")), json({ targetId: "b", position: "after" }));
});

test("resolveSessionTabDropTarget: 外部 Tab 落在项目分组上吸附到整组边界", () => {
	const units = buildSessionTabDropUnits(
		[
			{ kind: "project", projectId: "P", sessionIds: ["p1", "p2"] },
			{ kind: "tab", sessionId: "L" },
		],
		rects({ p1: { left: 0, width: 100 }, p2: { left: 104, width: 100 }, L: { left: 208, width: 100 } }),
	);
	// 组内没有外部 Tab 的槽位：整组中点左侧 → 组前，右侧 → 组后
	assert.equal(json(resolveSessionTabDropTarget(units, 20, "L")), json({ targetId: "p1", position: "before" }));
	assert.equal(json(resolveSessionTabDropTarget(units, 180, "L")), json({ targetId: "p2", position: "after" }));
});

test("resolveSessionTabDropTarget: 组内成员之间按成员判定（同组可任意插）", () => {
	const units = buildSessionTabDropUnits([{ kind: "project", projectId: "P", sessionIds: ["p1", "p2"] }], rects({ p1: { left: 0, width: 100 }, p2: { left: 104, width: 100 } }));
	assert.equal(json(resolveSessionTabDropTarget(units, 120, "p1")), json({ targetId: "p2", position: "before" }));
	assert.equal(json(resolveSessionTabDropTarget(units, 90, "p2")), json({ targetId: "p1", position: "after" }));
});

test("resolveSessionTabDropTarget: 分屏组整组一个落点，组员不可拖", () => {
	const units = buildSessionTabDropUnits(
		[
			{ kind: "split", sessionIds: ["s1", "s2"] },
			{ kind: "tab", sessionId: "L" },
		],
		rects({ s1: { left: 0, width: 100 }, s2: { left: 104, width: 100 }, L: { left: 208, width: 100 } }),
	);
	assert.equal(json(resolveSessionTabDropTarget(units, 20, "L")), json({ targetId: "s1", position: "before" }));
	assert.equal(json(resolveSessionTabDropTarget(units, 180, "L")), json({ targetId: "s2", position: "after" }));
	// 组员自己拖动：组内顺序由分屏布局决定，没有落点
	assert.equal(resolveSessionTabDropTarget(units, 180, "s1"), null);
});

test("buildSessionTabDropUnits: 未渲染（宽度 0 / 收起）的成员不参与落点", () => {
	const units = buildSessionTabDropUnits(
		[
			{ kind: "split", sessionIds: ["s1", "s2"] },
			{ kind: "tab", sessionId: "hidden" },
			{ kind: "tab", sessionId: "a" },
		],
		rects({ a: { left: 0, width: 100 }, hidden: { left: 0, width: 0 } }),
	);
	assert.equal(units.length, 1);
	assert.equal(units[0].kind, "tab");
	assert.equal(units[0].sessionId, "a");
	assert.equal(resolveSessionTabDropTarget([], 10, "a"), null);
});

// ───────────────────────── 显示顺序重排 ─────────────────────────

test("reorderSessionTabsByDisplayOrder: 单项目内拖到末尾（#453 场景：线在末尾，落点也在末尾）", () => {
	const projects = { a1: "A", a2: "A", a3: "A" };
	const tabs = ["a1", "a2", "a3"];
	const before = display(tabs, [], [], projects);
	assert.equal(json(before), json(["a1", "a2", "a3"]));
	const next = reorderSessionTabsByDisplayOrder(tabs, [], [], projectOf(projects), "a1", "a3", "after");
	assert.ok(next, "拖到末尾必须产生变化");
	assert.equal(json(next.tabs), json(["a2", "a3", "a1"]));
	assert.equal(json(display(next.tabs, next.pinned, [], projects)), json(["a2", "a3", "a1"]));
});

test("reorderSessionTabsByDisplayOrder: 同项目组内插队按显示顺序生效", () => {
	const projects = { a1: "A", a2: "A", a3: "A" };
	const next = reorderSessionTabsByDisplayOrder(["a1", "a2", "a3"], [], [], projectOf(projects), "a3", "a1", "before");
	assert.equal(json(next.tabs), json(["a3", "a1", "a2"]));
});

test("reorderSessionTabsByDisplayOrder: 无项目会话可以挪到分组之前", () => {
	const projects = { p1: "P", p2: "P" };
	const tabs = ["p1", "p2", "L"];
	const next = reorderSessionTabsByDisplayOrder(tabs, [], [], projectOf(projects), "L", "p1", "before");
	assert.ok(next);
	assert.equal(json(next.tabs), json(["L", "p1", "p2"]));
	assert.equal(json(display(next.tabs, next.pinned, [], projects)), json(["L", "p1", "p2"]));
});

test("reorderSessionTabsByDisplayOrder: 跨项目拖动整块移动（不再出现「落点 ≠ 结果」）", () => {
	const projects = { a1: "A", a2: "A", b1: "B" };
	const tabs = ["a1", "a2", "b1"];
	const next = reorderSessionTabsByDisplayOrder(tabs, [], [], projectOf(projects), "a1", "b1", "after");
	assert.ok(next);
	assert.equal(json(display(next.tabs, next.pinned, [], projects)), json(["b1", "a1", "a2"]));
});

test("reorderSessionTabsByDisplayOrder: 无法表达的落点返回 null，不静默改写底层顺序", () => {
	const projects = { p1: "P", p2: "P" };
	// 无项目会话塞进项目分组中间：分组要求同项目相邻，显示顺序不会变
	const blocked = reorderSessionTabsByDisplayOrder(["p1", "p2", "L"], [], [], projectOf(projects), "L", "p2", "after");
	assert.equal(blocked, null);
	// 拖回原位
	assert.equal(reorderSessionTabsByDisplayOrder(["a1", "a2"], [], [], projectOf({ a1: "A", a2: "A" }), "a1", "a1", "after"), null);
});

test("reorderSessionTabsByDisplayOrder: 分屏组内不重排，作为落点时吸附到整组边界", () => {
	const projects = { a1: "A", a2: "A" };
	const split = ["s1", "s2"];
	// 组员拖动：不改写
	assert.equal(reorderSessionTabsByDisplayOrder(["a1", "a2", "s1", "s2"], [], split, projectOf(projects), "s1", "a1", "before"), null);
	// 外部 Tab 落到分屏组上 → 吸附到整组边界，整块移动（落点几何只会给出组边界，不会给出组内成员）
	const next = reorderSessionTabsByDisplayOrder(["a1", "a2", "s1", "s2"], [], split, projectOf(projects), "a2", "s2", "after");
	assert.ok(next);
	assert.equal(json(display(next.tabs, next.pinned, split, projects)), json(["s1", "s2", "a1", "a2"]));
	// 组内插队（s1 之后）同样吸附到整组之后，不产生「组内插入」
	const snapped = reorderSessionTabsByDisplayOrder(["a1", "a2", "s1", "s2"], [], split, projectOf(projects), "a2", "s1", "after");
	assert.equal(json(display(snapped.tabs, snapped.pinned, split, projects)), json(["s1", "s2", "a1", "a2"]));
});

test("reorderSessionTabsByDisplayOrder: 拖进固定区即固定（沿用交叉拖放语义）", () => {
	const projects = { p1: "P", n1: "P", n2: "P" };
	const next = reorderSessionTabsByDisplayOrder(["p1", "n1", "n2"], ["p1"], [], projectOf(projects), "n1", "p1", "before");
	assert.ok(next);
	assert.equal(json(next.pinned), json(["p1", "n1"]));
	assert.equal(json(next.tabs), json(["n1", "p1", "n2"]));
});
