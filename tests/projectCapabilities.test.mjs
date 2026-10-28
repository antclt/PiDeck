import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveProjectCapabilities, PROJECT_CAPABILITY_REASONS, isLiveHostState, isWritableHostState } = loadTsCommonJs("src/shared/projectCapabilities.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * 能力快照（v5 §2 硬规定 3）：修的是 R3——同一个 host 在设置页算「已连接」、在 Git 面板算「未就绪」。
 * 这组用例把唯一的那份判定钉死，以后任何界面都只能读它。
 */
test("本机项目：读写/Git 全开，不涉及远端状态", () => {
	assert.deepEqual(plain(resolveProjectCapabilities({ locationKind: "local", hostState: "local" })), {
		locationKind: "local",
		readFiles: true,
		writeFiles: true,
		gitRead: true,
		gitWrite: true,
		ignore: "git",
		watch: false,
	});
});

test("ssh + ready：全开；watch 只看 helper 有没有声明 fs.watch", () => {
	assert.deepEqual(plain(resolveProjectCapabilities({ locationKind: "ssh", hostState: "ready", helperCapabilities: ["echo", "fs.stat", "fs.watch"] })), {
		locationKind: "ssh",
		readFiles: true,
		writeFiles: true,
		gitRead: true,
		gitWrite: true,
		ignore: "git",
		watch: true,
	});

	const noWatch = plain(resolveProjectCapabilities({ locationKind: "ssh", hostState: "ready", helperCapabilities: ["echo"] }));
	assert.equal(noWatch.watch, false);
	assert.equal(noWatch.reason, PROJECT_CAPABILITY_REASONS.helperNoWatch);
	assert.equal(noWatch.writeFiles, true, "没有 watch 不影响写面");
});

test("ssh + degraded：读留下、写关掉（写错是数据损坏）", () => {
	const degraded = plain(resolveProjectCapabilities({ locationKind: "ssh", hostState: "degraded" }));
	assert.equal(degraded.readFiles, true);
	assert.equal(degraded.gitRead, true);
	assert.equal(degraded.writeFiles, false);
	assert.equal(degraded.gitWrite, false);
	assert.equal(degraded.reason, PROJECT_CAPABILITY_REASONS.hostDegraded);
});

test("其它任何状态：全部关闭，并给出稳定原因", () => {
	for (const hostState of ["disconnected", "connecting", "probing", "bootstrapping", "reconnecting", "offline", "needs-attention"]) {
		const capabilities = plain(resolveProjectCapabilities({ locationKind: "ssh", hostState }));
		assert.equal(capabilities.readFiles, false, hostState);
		assert.equal(capabilities.writeFiles, false, hostState);
		assert.equal(capabilities.gitRead, false, hostState);
		assert.equal(capabilities.reason, PROJECT_CAPABILITY_REASONS.hostNotReady, hostState);
		// 没有连接就判定不了 .gitignore：退回内置规则，而不是假装有 git 权威。
		assert.equal(capabilities.ignore, "builtin", hostState);
	}
});

test("同一组输入永远同一个答案（纯函数，可在任何层复用）", () => {
	const input = { locationKind: "ssh", hostState: "ready", helperCapabilities: ["fs.watch"] };
	assert.deepEqual(plain(resolveProjectCapabilities(input)), plain(resolveProjectCapabilities(input)));
});

test("「已连接」与「可写」各只有一个判据：设置页与远端面板不再各算一套", () => {
	// 设置页徽标/进度条：会话还活着就算已连接。
	for (const state of ["ready", "degraded"]) assert.equal(isLiveHostState(state), true, state);
	for (const state of ["disconnected", "connecting", "probing", "bootstrapping", "reconnecting", "offline", "needs-attention"]) assert.equal(isLiveHostState(state), false, state);
	// 写面：只认 ready（degraded 的会话不健康，写错是数据损坏）。
	assert.equal(isWritableHostState("ready"), true);
	assert.equal(isWritableHostState("degraded"), false);
	// 两个判据必须与能力表自洽：degraded ⇒ 读开写关。
	const degraded = resolveProjectCapabilities({ locationKind: "ssh", hostState: "degraded" });
	assert.equal(degraded.readFiles, isLiveHostState("degraded"));
	assert.equal(degraded.writeFiles, isWritableHostState("degraded"));
});
