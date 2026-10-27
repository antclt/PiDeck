import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 与 piRpcClientTimeout.test.mjs 同一加载理由：参数属性等 TS 语法需编译加载。
const { PiRpcClient, MAX_RPC_LINE_BYTES } = loadTsCommonJs("src/main/pi/PiRpcClient.ts");

function createClient() {
	const stdin = new Writable({ write: (_chunk, _enc, cb) => cb() });
	const stdout = new PassThrough();
	const client = new PiRpcClient(stdin, stdout);
	return { client, stdout };
}

test("无换行的失控输出触发 protocol-error 并清空行缓冲", async () => {
	const { client, stdout } = createClient();
	const errors = [];
	client.on("protocol-error", (line) => errors.push(String(line)));
	stdout.write("x".repeat(MAX_RPC_LINE_BYTES + 1024));
	await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
	assert.equal(errors.length, 1);
	assert.match(errors[0], /rpc line buffer overflow: dropped \d+ bytes without newline/);
});

test("超过旧 8 MiB 上限的合法大帧不再被当污染丢弃", async () => {
	const written = [];
	const stdin = new Writable({
		write: (chunk, _enc, cb) => {
			written.push(String(chunk));
			cb();
		},
	});
	const stdout = new PassThrough();
	const client = new PiRpcClient(stdin, stdout);
	const errors = [];
	client.on("protocol-error", (line) => errors.push(String(line)));
	const pending = client.request({ type: "get_entries" }, 5_000);
	const { id } = JSON.parse(written[0]);
	// 12 MiB 是「一张内联 base64 图片 + 历史」的量级：超过旧 8 MiB 上限，仍是合法帧
	const payload = "A".repeat(12 * 1024 * 1024);
	stdout.write(`${JSON.stringify({ id, type: "response", command: "get_entries", success: true, data: payload })}\n`);
	const response = await pending;
	assert.equal(errors.length, 0, "合法大帧不得报协议错误");
	assert.equal(response.id, id);
	assert.equal(response.data.length, payload.length);
});

test("超限清空后，后续正常 JSONL 行仍能解析派发", async () => {
	const { client, stdout } = createClient();
	const errors = [];
	client.on("protocol-error", (line) => errors.push(String(line)));
	stdout.write("x".repeat(MAX_RPC_LINE_BYTES + 1024));
	await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
	stdout.end('{"id":"cap-recovery","type":"response","result":{"ok":true}}\n');
	await new Promise((resolve) => setTimeout(resolve, 30));
	// 恢复路径只应保留最初那一次协议错误，且恢复行不得再被污染缓冲拖垮
	assert.equal(errors.length, 1);
});

test("超长帧之后从下一个 LF 重新对齐，后续帧不再永久错位", async () => {
	const { client, stdout } = createClient();
	const errors = [];
	const events = [];
	client.on("protocol-error", (line) => errors.push(String(line)));
	client.on("event", (event) => events.push(event));
	// 帧头带 type/command：诊断信息要能定位是哪一类消息把帧撑爆
	stdout.write('{"type":"response","command":"get_entries","data":"');
	stdout.write("x".repeat(MAX_RPC_LINE_BYTES + 1024));
	// 一个 LF 结束超长帧，其后的帧是下一帧（修复前这里开始全部错位）
	stdout.write('\n{"type":"agent_start"}\n{"type":"agent_end"}\n');
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(errors.length, 1, "一次溢出只报一次协议错误");
	assert.match(errors[0], /dropped \d+ bytes without newline/);
	assert.match(errors[0], /frame: type=response command=get_entries/);
	assert.deepEqual(
		events.map((event) => event.type),
		["agent_start", "agent_end"],
	);
});
