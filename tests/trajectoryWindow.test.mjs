import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 轨迹渲染预算纯函数（计划 §5 S3）：账本窗口与概览聚合。
 * 判定目标：挂载量只随窗口走、不随会话长度走；概览标记数服从像素预算。
 */

const { buildTrajectoryWindow, bucketOverviewTicks, TRAJECTORY_TURN_COHORT, TRAJECTORY_TURN_STEP_LIMIT, TRAJECTORY_EXTRA_RECORD_BUDGET } = loadTsCommonJs("src/renderer/src/components/session/trajectory/trajectoryWindow.ts");

const LANES = ["input", "model", "tools", "process"];

function makeRecords({ turns, perTurn }) {
	const records = [];
	for (let turn = 0; turn < turns; turn += 1) {
		for (let step = 0; step < perTurn; step += 1) {
			records.push({
				id: `t${turn}-${step}`,
				kind: "process",
				lane: LANES[step % LANES.length],
				turnIndex: turn,
				title: "x",
				summary: "x",
				startedAt: turn * 1000 + step,
			});
		}
	}
	return records;
}

test("15k 消息样本只挂载尾部 3 轮且单轮不超 120 条", () => {
	const records = makeRecords({ turns: 100, perTurn: 150 });
	const windowed = buildTrajectoryWindow(records);
	assert.ok(windowed.records.length <= TRAJECTORY_TURN_COHORT * TRAJECTORY_TURN_STEP_LIMIT + TRAJECTORY_EXTRA_RECORD_BUDGET);
	assert.equal(windowed.endTurn, 99);
	assert.equal(windowed.startTurn, 97);
	assert.equal(windowed.hasEarlier, true);
	assert.equal(windowed.trimmed, true, "单轮 150 条超过步数预算，必须标记 trimmed");
	// 尾部内容必须在（最新一轮的末尾记录不能丢）。
	assert.equal(windowed.records[windowed.records.length - 1].id, "t99-149");
});

test("短会话不裁剪，hasEarlier=false", () => {
	const records = makeRecords({ turns: 2, perTurn: 10 });
	const windowed = buildTrajectoryWindow(records);
	assert.equal(windowed.records.length, 20);
	assert.equal(windowed.hasEarlier, false);
	assert.equal(windowed.trimmed, false);
});

test("空会话返回空窗口", () => {
	const windowed = buildTrajectoryWindow([]);
	assert.equal(windowed.records.length, 0);
	assert.equal(windowed.hasEarlier, false);
});

test("概览每 lane 刻度不超过像素预算，且选中项一定有刻度", () => {
	const records = makeRecords({ turns: 100, perTurn: 150 });
	const ticks = bucketOverviewTicks(records, { lanes: LANES, width: 300 });
	const perLane = Math.max(1, Math.min(250, Math.ceil(300 / 4)));
	assert.ok(ticks.length <= LANES.length * perLane + 1, `刻度数 ${ticks.length} 超出预算`);
	for (const lane of LANES) {
		assert.ok(ticks.filter((tick) => tick.lane === lane).length <= perLane);
	}
	const selected = bucketOverviewTicks(records, { lanes: LANES, width: 300, selectedId: "t50-3" });
	assert.ok(selected.some((tick) => tick.selected && tick.recordId === "t50-3") || selected.some((tick) => tick.selected));
});

test("概览桶内计数守恒（聚合不吞记录）", () => {
	const records = makeRecords({ turns: 20, perTurn: 40 });
	const ticks = bucketOverviewTicks(records, { lanes: LANES, width: 1200 });
	const total = ticks.reduce((sum, tick) => sum + tick.count, 0);
	assert.equal(total, records.length);
});

test("宽度极小也不出现 0 刻度", () => {
	const records = makeRecords({ turns: 1, perTurn: 4 });
	const ticks = bucketOverviewTicks(records, { lanes: LANES, width: 1 });
	assert.ok(ticks.length > 0);
});

test("导轨目录合并：已加载项保留原标题，未加载项以序号占位且可按 entryId 回查", async () => {
	const { mergeOutlineRailItems, isPendingRailItemId, pendingEntryIdOf } = loadTsCommonJs("src/renderer/src/components/session/timeline/outlineRailTicks.ts");
	const loaded = [
		{ id: "m1", entryId: "e1", role: "user", title: "第一条提问", time: "10:00" },
		{ id: "m3", entryId: "e3", role: "user", title: "第二条提问", time: "10:05" },
	];
	const directory = [
		{ entryId: "e1", turnOrdinal: 0, timestamp: "2026-01-01T02:00:00.000Z" },
		{ entryId: "e2", turnOrdinal: 1, timestamp: "2026-01-01T02:01:00.000Z" },
		{ entryId: "e3", turnOrdinal: 2, timestamp: "2026-01-01T02:05:00.000Z" },
	];
	const merged = mergeOutlineRailItems(loaded, directory);
	assert.equal(merged.length, 3);
	assert.equal(merged[0].title, "第一条提问");
	assert.equal(merged[1].pending, true);
	assert.equal(merged[1].title, "#2");
	assert.equal(isPendingRailItemId(merged[1].id), true);
	assert.equal(pendingEntryIdOf(merged[1].id), "e2");
	assert.equal(merged[2].id, "m3");
});

test("目录为空时退回已加载大纲（非 pi 后端）", async () => {
	const { mergeOutlineRailItems } = loadTsCommonJs("src/renderer/src/components/session/timeline/outlineRailTicks.ts");
	const loaded = [{ id: "m1", role: "user", title: "只有已加载", time: "10:00" }];
	assert.equal(mergeOutlineRailItems(loaded, []).length, 1);
});

test("窗口外的会话开头（初始提示词）不被裁掉", () => {
	const records = [{ id: "sys", kind: "systemPrompt", lane: "input", turnIndex: 0, title: "初始提示词", summary: "initial", startedAt: 0 }, ...makeRecords({ turns: 40, perTurn: 30 })];
	const windowed = buildTrajectoryWindow(records);
	assert.ok(
		windowed.records.some((record) => record.id === "sys"),
		"初始提示词必须留在账本开头",
	);
	assert.ok(windowed.records.length <= TRAJECTORY_TURN_COHORT * TRAJECTORY_TURN_STEP_LIMIT + TRAJECTORY_EXTRA_RECORD_BUDGET);
});
