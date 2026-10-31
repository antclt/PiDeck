import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

const BASE = "refs/heads/main";
const HEAD = "refs/heads/topic";
const oid = (letter) => letter.repeat(40);

function harness(api) {
	const states = [];
	const controller = createRemoteGitViewController("project-1", "key-1", api, (state) => states.push(state), "");
	return { controller, states, last: () => states.at(-1) };
}

test("公共 compareRefs 的 trees 结果映射到面板的两端与文件", async () => {
	const calls = [];
	const testHarness = harness({
		compareRefs: async (projectId, base, head, repo) => {
			calls.push({ projectId, base, head, repo });
			return {
				ok: true,
				value: {
					mode: "trees",
					base: { ref: BASE, oid: oid("a") },
					head: { ref: HEAD, oid: oid("b") },
					files: [
						{ status: "M", path: "src/a.ts" },
						{ status: "R", path: "src/b.ts", oldPath: "src/old.ts" },
					],
				},
			};
		},
	});
	await testHarness.controller.runCompare(BASE, HEAD);
	assert.deepEqual(plain(calls), [{ projectId: "project-1", base: BASE, head: HEAD, repo: { projectId: "project-1", relativePath: "" } }]);
	const compare = testHarness.last().compare;
	assert.deepEqual(plain(compare.base), { ref: BASE, oid: oid("a") });
	assert.deepEqual(plain(compare.head), { ref: HEAD, oid: oid("b") });
	assert.deepEqual(plain(compare.files), [
		{ status: "M", path: "src/a.ts" },
		{ status: "R", path: "src/b.ts", oldPath: "src/old.ts" },
	]);
	assert.equal(testHarness.last().compareLoading, false);
});

test("回显的 ref 不是用户点的那一对时报资源已变，不展示错配答案", async () => {
	const testHarness = harness({
		compareRefs: async () => ({
			ok: true,
			value: { mode: "trees", base: { ref: "refs/heads/other", oid: oid("a") }, head: { ref: HEAD, oid: oid("b") }, files: [] },
		}),
	});
	await testHarness.controller.runCompare(BASE, HEAD);
	assert.equal(testHarness.last().compare, undefined);
	assert.equal(testHarness.last().compareErrorCode, "GIT_RESOURCE_CHANGED");
});

test("没有 compareRefs 时继续走旧的 remoteCompare（迁移期兼容壳）", async () => {
	const calls = [];
	const testHarness = harness({
		remoteCompare: async (projectId, base, head, repo) => {
			calls.push({ projectId, base, head, repo });
			return { ok: true, compare: { base: { ref: base, oid: oid("a") }, head: { ref: head, oid: oid("b") }, files: [] } };
		},
	});
	await testHarness.controller.runCompare(BASE, HEAD);
	assert.deepEqual(plain(calls), [{ projectId: "project-1", base: BASE, head: HEAD, repo: "" }]);
	assert.equal(testHarness.last().compareErrorCode, undefined);
});
