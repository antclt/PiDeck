import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 目录浏览是只读探针：不允许变成 helper 的 root 逃逸口，也不把文件内容/大小带回来。
const { REMOTE_LIST_DIRS_LIMIT, assertListablePath, buildListDirectoriesCommand, buildReadHomeCommand, parseDirectoryListing, readRemoteHome } = loadTsCommonJs("src/main/remote/RemoteDirectoryListing.ts");

test("listing paths allow root but reject traversal, trailing separators and control bytes", () => {
	for (const value of ["/", "/srv", "/srv/app", "/home/user/my project"]) assert.doesNotThrow(() => assertListablePath(value), value);
	for (const value of ["srv", "/srv/", "/srv/../etc", "/a//b", "/a/./b", "/srv/\u0007x", ""]) assert.throws(() => assertListablePath(value), undefined, JSON.stringify(value));
});

test("the remote command only lists directories and caps the result", () => {
	const command = buildListDirectoriesCommand("/srv/my app");
	assert.match(command, /cd '\/srv\/my app' \|\| exit 3/);
	assert.match(command, /\[ -d "\$entry" \] \|\| continue/);
	assert.match(command, new RegExp(`-ge ${REMOTE_LIST_DIRS_LIMIT}`));
	// 不读取内容、不列文件详情。
	assert.doesNotMatch(command, /\b(cat|head|ls -l|stat)\b/);
	// SSH argv 校验拒绝真实换行/NUL；printf 必须收到反斜杠转义。
	for (const probe of [command, buildReadHomeCommand()]) assert.doesNotMatch(probe, /[\u0000\n\r]/);
	assert.match(command, /printf '%s\\0%s\\0'/);
	assert.match(buildReadHomeCommand(), /printf '%s\\n'/);
});

test("NUL stream parses directories and symlinks, sorted", () => {
	const parsed = parseDirectoryListing("D\u0000src\u0000L\u0000current\u0000D\u0000app\u0000");
	assert.equal(parsed.malformed, false);
	assert.equal(
		JSON.stringify(parsed.entries),
		JSON.stringify([
			{ name: "app", isSymlink: false },
			{ name: "current", isSymlink: true },
			{ name: "src", isSymlink: false },
		]),
	);
});

test("malformed streams are refused and unsafe names are skipped", () => {
	assert.equal(parseDirectoryListing("D\u0000src\u0000L").malformed, true);
	assert.equal(parseDirectoryListing("X\u0000src\u0000").malformed, true);
	assert.equal(parseDirectoryListing("D\u0000bad\u0007name\u0000").entries.length, 0);
});

test("remote home must be an absolute, non-root, traversal-free path", () => {
	assert.equal(readRemoteHome("/home/dev\n"), "/home/dev");
	for (const value of ["/", "home/dev", "/home/../root", "/home/dev/", ""]) assert.throws(() => readRemoteHome(value), undefined, JSON.stringify(value));
});
