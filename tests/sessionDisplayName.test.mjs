import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { sessionDisplayName } = loadTsCommonJs("src/renderer/src/utils/sessionDisplayName.ts");

test("fork 会话把 (fork) 后缀直接拼进会话名", () => {
	assert.equal(sessionDisplayName("优化下 fork 功能", true), "优化下 fork 功能 (fork)");
});

test("非 fork 会话名字保持原样", () => {
	assert.equal(sessionDisplayName("普通会话", undefined), "普通会话");
	assert.equal(sessionDisplayName("普通会话", false), "普通会话");
});

test("会话名已带 (fork) 后缀时不重复追加", () => {
	assert.equal(sessionDisplayName("优化下 fork 功能 (fork)", true), "优化下 fork 功能 (fork)");
});

test("缺标题时保持原样（由调用方回退 Untitled）", () => {
	assert.equal(sessionDisplayName(undefined, true), undefined);
	assert.equal(sessionDisplayName("", true), "");
});
