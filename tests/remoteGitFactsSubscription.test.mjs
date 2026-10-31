import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { subscribeRemoteGitFacts } = loadTsCommonJs("src/renderer/src/utils/remoteGitFactsSubscription.ts");

function harness() {
	const calls = [];
	let listener = null;
	let unsubscribed = false;
	const api = {
		onProjectFactsChanged(projectId, callback) {
			calls.push(projectId);
			listener = callback;
			return () => {
				unsubscribed = true;
			};
		},
	};
	return {
		api,
		calls,
		emit: (change) => listener(change),
		isUnsubscribed: () => unsubscribed,
	};
}

test("只有当前仓库的 status 通知触发强制重读", () => {
	const testHarness = harness();
	const refreshes = [];
	const off = subscribeRemoteGitFacts(testHarness.api, "project-1", "", (force) => refreshes.push(force));
	assert.deepEqual(testHarness.calls, ["project-1"]);

	testHarness.emit({ projectId: "project-1", generation: "g1", scopes: [{ kind: "dir", path: "" }] });
	assert.deepEqual(refreshes, [], "目录事件不应刷新 Git 面板");

	testHarness.emit({ projectId: "project-1", generation: "g1", scopes: [{ kind: "status", repoPath: "packages/a" }] });
	assert.deepEqual(refreshes, [], "其它仓库的 status 与本面板无关");

	testHarness.emit({ projectId: "project-1", generation: "g1", scopes: [{ kind: "status", repoPath: "" }] });
	assert.deepEqual(refreshes, [true], "当前仓库的 status 必须强制越过暖事实重读");

	off();
	assert.equal(testHarness.isUnsubscribed(), true);
});

test("仓库 scope 精确比较，不做前缀/大小写归一", () => {
	const testHarness = harness();
	const refreshes = [];
	subscribeRemoteGitFacts(testHarness.api, "p", "a/b", (force) => refreshes.push(force));
	testHarness.emit({ projectId: "p", generation: "", scopes: [{ kind: "status", repoPath: "a" }] });
	testHarness.emit({ projectId: "p", generation: "", scopes: [{ kind: "status", repoPath: "a/b/c" }] });
	assert.deepEqual(refreshes, []);
	testHarness.emit({ projectId: "p", generation: "", scopes: [{ kind: "status", repoPath: "a/b" }] });
	assert.deepEqual(refreshes, [true]);
});
