import assert from "node:assert/strict";
import test from "node:test";
import { hasBuildOutput, isExcluded } from "../scripts/runtime-prune-rules.mjs";

/**
 * DSH runtime 打包裁剪规则的回归测试。
 *
 * 背景（2026-08 生产事故）：规则里用 `docs?` 匹配文档目录，把 yaml 包的
 * 编译产物 `dist/doc/` 也裁掉了（composer.js 会 require('../doc/directives.js')），
 * host 启动即崩：Cannot find module '../doc/directives.js' → exit(1)。
 * 本文件把「doc/ 编译产物必须保留」钉死，防止回归。
 */

const noBuild = false;

test("裁剪规则：dist/lib/build 下的 doc/ 是编译产物，必须保留（yaml 事故回归）", () => {
	// yaml 实际被误裁的文件（打包脚本按相对包目录路径判定）
	assert.equal(isExcluded("dist/doc/directives.js", undefined, noBuild), false);
	assert.equal(isExcluded("dist/doc/Document.js", undefined, noBuild), false);
	assert.equal(isExcluded("dist/doc/anchors.js", undefined, noBuild), false);
	// browser 构建同样有 doc/ 编译产物
	assert.equal(isExcluded("browser/dist/doc/directives.js", undefined, noBuild), false);
});

test("裁剪规则：docs/（复数，文档惯例）仍然被裁", () => {
	assert.equal(isExcluded("docs/README.md", undefined, noBuild), true);
	assert.equal(isExcluded("dist/docs/api.md", undefined, noBuild), true);
});

test("裁剪规则：顶层 test/ spec/ examples/ demo/ 目录被裁", () => {
	assert.equal(isExcluded("test/index.js", undefined, noBuild), true);
	assert.equal(isExcluded("spec/index.js", undefined, noBuild), true);
	assert.equal(isExcluded("examples/demo.js", undefined, noBuild), true);
	assert.equal(isExcluded("demo/index.js", undefined, noBuild), true);
	assert.equal(isExcluded("__tests__/a.test.js", undefined, noBuild), true);
});

test("裁剪规则：调试符号/source map/类型声明/文档 md 被裁", () => {
	assert.equal(isExcluded("build/Release/x.pdb", undefined, noBuild), true);
	assert.equal(isExcluded("dist/index.js.map", undefined, noBuild), true);
	assert.equal(isExcluded("dist/index.d.ts", undefined, noBuild), true);
	assert.equal(isExcluded("README.md", undefined, noBuild), true);
	assert.equal(isExcluded("CHANGELOG.md", undefined, noBuild), true);
});

test("裁剪规则：有编译产物时 src/ 被裁，只有 src/ 时保留", () => {
	// hasBuildOutput 用真实目录判定，这里直接传 srcPrunable 参数
	assert.equal(isExcluded("src/index.ts", undefined, true), true);
	assert.equal(isExcluded("src/index.ts", undefined, false), false);
});

test("裁剪规则：third_party 与其他平台 prebuilds 被裁，当前平台保留", () => {
	assert.equal(isExcluded("third_party/old/index.js", undefined, noBuild), true);
	// linux 平台：linux prebuilds 保留、win32 的被裁
	assert.equal(isExcluded("prebuilds/linux-x64/x.node", undefined, noBuild, "linux"), false);
	assert.equal(isExcluded("prebuilds/win32-x64/x.node", undefined, noBuild, "linux"), true);
});

test("裁剪规则：LICENSE 与编译产物主体保留", () => {
	assert.equal(isExcluded("LICENSE", undefined, noBuild), false);
	assert.equal(isExcluded("dist/index.js", undefined, noBuild), false);
	assert.equal(isExcluded("lib/index.js", undefined, noBuild), false);
});

test("hasBuildOutput：按目录实测判定 src 是否可裁", async () => {
	const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "dsh-prune-"));
	try {
		const withDist = join(root, "a");
		mkdirSync(join(withDist, "dist"), { recursive: true });
		assert.equal(hasBuildOutput(withDist), true);
		const srcOnly = join(root, "b");
		mkdirSync(join(srcOnly, "src"), { recursive: true });
		assert.equal(hasBuildOutput(srcOnly), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
