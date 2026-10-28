import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitMutationTokens } = loadTsCommonJs("src/main/git/RemoteGitMutationTokens.ts");

/**
 * v3 计划 §4.2 的 `multiRepo: "full" | "single-active-write"` 想要的是"远端只能一个活动写仓库"。
 *
 * 本用例把这条产品的上限钉在**令牌层事实上**：一个窗口 × 一个项目 × 一种动作只有一个活动授权，
 * 且这个唯一性是按 kind 覆盖产生的（`issue` 的替换循环只看 sender/project/kind，不看 repoPath），
 * 不是按仓库分区。因此"并排两个仓库面板各自可写"在今天的令牌契约下不是没做，而是**做不到**。
 *
 * 与 `tests/remoteGitMutationTokens.test.mjs` 的关系：那边把"切 scope 不留旧授权"当作期望行为钉住，
 * 这边钉的是它会撞上的**渲染层后果** —— `GitDrawerHost` 的多仓模式恰恰是把 N 个仓库面板并排挂起来
 * （`scope.hasMultipleRepos` 分支）。计划若要在远端复用这个宿主，必须显式选择：
 * ① 远端不堆叠（单仓 + 仓库下拉，即 RemoteGitPanel 今天的形态）；或
 * ② 改令牌身份：替换与 revoke 都按 (sender, project, repoPath) 分区。
 * 这组断言存在的作用是让 ② 必须显式发生，而不是被当成"顺手统一"。
 */
const base = { kind: "index", revision: "a".repeat(64), hostRevision: 7, target: { hostId: "host", remotePath: "/owned/project" } };
const rootScope = { ...base, repoPath: "" };
const nestedScope = { ...base, repoPath: "packages/nested" };

test("并排两个仓库面板：后读的那个仓库让先读的仓库写授权失效（同 kind 覆盖不看 repoPath）", () => {
	const grants = createRemoteGitMutationTokens();
	// 面板 A：项目根仓库的 snapshot 签出 index/commit 等授权。
	const panelA = grants.issue(1, "project", rootScope);
	// 面板 B：嵌套仓库的 snapshot 签同一 kind —— 这一步就把 A 的同种授权删掉了，不需要任何 revoke。
	const panelB = grants.issue(1, "project", nestedScope);
	assert.throws(() => grants.take(1, "project", "index", "", panelA), /GIT_WRITE_SNAPSHOT_EXPIRED/);
	assert.equal(grants.take(1, "project", "index", "packages/nested", panelB).repoPath, "packages/nested");
});

test("snapshot 入口的统一 revoke 会同时清空同项目的所有仓库授权", () => {
	const grants = createRemoteGitMutationTokens();
	const rootGrant = grants.issue(1, "project", rootScope);
	const nestedGrant = grants.issue(2, "project", nestedScope);
	// git:remote-snapshot 处理器的第一步：tokens.revoke(sender, project)（不带 repoPath）。
	grants.revoke(1, "project");
	assert.throws(() => grants.take(1, "project", "index", "", rootGrant), /GIT_WRITE_SNAPSHOT_EXPIRED/);
	// 只按 sender 分区：别的窗口不受影响。
	assert.equal(grants.take(2, "project", "index", "packages/nested", nestedGrant).repoPath, "packages/nested");
});

test("接线：git:remote-snapshot 在签发前按 (sender, project) 清空，签发循环不按 repoPath 分区", () => {
	const ipc = readFileSync("src/main/ipc/remoteGitReadIpc.ts", "utf8");
	// 两处必须同批改动：这条 revoke 与 RemoteGitMutationTokens.issue 的替换循环。
	assert.match(ipc, /tokens\.revoke\(event\.sender\.id, typeof projectId === "string" \? projectId : ""\)/);
	const tokens = readFileSync("src/main/git/RemoteGitMutationTokens.ts", "utf8");
	assert.match(tokens, /entry\.projectId === projectId && entry\.expected\.kind === expected\.kind/);
});
