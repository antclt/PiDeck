import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { LiveStreamChannel } = loadTsCommonJs("src/main/pi/liveStreamChannel.ts");
const { agentEventTags } = loadTsCommonJs("src/shared/ipc.ts");

/**
 * 思考展示净化在「live 通道」的落点（对齐 DSH 0.2.1-rc.5 的 reasoningText）：
 * 供应商把思维签名拼在推理正文开头时，界面只能看到正文；且增量基准必须建立在
 * 净化后的文本上——否则签名未闭合期间发布的空展示会被当成「非 append」，等签名
 * 闭合那一帧起每 100ms 都发一次全量快照。
 */

function createChannel() {
	const emitted = [];
	const channel = new LiveStreamChannel({
		emit: (channelName, payload) => void emitted.push({ channelName, payload }),
		onTextStreamPushed: () => {},
		streamRuntimeTriple: () => ({}),
		ensureSegmentMount: () => "msg-1",
	});
	const agent = "agent-1";
	const frames = () => emitted.filter((entry) => entry.channelName === agentEventTags.agentsThinking).map((entry) => entry.payload);
	return { channel, agent, frames };
}

/** 一次 thinking flush：与 AgentManager 一致，先落累积再经节流器 flush。 */
function pushDelta(channel, agent, delta) {
	channel.pushThinkingDelta(agent, delta);
	channel.thinkingEmitter.flush(agent);
}

test("签名未闭合期间不下发签名正文，界面拿到的展示文本恒为空", () => {
	const { channel, agent, frames } = createChannel();
	pushDelta(channel, agent, "<sig");
	pushDelta(channel, agent, "nature>c2lnbmF0dXJl");
	pushDelta(channel, agent, "bW9yZQ==");

	const thinking = frames();
	assert.equal(thinking.length, 3);
	for (const frame of thinking) {
		assert.equal(frame.text ?? frame.delta, "");
		assert.doesNotMatch(String(frame.text ?? frame.delta), /signature|c2lnbmF0dXJl/);
	}
	// 累积原文仍保留签名（只做展示净化，不影响终态归属与后续解析）
	assert.equal(channel.getThinking(agent), "<signature>c2lnbmF0dXJlbW9yZQ==");
});

test("签名闭合后正文按 delta 增量下发（增量基准建立在净化后的文本上）", () => {
	const { channel, agent, frames } = createChannel();
	pushDelta(channel, agent, "<signature>c2lnbmF0dXJl</signature>\n先想");
	pushDelta(channel, agent, "一下");

	const thinking = frames();
	assert.deepEqual(
		thinking.map((frame) => frame.delta ?? frame.text),
		["先想", "一下"],
	);
	// 没有一帧退化成全量快照（全量帧带 text、不带 delta）
	assert.ok(thinking.every((frame) => frame.text === undefined));
	assert.equal(thinking[0].id, `msg-thinking-msg-1`);
	assert.equal(thinking[0].done, false);
});

test("整段思考只有签名时，终态 done 帧不发签名原文", () => {
	const { channel, agent, frames } = createChannel();
	pushDelta(channel, agent, "<signature>c2lnbmF0dXJl</signature>");
	channel.markThinkingSegmentEnded(agent);
	channel.finishThinkingChannel(agent);

	const thinking = frames();
	const last = thinking[thinking.length - 1];
	assert.equal(last.done, true);
	assert.equal(last.text, "");
});

test("finishThinkingChannel 的终态文本是净化后的完整正文", () => {
	const { channel, agent, frames } = createChannel();
	pushDelta(channel, agent, "<signature>c2lnbmF0dXJl</signature>\n第一段\n第二段");
	channel.finishThinkingChannel(agent);

	const last = frames().at(-1);
	assert.equal(last.done, true);
	assert.equal(last.text, "第一段\n第二段");
});
