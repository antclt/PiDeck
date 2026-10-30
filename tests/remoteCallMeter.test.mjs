import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteCallMeter, formatRemoteCallMeter, REMOTE_CALL_METER_OVERFLOW_METHOD } = loadTsCommonJs("src/main/remote/RemoteCallMeter.ts");
const { createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");

/** Production objects live in another VM realm, so structures are compared through JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * W0 基线（docs/remote-file-tree-and-git-unification-plan.md §4）：
 * 一次 helper request 就是一次 SSH 往返，W3 的预算门禁（一次内容变化 listRepos ≤1、每仓 status ≤1）
 * 直接读这里的数字。所以这组用例钉两件事：计量本身正确，且它只统计**真的会发出帧**的请求。
 */
test("按 (hostId, method) 计数，快照按次数降序且与内部状态解耦", () => {
	const meter = createRemoteCallMeter({ log: null });
	meter.record("host-a", "git.status");
	meter.record("host-a", "git.status");
	meter.record("host-a", "git.repos");
	meter.record("host-b", "entry.stat");

	const snapshot = plain(meter.snapshot());
	assert.deepEqual(snapshot[0], { hostId: "host-a", method: "git.status", calls: 2 });
	assert.equal(meter.total(), 4);
	// 快照是拷贝：调用方修改它不得影响内部计数。
	snapshot[0].calls = 999;
	assert.equal(plain(meter.snapshot())[0].calls, 2);

	meter.reset();
	assert.deepEqual(plain(meter.snapshot()), []);
	assert.equal(meter.total(), 0);
});

test("键数有界：超出上限折进 __other__，腾位时淘汰次数最少的键", () => {
	const meter = createRemoteCallMeter({ log: null, maxKeys: 3 });
	meter.record("host", "hot");
	meter.record("host", "hot");
	meter.record("host", "cold");
	// 第 3 个键刚好装满上限，此时还没有溢出项。
	meter.record("host", "extra");
	assert.equal(plain(meter.snapshot()).length, 3);
	assert.equal(
		plain(meter.snapshot()).find((entry) => entry.method === REMOTE_CALL_METER_OVERFLOW_METHOD),
		undefined,
	);

	// 第 4 个键：腾位时淘汰次数最少的键（cold/extra 同为 1，取先到者），并把新键折进 __other__。
	meter.record("host", "x1");
	const folded = plain(meter.snapshot());
	assert.equal(folded.length, 3);
	assert.equal(
		folded.find((entry) => entry.method === "cold"),
		undefined,
	);
	assert.equal(folded.find((entry) => entry.method === "hot")?.calls, 2);
	assert.equal(folded.find((entry) => entry.method === "extra")?.calls, 1);
	assert.equal(folded.find((entry) => entry.method === REMOTE_CALL_METER_OVERFLOW_METHOD)?.calls, 1);

	// 后续未知名全部折进同一格，键数仍不超上限。
	meter.record("host", "x2");
	meter.record("host", "x3");
	const after = plain(meter.snapshot());
	assert.ok(after.length <= 3);
	assert.equal(after.find((entry) => entry.method === REMOTE_CALL_METER_OVERFLOW_METHOD)?.calls, 3);
	assert.equal(meter.total(), 7);
});

test("汇总行紧凑且不含换行；空表只有头部", () => {
	assert.equal(formatRemoteCallMeter([], 0), "remote-meter total=0 unique=0");
	const line = formatRemoteCallMeter(
		[
			{ hostId: "abcdefgh1234", method: "git.status", calls: 9 },
			{ hostId: "abcdefgh1234", method: "git.repos", calls: 2 },
		],
		11,
	);
	assert.equal(line, "remote-meter total=11 unique=2 abcdefgh:git.status×9 abcdefgh:git.repos×2");
	assert.equal(line.includes("\n"), false);
	// limit 只截断展示，不改 total/unique。
	assert.equal(formatRemoteCallMeter([{ hostId: "h", method: "m", calls: 1 }], 1, 1).includes("×1"), true);
});

test("日志默认静默；开启后按间隔节流", () => {
	let now = 1_000;
	const lines = [];
	const meter = createRemoteCallMeter({
		now: () => now,
		log: (line) => lines.push(line),
		enabled: () => false,
		logIntervalMs: 100,
	});
	meter.record("h", "git.status");
	assert.deepEqual(lines, [], "未开启时一行都不打");

	const enabledLines = [];
	const throttled = createRemoteCallMeter({
		now: () => now,
		log: (line) => enabledLines.push(line),
		enabled: () => true,
		logIntervalMs: 100,
	});
	throttled.record("h", "git.status");
	assert.equal(enabledLines.length, 1);
	throttled.record("h", "git.status");
	assert.equal(enabledLines.length, 1, "间隔内不再打印");
	now += 100;
	throttled.record("h", "git.status");
	assert.equal(enabledLines.length, 2);
	assert.match(enabledLines[1], /^remote-meter total=3 unique=1 /);
});

test("helper 客户端只统计将要发出帧的请求（合法 method + 已连接）", async () => {
	const recorded = [];
	const meter = { record: (hostId, method) => recorded.push([hostId, method]) };
	const frames = [];
	const client = createRemoteControlClient({
		hostId: "host-1",
		send: (line) => {
			frames.push(line);
		},
		meter,
	});

	// 未连接：本地拒绝，不算往返。
	await assert.rejects(client.request("git.status", {}), /REMOTE_CONNECTION_LOST/);
	assert.deepEqual(recorded, []);

	client.openConnection();
	const pending = client.request("git.status", { repo: "" });
	assert.deepEqual(recorded, [["host-1", "git.status"]]);
	assert.equal(frames.length, 1, "计数发生在发帧路径上");

	// 非法 method 在计数之前就被拒绝。
	await assert.rejects(client.request("Bad Method", {}), /PROTOCOL_INVALID/);
	assert.equal(recorded.length, 1);

	// 断开后不再计数；挂起的请求按连接丢失结算。
	client.closeConnection();
	await assert.rejects(pending, /REMOTE_CONNECTION_LOST/);
	await assert.rejects(client.request("git.status", {}), /REMOTE_CONNECTION_LOST/);
	assert.equal(recorded.length, 1);
});
