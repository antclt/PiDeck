import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { localExpandedDirKey, localExpandedDirRelative } = loadTsCommonJs("src/renderer/src/utils/localFileTreeKeys.ts");

test("本机展开键与 FileTreeNodeRow 的 project 身份一致", () => {
	assert.equal(localExpandedDirKey("p", "src/components"), "project:p\u0000src/components");
	assert.equal(localExpandedDirKey("p", ""), "project:p\u0000");
	assert.equal(localExpandedDirRelative("project:p\u0000src/components"), "src/components");
	assert.equal(localExpandedDirRelative("project:p\u0000"), "");
});

test("relative: 过渡键仍可解析", () => {
	assert.equal(localExpandedDirRelative("relative:src/a"), "src/a");
});

test("无法识别的旧绝对路径不猜成相对路径", () => {
	assert.equal(localExpandedDirRelative("/home/dev/project/src"), undefined);
});
