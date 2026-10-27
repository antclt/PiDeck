import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * F2a：重复取消合并（docs/remote-functional-optimization-plan.md §3 F2）。
 *
 * 修复前对同一个未回复请求连发 256 次 `cancel()` 会得到 257 个 pending、256 条 cancel 帧与 257 个
 * timer；这里把它固化成有界合并：一条在途 cancel 帧、一个共享结果，目标结算或断开时全部归零。
 */
const { createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");
const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";

/** Deterministic clock + timer table: no real deadlines, and leftover timers are observable. */
function harness() {
	const frames = [];
	const timers = new Set();
	const client = createRemoteControlClient({
		hostId: HOST_ID,
		send: (line) => frames.push(JSON.parse(line)),
		now: () => 0,
		scheduler: {
			setTimeout(fn) {
				const timer = { fn };
				timers.add(timer);
				return timer;
			},
			clearTimeout(timer) {
				timers.delete(timer);
			},
		},
	});
	client.openConnection();
	return { client, frames, timers };
}

const frameMethod = (frame) => frame.method;
const cancelFrames = (frames) => frames.filter((frame) => frameMethod(frame) === "cancel");

test("repeated cancels of one request share a single in-flight cancel frame and timer", async () => {
	const { client, frames, timers } = harness();
	const target = client.request("echo", {}).catch((error) => error.code);
	const targetId = frames[0].id;
	const cancels = [];
	for (let index = 0; index < 256; index += 1) cancels.push(client.cancel(targetId).catch((error) => error.code));
	// One ordinary request + one withdrawal: the storm is coalesced instead of stacking 256 timers.
	assert.equal(client.pendingCount(), 2);
	assert.equal(cancelFrames(frames).length, 1);
	assert.equal(timers.size, 2);

	// The helper answers the single cancel frame; every caller sees the same combined result.
	for (const frame of cancelFrames(frames)) client.handleLine(JSON.stringify({ v: 1, hostId: HOST_ID, generation: client.connectionGeneration, id: frame.id, ok: true, result: { cancelled: true } }));
	const results = await Promise.all(cancels);
	assert.deepEqual(
		results.map((result) => JSON.parse(JSON.stringify(result))),
		Array.from({ length: 256 }, () => ({ cancelled: true })),
	);
	assert.equal(await target, "REQUEST_CANCELLED");
	assert.equal(client.pendingCount(), 0);
	assert.equal(timers.size, 0);

	client.closeConnection();
	assert.equal(client.pendingCount(), 0);
	assert.equal(timers.size, 0);
});

test("a repeated cancel after the target settled answers already-settled without a second frame", async () => {
	const { client, frames, timers } = harness();
	const pending = client.request("echo", {});
	const targetId = frames[0].id;
	client.handleLine(JSON.stringify({ v: 1, hostId: HOST_ID, generation: client.connectionGeneration, id: targetId, ok: true, result: { pong: true } }));
	assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { pong: true });
	for (let index = 0; index < 8; index += 1) assert.deepEqual(JSON.parse(JSON.stringify(await client.cancel(targetId))), { cancelled: false, reason: "already-settled" });
	assert.equal(cancelFrames(frames).length, 0, "a settled target never needs a withdrawal frame");
	assert.equal(client.pendingCount(), 0);
	assert.equal(timers.size, 0);
});

test("cancel entries are not cancellable, so withdrawals cannot nest into unbounded growth", async () => {
	const { client, frames, timers } = harness();
	const pending = client.request("echo", {}).catch((error) => error.code);
	const targetId = frames[0].id;
	const withdrawal = client.cancel(targetId);
	const cancelId = cancelFrames(frames)[0].id;
	assert.deepEqual(JSON.parse(JSON.stringify(await client.cancel(cancelId))), { cancelled: false, reason: "already-settled" });
	assert.equal(cancelFrames(frames).length, 1, "cancelling a withdrawal must not put another frame on the wire");
	for (const frame of cancelFrames(frames)) client.handleLine(JSON.stringify({ v: 1, hostId: HOST_ID, generation: client.connectionGeneration, id: frame.id, ok: true, result: { cancelled: true } }));
	assert.deepEqual(JSON.parse(JSON.stringify(await withdrawal)), { cancelled: true });
	assert.equal(await pending, "REQUEST_CANCELLED");
	assert.equal(client.pendingCount(), 0);
	assert.equal(timers.size, 0);
});

test("a full ordinary request table still admits a cancel and releases every waiter", async () => {
	const { client, frames, timers } = harness();
	const requests = [];
	for (let index = 0; index < 128; index += 1) requests.push(client.request("echo", {}).catch((error) => error.code));
	assert.equal(client.pendingCount(), 128);
	await assert.rejects(client.request("echo", {}), /REMOTE_REQUEST_LIMIT/);
	const targetId = frames[0].id;
	const cancels = [client.cancel(targetId), client.cancel(targetId), client.cancel(targetId)];
	assert.equal(cancelFrames(frames).length, 1, "the withdrawal still fits when the ordinary table is saturated");
	for (const frame of cancelFrames(frames)) client.handleLine(JSON.stringify({ v: 1, hostId: HOST_ID, generation: client.connectionGeneration, id: frame.id, ok: true, result: { cancelled: true } }));
	await Promise.all(cancels);
	assert.equal(await requests[0], "REQUEST_CANCELLED");
	assert.equal(client.pendingCount(), 127);
	client.closeConnection();
	await Promise.all(requests);
	assert.equal(client.pendingCount(), 0);
	assert.equal(timers.size, 0);
});

test("connection close releases a pending withdrawal instead of leaving its timer behind", async () => {
	const { client, frames, timers } = harness();
	const pending = client.request("echo", {}).catch((error) => error.code);
	const cancels = [client.cancel(frames[0].id).catch((error) => error.code), client.cancel(frames[0].id).catch((error) => error.code)];
	client.closeConnection();
	assert.deepEqual(await Promise.all(cancels), ["REMOTE_CONNECTION_LOST", "REMOTE_CONNECTION_LOST"]);
	assert.equal(await pending, "REMOTE_CONNECTION_LOST");
	assert.equal(client.pendingCount(), 0);
	assert.equal(timers.size, 0);
	// A new generation starts with an empty withdrawal table: the old promises are never reused.
	client.openConnection();
	assert.equal(frames.length, 2, "only the original request and one cancel frame were ever written");
});
