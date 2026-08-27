import assert from "node:assert/strict";
import test from "node:test";
import {
	FILE_PATH_RE,
	isAbsoluteFilePath,
	matchPlainFilePaths,
	resolveFileLinkPath,
} from "../src/renderer/src/utils/filePathLinks.ts";

// matchPlainFilePaths：markdown 文本 → 纯文本文件路径候选（带区间）。
// 这是「模型给的路径可能不存在」场景的第一道闸：只负责识别候选，
// 存在性校验交给 verdict store（files:paths-exist IPC）。

test("matches windows absolute, relative and ~ paths with spans", () => {
	const text = "请看 D:\\proj\\src\\a.ts 和 src/lib/b.ts，还有 ~/notes.md";
	const matches = matchPlainFilePaths(text);
	assert.deepEqual(
		matches.map((m) => m.path),
		["D:\\proj\\src\\a.ts", "src/lib/b.ts", "~/notes.md"],
	);
	for (const m of matches) {
		assert.equal(text.slice(m.start, m.end), m.path);
	}
});

test("skips url tails so links are not double-linkified", () => {
	const text = "文档在 https://example.com/docs/readme.md 里";
	assert.deepEqual(matchPlainFilePaths(text), []);
});

test("full-width punctuation and quotes are excluded from matches", () => {
	const text = "改了「src/app/main.tsx」，见（utils/fmt.ts）。";
	const matches = matchPlainFilePaths(text);
	assert.deepEqual(
		matches.map((m) => m.path),
		["src/app/main.tsx", "utils/fmt.ts"],
	);
});

test("regex rejects bare words without separators or dots", () => {
	assert.equal(FILE_PATH_RE.test("hello"), false);
	assert.equal(FILE_PATH_RE.test("src"), false);
});

test("isAbsoluteFilePath covers win drive, posix root and tilde only", () => {
	assert.equal(isAbsoluteFilePath("D:\\a\\b.ts"), true);
	assert.equal(isAbsoluteFilePath("/usr/local/a.ts"), true);
	assert.equal(isAbsoluteFilePath("~/a.ts"), true);
	assert.equal(isAbsoluteFilePath("src/a.ts"), false);
	assert.equal(isAbsoluteFilePath("https://x.com"), false);
});

test("resolveFileLinkPath joins relatives against base with matching separator and passes absolutes through", () => {
	assert.equal(resolveFileLinkPath("src\\a.ts", "D:\\proj"), "D:\\proj\\src\\a.ts");
	assert.equal(resolveFileLinkPath("src/a.ts", "/home/u/proj"), "/home/u/proj/src/a.ts");
	assert.equal(resolveFileLinkPath("src/a.ts", "D:\\proj"), "D:\\proj\\src/a.ts");
	// 绝对路径与 ~ 路径不需要 base
	assert.equal(resolveFileLinkPath("C:\\temp\\x.log", undefined), "C:\\temp\\x.log");
	assert.equal(resolveFileLinkPath("/tmp/x.log", "D:\\proj"), "/tmp/x.log");
	assert.equal(resolveFileLinkPath("~/x.log", undefined), "~/x.log");
	// 无 base 的相对路径无从解析：返回 null（调用方按未知处理）
	assert.equal(resolveFileLinkPath("src/a.ts", undefined), null);
});
