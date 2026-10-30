/**
 * 右抽屉 Git 仓库作用域下发（GIT_PROJECT_TARGET_MISMATCH 回归）：
 *
 * 1. 切项目时 GitDrawerHost / GitPanel 复用同一实例，仓库列表要等一次 listRepos IPC 才回来；
 *    这期间 scope 里仍是上一项目的仓库，其 target.projectId 属于旧项目。
 * 2. 把这种 target 下发给面板，主进程 parseGitProjectTarget 会抛 GIT_PROJECT_TARGET_MISMATCH，
 *    变更区挂出一条退不掉的错误（silent 轮询不改错误文本）。
 * 3. reposForProject 只放行当前项目的条目；全量命中时保持原引用，避免下游 effect 白跑。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const load = (relativePath) => loadTsCommonJs(`${ROOT}/${relativePath}`);
const readSource = (relativePath) => readFileSync(`${ROOT}/${relativePath}`, "utf8");

const { reposForProject } = load("src/renderer/src/utils/gitRepoScope.ts");

/** 形状完整的 GitRepoInfo：纯函数只读 target，仍避免半截对象混进断言 */
const repo = (projectId, relativePath = "") => ({
	target: { projectId, relativePath },
	relativePath,
	displayPath: relativePath,
	name: relativePath.split("/").pop() || "root",
});

test("切项目瞬间不把上一项目的仓库下发给面板", () => {
	// 上一项目的 scope 还没被新列表替换：旧 target 一律丢弃，面板回落到未绑定仓库的根作用域。
	// spread 回主 realm 再比较：src 经 vm 加载，返回数组的原型属于测试沙箱。
	assert.deepEqual([...reposForProject("project-b", [repo("project-a")])], []);
	assert.deepEqual([...reposForProject("project-b", [repo("project-a", ""), repo("project-a", "packages/app")])], []);
});

test("多仓列表里混入跨项目条目时只保留当前项目", () => {
	const mine = [repo("project-b", ""), repo("project-b", "vendor/lib")];
	const mixed = [repo("project-a"), ...mine];
	const scoped = reposForProject("project-b", mixed);
	assert.deepEqual(
		[...scoped].map((item) => item.target.relativePath),
		["", "vendor/lib"],
	);
	// 过滤结果必须是当前项目的条目本身（引用相等），不是重建对象
	assert.equal(scoped[0], mine[0]);
	assert.equal(scoped[1], mine[1]);
});

test("全量命中时保持原数组引用（下游 effect 依赖 repos 身份）", () => {
	const list = [repo("project-b"), repo("project-b", "packages/app")];
	assert.equal(reposForProject("project-b", list), list);
});

test("没有当前项目时返回空列表，空列表共享同一引用", () => {
	assert.deepEqual([...reposForProject(undefined, [repo("project-a")])], []);
	const empty = [];
	assert.equal(reposForProject("project-a", empty), reposForProject("project-b", empty));
});

test("useGitRepoScope 下发的仓库列表经过 reposForProject 过滤", () => {
	const source = readSource("src/renderer/src/hooks/useGitRepoScope.ts");
	assert.match(source, /import \{ reposForProject \} from "\.\.\/utils\/gitRepoScope"/);
	assert.match(source, /const repos = reposForProject\(projectId, discoveredRepos\);/);
	assert.match(source, /hasMultipleRepos: repos\.length > 1,/);
});

test("GitPanel 在静默刷新成功时清掉上一次的失败横幅", () => {
	const source = readSource("src/renderer/src/components/app/GitPanel.tsx");
	assert.match(source, /setError\(\(current\) => \(current \? null : current\)\);/);
});
