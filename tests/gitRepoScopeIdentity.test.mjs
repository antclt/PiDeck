import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { reposForProject } from "../src/renderer/src/utils/gitRepoScope.ts";

/** 造一条仓库发现结果：只填 reposForProject 用到的字段。 */
function repo(projectId, relativePath, name = relativePath || "root") {
	return { target: { projectId, relativePath }, relativePath, displayPath: relativePath, name };
}

describe("reposForProject 身份稳定（防 GitDrawerHost 无限 setState / React #185）", () => {
	test("全部属于当前项目时直接返回原引用", () => {
		const repos = [repo("p1", ""), repo("p1", "packages/api")];
		assert.equal(reposForProject("p1", repos), repos);
	});

	test("发生过过滤时，同输入两次调用仍是同一个引用", () => {
		// 这是回归守护：过滤出新数组会让 GitDrawerHost 的 effect 依赖每渲染都变，
		// effect → setState → 重渲染 → 依赖又变，最终抛 Maximum update depth exceeded。
		const repos = [repo("p1", ""), repo("p0", "legacy"), repo("p1", "packages/api")];
		const first = reposForProject("p1", repos);
		const second = reposForProject("p1", repos);
		assert.equal(first, second);
	});

	test("过滤语义不变：丢掉跨项目条目，顺序保持", () => {
		const repos = [repo("p1", ""), repo("p0", "legacy"), repo("p1", "packages/api")];
		assert.deepEqual(
			reposForProject("p1", repos).map((item) => item.relativePath),
			["", "packages/api"],
		);
	});

	test("换 projectId 会重新计算，不串缓存", () => {
		const repos = [repo("p1", ""), repo("p2", "packages/api")];
		assert.deepEqual(
			reposForProject("p1", repos).map((item) => item.relativePath),
			[""],
		);
		assert.deepEqual(
			reposForProject("p2", repos).map((item) => item.relativePath),
			["packages/api"],
		);
	});

	test("仓库列表换引用就重算（缓存以引用为键，不会读到旧内容）", () => {
		const before = [repo("p1", ""), repo("p0", "legacy")];
		const after = [repo("p1", ""), repo("p1", "packages/api")];
		assert.deepEqual(
			reposForProject("p1", before).map((item) => item.relativePath),
			[""],
		);
		assert.deepEqual(
			reposForProject("p1", after).map((item) => item.relativePath),
			["", "packages/api"],
		);
	});

	test("空列表或缺少 projectId 都返回同一个空数组", () => {
		const empty = reposForProject("p1", []);
		assert.deepEqual(empty, []);
		assert.equal(reposForProject(undefined, [repo("p1", "")]), empty);
		assert.equal(reposForProject("", [repo("p1", "")]), empty);
	});
});
