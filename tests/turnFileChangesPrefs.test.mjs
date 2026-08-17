import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	MAX_VISIBLE_FILES,
	fileChangesPrefKey,
	readFileChangesPref,
	writeFileChangesPref,
	visibleFileCount,
} = loadTsCommonJs("src/renderer/src/components/session/turn/fileChangesUiState.ts");

const run = (id, startedAt) => ({ kind: "agent-run", id, items: [], startedAt, endedAt: startedAt + 1 });

test("fileChangesPrefKey：同一 run 稳定、不同 run 不冲突", () => {
	const key = fileChangesPrefKey(run("run-1", 1000));
	assert.equal(key, fileChangesPrefKey(run("run-1", 1000)));
	// startedAt 不同 → key 不同（防跨会话同 id 碰撞）
	assert.notEqual(key, fileChangesPrefKey(run("run-1", 2000)));
	assert.notEqual(key, fileChangesPrefKey(run("run-2", 1000)));
});

test("read/writeFileChangesPref：写后读回原值，未写时返回 undefined", () => {
	const key = fileChangesPrefKey(run("run-1", 1000));
	assert.equal(readFileChangesPref(key), undefined);
	writeFileChangesPref(key, { collapsed: true, showAll: true });
	const stored = readFileChangesPref(key);
	assert.equal(stored.collapsed, true);
	assert.equal(stored.showAll, true);
});

test("visibleFileCount：默认截断到 MAX_VISIBLE_FILES，展开全部后全量", () => {
	assert.equal(visibleFileCount(12, false), MAX_VISIBLE_FILES);
	assert.equal(visibleFileCount(12, true), 12);
	// 不超过上限时原样返回，不出现无意义的截断按钮
	assert.equal(visibleFileCount(3, false), 3);
	assert.equal(visibleFileCount(0, false), 0);
});