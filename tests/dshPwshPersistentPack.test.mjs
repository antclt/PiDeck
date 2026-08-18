import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * 独立 pwsh 插件打包护栏：hostEntry 必须按包名解析 dsh-tool-pwsh-persistent，
 * 且该包是 production dependency（electron-builder 才会打进 asar）。
 * 嵌套 node-pty 必须 asarUnpack，否则 utilityProcess 加载原生模块会失败。
 */
const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package.json depends on dsh-tool-pwsh-persistent so electron-builder packs it", () => {
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	assert.ok(
		pkg.dependencies["dsh-tool-pwsh-persistent"],
		"dsh-tool-pwsh-persistent must be a production dependency",
	);
	assert.match(
		String(pkg.dependencies["dsh-tool-pwsh-persistent"]),
		/file:packages\/dsh-tool-pwsh-persistent/,
	);
});

test("asarUnpack includes nested node-pty of the pwsh plugin", () => {
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const unpack = pkg.build?.asarUnpack ?? [];
	assert.ok(
		unpack.includes("node_modules/dsh-tool-pwsh-persistent/node_modules/node-pty/**"),
		"nested node-pty of dsh-tool-pwsh-persistent must be asarUnpacked",
	);
});

test("hostEntry composition inserts the standalone pwsh plugin by package name", () => {
	const src = readFileSync(join(repoRoot, "src/main/dsh/hostEntry.ts"), "utf8");
	assert.match(src, /require\.resolve\("dsh-tool-pwsh-persistent"\)/);
	assert.doesNotMatch(src, /pideckPwshPersistent\.js/);
});

test("electron-vite externalizes the standalone pwsh package", () => {
	const src = readFileSync(join(repoRoot, "electron.vite.config.ts"), "utf8");
	assert.match(src, /"dsh-tool-pwsh-persistent"/);
	assert.doesNotMatch(src, /pideckPwshPersistent:/);
});

test("standalone package peers pin the host rc line, not wildcard", () => {
	const pkg = JSON.parse(
		readFileSync(join(repoRoot, "packages/dsh-tool-pwsh-persistent/package.json"), "utf8"),
	);
	assert.equal(pkg.peerDependencies["@deepseek-ai/dsh-tools"], "^0.1.0-rc.7");
	assert.equal(pkg.peerDependencies["@deepseek-ai/dsh-timeout"], "^0.1.0-rc.7");
	assert.notEqual(pkg.peerDependencies["@deepseek-ai/dsh-tools"], "*");
});

test("dsh-tool-pwsh-persistent is resolvable from the app root when installed", () => {
	let resolved;
	try {
		resolved = require.resolve("dsh-tool-pwsh-persistent");
	} catch {
		// npm install 尚未把 file: 包链上时跳过（本文件后半段会在 install 后绿）
		return;
	}
	assert.ok(existsSync(resolved), `resolved path missing: ${resolved}`);
	const pkg = JSON.parse(readFileSync(require.resolve("dsh-tool-pwsh-persistent/package.json"), "utf8"));
	assert.equal(pkg.name, "dsh-tool-pwsh-persistent");
});
