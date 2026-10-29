import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

const commit = (oid, authorTimeMs) => ({
	oid,
	parents: [],
	subject: `commit ${oid}`,
	authorName: "Dev",
	authorEmail: "dev@example.com",
	authorTimeMs,
});

function harness(historyPage) {
	const calls = [];
	const states = [];
	const api = {
		historyPage: async (projectId, options, repo) => {
			calls.push({ projectId, options, repo });
			return historyPage(projectId, options, repo);
		},
	};
	const controller = createRemoteGitViewController("project-1", "key-1", api, (state) => states.push(state), "");
	const last = () => states.at(-1);
	return { controller, calls, states, last };
}

test("公共 historyPage 的 authorTimeMs 转成面板使用的秒，分页 skip 原样透传", async () => {
	const testHarness = harness(async () => ({ ok: true, value: { commits: [commit("a".repeat(40), 1_700_000_123_456)], hasMore: true } }));
	await testHarness.controller.loadHistory();
	assert.deepEqual(plain(testHarness.calls[0].options), { maxCount: 50 });
	assert.deepEqual(plain(testHarness.calls[0].repo), { projectId: "project-1", relativePath: "" });
	assert.equal(testHarness.last().history.commits[0].authorTimeSec, 1_700_000_123);
	assert.equal(testHarness.last().history.hasMore, true);

	await testHarness.controller.loadMoreHistory();
	assert.deepEqual(plain(testHarness.calls[1].options), { maxCount: 50, skip: 1 });
});

test("增量页失败保留已显示的行；下一次整页加载才替换", async () => {
	let fail = false;
	const testHarness = harness(async (_projectId, options) => {
		if (fail) return { ok: false, code: "SSH_HOST_DISCONNECTED" };
		return { ok: true, value: { commits: [commit("b".repeat(40), 1_700_000_000_000)], hasMore: options.skip === undefined } };
	});
	await testHarness.controller.loadHistory();
	fail = true;
	await testHarness.controller.loadMoreHistory();
	assert.equal(testHarness.last().historyErrorCode, "SSH_HOST_DISCONNECTED");
	assert.equal(testHarness.last().history.commits.length, 1);
	assert.equal(testHarness.last().historyLoading, false);
	assert.equal(testHarness.last().historyMoreLoading, false);
});

test("没有 historyPage 时继续走旧的 remoteLog（迁移期兼容壳）", async () => {
	const calls = [];
	const states = [];
	const controller = createRemoteGitViewController(
		"project-1",
		"key-1",
		{
			remoteLog: async (projectId, options, repo) => {
				calls.push({ projectId, options, repo });
				return { ok: true, page: { commits: [{ oid: "c".repeat(40), parents: [], subject: "old", authorName: "Dev", authorEmail: "d@e", authorTimeSec: 5 }], hasMore: false } };
			},
		},
		(state) => states.push(state),
		"",
	);
	await controller.loadHistory();
	assert.deepEqual(plain(calls[0].options), { maxCount: 50 });
	assert.equal(states.at(-1).history.commits[0].authorTimeSec, 5);
});
