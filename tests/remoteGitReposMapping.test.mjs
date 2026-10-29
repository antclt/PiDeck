import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { repositoryListingToSelector } = loadTsCommonJs("src/renderer/src/utils/remoteGitRepos.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("选择器只取项目相对路径与显示名，截断标记原样保留", () => {
	const listing = {
		repos: [
			{ target: { projectId: "p", relativePath: "" }, relativePath: "", displayPath: "(root)", name: "repo", path: "/abs/ignored" },
			{ target: { projectId: "p", relativePath: "packages/a" }, relativePath: "packages/a", displayPath: "packages/a", name: "a" },
		],
		truncated: true,
		revision: 3,
		generation: "g1",
	};
	assert.deepEqual(plain(repositoryListingToSelector(listing)), {
		repos: [
			{ path: "", name: "repo" },
			{ path: "packages/a", name: "a" },
		],
		truncated: true,
	});
	// 输入不被修改：列表是事实，选择器只是投影。
	assert.equal(listing.repos.length, 2);
	assert.equal(listing.repos[0].path, "/abs/ignored");
});

test("空仓库列表仍是空数组，不伪造根仓", () => {
	assert.deepEqual(plain(repositoryListingToSelector({ repos: [], truncated: false, revision: 1, generation: "local" })), { repos: [], truncated: false });
});
