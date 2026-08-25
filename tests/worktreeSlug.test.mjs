import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { worktreeSlugify } = loadTsCommonJs("src/shared/worktreeSlug.ts");

/**
 * 回归保护（issue #166）：`.` 是 git 分支与目录名的合法字符，不应被清洗成 `-`。
 * 同时覆盖 git check-ref-format 的点号边界规则与 `.lock` 保留后缀。
 */
test("点号在中间保留（issue #166）", () => {
	assert.equal(worktreeSlugify("feature.x"), "feature.x");
	assert.equal(worktreeSlugify("v1.2"), "v1.2");
	assert.equal(worktreeSlugify("release.2026.08"), "release.2026.08");
	assert.equal(worktreeSlugify("a.b.c"), "a.b.c");
});

test("下划线保留（同为 git 合法字符，旧实现一并误伤）", () => {
	assert.equal(worktreeSlugify("my_branch"), "my_branch");
});

test("连字符保留", () => {
	assert.equal(worktreeSlugify("my-branch"), "my-branch");
	assert.equal(worktreeSlugify("a-.b"), "a-.b");
});

test("首尾点去除（git 分支不允许；Windows 目录名尾部点会被系统剥掉）", () => {
	assert.equal(worktreeSlugify(".hidden"), "hidden");
	assert.equal(worktreeSlugify("foo."), "foo");
	assert.equal(worktreeSlugify(".a.b."), "a.b");
});

test("连续点折叠为单个点（.. 是 git 非法分支字符）", () => {
	assert.equal(worktreeSlugify("a..b"), "a.b");
	assert.equal(worktreeSlugify("a...b"), "a.b");
});

test("结尾 .lock 改为 -lock（git 保留后缀）", () => {
	assert.equal(worktreeSlugify("foo.lock"), "foo-lock");
});

test("非法字符折叠为单个 -（空格/斜杠/~ 等）", () => {
	assert.equal(worktreeSlugify("hello world"), "hello-world");
	assert.equal(worktreeSlugify("feature/x"), "feature-x");
	assert.equal(worktreeSlugify("test~1"), "test-1");
});

test("首尾 - 去除", () => {
	assert.equal(worktreeSlugify("-foo-"), "foo");
	assert.equal(worktreeSlugify("a.b-"), "a.b");
});

test("Unicode 字母保留（中文/日文）", () => {
	assert.equal(worktreeSlugify("中文.分支"), "中文.分支");
	assert.equal(worktreeSlugify("機能ブランチ"), "機能ブランチ");
});

test("空结果回落 workspace", () => {
	assert.equal(worktreeSlugify("   "), "workspace");
	assert.equal(worktreeSlugify("..."), "workspace");
	assert.equal(worktreeSlugify("---"), "workspace");
});
