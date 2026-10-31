/**
 * 远端 Git 能力说明条（task-5）的行为回归。
 *
 * 只验证用户能看到什么：纯函数按上下文决定是否显示；组件用 server render 断言文本与 data-testid。
 * 不新增 source-scan 测试（check:test-shape 会拦）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { shouldShowRemoteGitCapabilityNote } = loadTsCommonJs("src/renderer/src/utils/remoteGitCapabilityNotes.ts");
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");
const { RemoteGitCapabilityNote } = loadTsCommonJs("src/renderer/src/components/workspace/RemoteGitCapabilityNote.tsx", {
	stubs: { react: React },
});

const renderNote = (kind, context) => renderToStaticMarkup(React.createElement(RemoteGitCapabilityNote, { kind, context }));

test("说明条判据：按上下文显示，缺能力时不伪造入口", () => {
	assert.equal(shouldShowRemoteGitCapabilityNote("history", {}), false);
	assert.equal(shouldShowRemoteGitCapabilityNote("history", { historyOpen: true }), true);
	assert.equal(shouldShowRemoteGitCapabilityNote("commit", {}), false);
	assert.equal(shouldShowRemoteGitCapabilityNote("commit", { commitVisible: true }), true);
	assert.equal(shouldShowRemoteGitCapabilityNote("repoScope", { repoCount: 1 }), false);
	assert.equal(shouldShowRemoteGitCapabilityNote("repoScope", { repoCount: 2 }), true);
	assert.equal(shouldShowRemoteGitCapabilityNote("compare", { compareOpen: true, compareMode: "merge-base" }), false, "merge-base 有 ahead/behind，不需要 trees-only 说明");
	assert.equal(shouldShowRemoteGitCapabilityNote("compare", { compareOpen: true, compareMode: "trees" }), true);
	assert.equal(shouldShowRemoteGitCapabilityNote("compare", { compareMode: "trees" }), false, "未展开对比时不占位置");
});

test("history 说明条：HEAD-only、无过滤/总数/提交图", () => {
	const html = renderNote("history", { historyOpen: true });
	assert.match(html, /data-testid="remote-git-capability-note-history"/);
	assert.match(html, /HEAD/);
	assert.match(html, /提交总数|total count/);
	assert.match(html, /提交图|commit graph/);
});

test("commit 说明条：逐文件暂存、无批量/智能/AI", () => {
	const html = renderNote("commit", { commitVisible: true });
	assert.match(html, /data-testid="remote-git-capability-note-commit"/);
	assert.match(html, /批量暂存/);
	assert.match(html, /AI/);
	assert.match(html, /智能提交/);
});

test("repoScope 说明条：只在多仓时出现，明确一次一个仓", () => {
	assert.equal(renderNote("repoScope", { repoCount: 1 }), "");
	const html = renderNote("repoScope", { repoCount: 2 });
	assert.match(html, /data-testid="remote-git-capability-note-repoScope"/);
	assert.match(html, /一次只读一个仓库/);
	assert.match(html, /不能并排/);
});

test("compare 说明条：trees-only，无 merge-base / ahead-behind", () => {
	assert.equal(renderNote("compare", { compareOpen: true, compareMode: "merge-base" }), "");
	const html = renderNote("compare", { compareOpen: true, compareMode: "trees" });
	assert.match(html, /data-testid="remote-git-capability-note-compare"/);
	assert.match(html, /merge-base/);
	assert.match(html, /ahead／behind|ahead\/behind/);
});

test("多仓说明 key 在中英词典都存在；compareHint 已改为 trees-only 表述", () => {
	for (const dictionary of [zhCN, enUS]) {
		assert.ok(dictionary["remoteGit.repoScopeSingle"]);
	}
	assert.match(zhCN["remoteGit.compareHint"], /merge-base/);
	assert.match(enUS["remoteGit.compareHint"], /merge-base/);
});
