import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");

const HOST = "01234567-89ab-4def-8123-456789abcdef";
const GENERATION_MISMATCH = 99;
/** 沙箱里造的对象的原型与测试文件不同：比较前复制成本地值。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
	const sent = [];
	const events = [];
	const diagnostics = [];
	const client = createRemoteControlClient({
		hostId: HOST,
		send: (line) => sent.push(line),
		onEvent: (event) => events.push(event),
		onDiagnostic: (entry) => diagnostics.push(entry),
		...options,
	});
	return { client, sent, events, diagnostics };
}

/**
 * 变更事件帧（helper 1.24.0）：它**没有 id**，所以永远不能进 pending 表，也不能被当成某个请求的应答。
 * 这组用例钉住三条：事件照常送达、围栏照常生效、坏事件帧只进诊断。
 */
test("事件帧到达 onEvent，且不会被当成任何请求的应答", async () => {
	const h = harness();
	const generation = h.client.openConnection();
	const pending = h.client.request("fs.watch", { paths: [""] });
	const requestId = JSON.parse(h.sent[0]).id;

	h.client.handleLine(JSON.stringify({ v: 1, hostId: HOST, generation, watchId: "w1-" + requestId, event: "changed", paths: ["src"] }));
	assert.deepEqual(plain(h.events), [{ watchId: "w1-" + requestId, paths: ["src"] }], "事件原样送达");
	assert.equal(h.diagnostics.length, 0, "合法事件帧不该产生诊断");

	// 同一个 id 的正常应答仍然结算那个请求（事件帧没有把它消耗掉）。
	h.client.handleLine(JSON.stringify({ v: 1, hostId: HOST, generation, id: requestId, ok: true, result: { watchId: "w1-" + requestId, paths: 1 } }));
	assert.deepEqual(plain(await pending), { watchId: "w1-" + requestId, paths: 1 });
});

test("围栏：旧 generation / 别的 host 的事件帧都不送达", () => {
	const h = harness();
	const generation = h.client.openConnection();
	const frame = (overrides) => JSON.stringify({ v: 1, hostId: HOST, generation, watchId: "w1", event: "changed", paths: ["src"], ...overrides });

	h.client.handleLine(frame({ generation: generation + GENERATION_MISMATCH }));
	assert.deepEqual(h.events, [], "被取代的 generation 不得送达");
	assert.ok(
		h.diagnostics.some((entry) => entry.code === "REMOTE_FRAME_STALE_GENERATION"),
		JSON.stringify(h.diagnostics),
	);

	h.client.handleLine(frame({ hostId: "11111111-1111-4111-8111-111111111111" }));
	assert.deepEqual(h.events, [], "别的主机不得送达");
});

test("坏事件帧只进诊断：缺 watchId、未知 event、超长路径", () => {
	const h = harness();
	const generation = h.client.openConnection();
	const frame = (overrides) => JSON.stringify({ v: 1, hostId: HOST, generation, watchId: "w1", event: "changed", paths: ["src"], ...overrides });

	h.client.handleLine(frame({ watchId: "" }));
	h.client.handleLine(frame({ watchId: "x".repeat(200) }));
	h.client.handleLine(frame({ event: "deleted" }));
	h.client.handleLine(frame({ paths: [] }));
	h.client.handleLine(frame({ paths: "src" }));
	h.client.handleLine(frame({ paths: ["x".repeat(5000)] }));
	assert.deepEqual(h.events, [], "一个坏帧都不该送达");
	assert.ok(h.diagnostics.length >= 6, `每个坏帧都要留一条诊断，实际 ${h.diagnostics.length}`);
	for (const entry of h.diagnostics) assert.equal(entry.code, "REMOTE_FRAME_INVALID", entry.code);
});

test("事件观察者抛错不会打断帧处理", async () => {
	const h = harness({
		onEvent: () => {
			throw new Error("observer exploded");
		},
	});
	const generation = h.client.openConnection();
	const pending = h.client.request("fs.watch", { paths: [""] });
	const requestId = JSON.parse(h.sent[0]).id;
	h.client.handleLine(JSON.stringify({ v: 1, hostId: HOST, generation, watchId: "w1", event: "changed", paths: [""] }));
	h.client.handleLine(JSON.stringify({ v: 1, hostId: HOST, generation, id: requestId, ok: true, result: { watchId: "w1", paths: 1 } }));
	assert.deepEqual(plain(await pending), { watchId: "w1", paths: 1 }, "观察者炸掉之后，下一个应答仍然结算");
});
