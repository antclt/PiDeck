import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasBuildOutput, isExcluded, isSrcPrunable } from "../scripts/runtime-prune-rules.mjs";

/**
 * DSH runtime 打包裁剪规则的回归测试。
 *
 * 背景（2026-08 生产事故）：规则里用 `docs?` 匹配文档目录，把 yaml 包的
 * 编译产物 `dist/doc/` 也裁掉了（composer.js 会 require('../doc/directives.js')），
 * host 启动即崩：Cannot find module '../doc/directives.js' → exit(1)。
 * 本文件把「doc/ 编译产物必须保留」钉死，防止回归。
 *
 * 后续事故（同一月）：入口感知 src 裁剪引入前，koffi 的 src/（运行时代码所在地）
 * 因 lib/ 存在被误裁，node-fetch 的 main 指向 src/ 也同理；isSrcPrunable 相关
 * 用例钉死「入口在 src/ 的包 / KEEP_SRC 白名单包必须保留 src/」。
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

// ── isSrcPrunable：入口感知 src 裁剪（koffi/node-fetch 事故回归）──

function makePkg(root, name, { main, exports, dirs }) {
	const dir = join(root, name);
	for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, main, exports }));
	return dir;
}

function makePruneFixture() {
	return mkdtempSync(join(tmpdir(), "dsh-prune-src-"));
}

test("isSrcPrunable：入口在 src/ 的包必须保留 src（node-fetch 事故）", () => {
	const root = makePruneFixture();
	try {
		// main 直接指向 src/index.js，即使有 lib/ 也不能裁
		const pkg = makePkg(root, "node-fetch", { main: "./src/index.js", dirs: ["src", "lib"] });
		assert.equal(hasBuildOutput(pkg), true);
		assert.equal(isSrcPrunable(pkg), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isSrcPrunable：exports 的 . 运行时条件指向 src/ 时保留 src", () => {
	const root = makePruneFixture();
	try {
		const pkg = makePkg(root, "x-export-src", {
			exports: { ".": { types: "./src/index.d.ts", default: "./src/index.js" } },
			dirs: ["src", "dist"],
		});
		assert.equal(isSrcPrunable(pkg), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isSrcPrunable：KEEP_SRC 白名单包（koffi）保留 src，即使入口在根目录", () => {
	const root = makePruneFixture();
	try {
		// koffi：main 在根 index.cjs（内部 require ./src/koffi/…），lib/ 只是原生二进制
		const pkg = makePkg(root, "koffi", { main: "./index.cjs", dirs: ["src", "lib"] });
		assert.equal(isSrcPrunable(pkg), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isSrcPrunable：常规包（入口在 lib/dist）src 仍可裁；无编译产物不可裁", () => {
	const root = makePruneFixture();
	try {
		const normal = makePkg(root, "normal", { main: "./lib/index.js", dirs: ["src", "lib"] });
		assert.equal(isSrcPrunable(normal), true);
		const srcOnly = makePkg(root, "src-only", { main: "./src/index.js", dirs: ["src"] });
		assert.equal(isSrcPrunable(srcOnly), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
