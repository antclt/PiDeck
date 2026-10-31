import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { projectFileKey, parseFileTreeKey } = loadTsCommonJs("src/renderer/src/utils/fileTreeLazy.ts");

test("行的 projectFileKey 能还原成 controller 使用的项目相对路径", () => {
	const key = projectFileKey({ projectId: "p", relativePath: "docs" });
	assert.equal(parseFileTreeKey(key).relativePath, "docs");
	assert.equal(parseFileTreeKey(projectFileKey({ projectId: "p", relativePath: "" })).relativePath, "");
});

test("远端文件树在行键与 controller 相对键之间转换，展开/收起/currentDir 不走绝对路径", () => {
	const source = readFileSync("src/renderer/src/hooks/useRemoteFileTree.ts", "utf8");
	// toggle 收到的是 FileTreeNodeRow 的 projectFileKey，必须还原成相对路径再交给 controller。
	assert.match(source, /const relative = parseFileTreeKey\(key\)\?\.relativePath \?\? key;/);
	assert.match(source, /controller\.current\?\.toggle\(relative\)/);
	// 对 UI 暴露的 expanded 必须是 projectFileKey（与行组件一致），不能直接漏出 controller 的相对键。
	assert.match(source, /projectFileKey\(\{ projectId, relativePath: dir \}\)/);
});
