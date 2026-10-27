import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isValidNewLeaf, joinRemotePath, remoteParentPath, remotePathSegments } = loadTsCommonJs("src/renderer/src/components/sidebar/remoteDirectoryPath.ts");

test("parent and join keep POSIX roots stable", () => {
	assert.equal(remoteParentPath("/"), "/");
	assert.equal(remoteParentPath("/srv"), "/");
	assert.equal(remoteParentPath("/srv/app"), "/srv");
	assert.equal(joinRemotePath("/", "app"), "/app");
	assert.equal(joinRemotePath("/srv", "app"), "/srv/app");
});

test("breadcrumbs carry the full path for each segment", () => {
	// VM 模块返回的数组与测试文件不同 realm，按 JSON 比较。
	assert.equal(JSON.stringify(remotePathSegments("/srv/app")), JSON.stringify([
		{ path: "/", label: "/" },
		{ path: "/srv", label: "srv" },
		{ path: "/srv/app", label: "app" },
	]));
});

test("new folder names are single safe segments", () => {
	for (const value of ["app", "my-app", ".env"]) assert.equal(isValidNewLeaf(value), true, value);
	for (const value of ["", ".", "..", "a/b", "a\b", "bad\u0007", "x".repeat(256)]) assert.equal(isValidNewLeaf(value), false, JSON.stringify(value));
});
