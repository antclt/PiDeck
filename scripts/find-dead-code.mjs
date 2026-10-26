#!/usr/bin/env node
/**
 * 死代码扫描：从真实入口做可达性分析，列出没有任何入口能到达的源文件。
 *
 *   node scripts/find-dead-code.mjs [--root <dir>] [--json]
 *
 * 判定方式：从 `ENTRY_POINTS`（electron.vite 的 main/preload/renderer 多入口 +
 * 各 html 的 script 入口）出发沿 import/export-from/require/动态 import 遍历，
 * 解析相对路径与 `@/`、`@renderer/`、`@shared/` 别名；没被遍历到的 ts/tsx/mjs
 * 就是不可达文件。按行数降序输出，`--json` 输出机器可读结果。
 *
 * 刻意不算「可达」的两类文件要在看完报告后人工排除：
 * - 由构建配置改写的模块（如 vite alias `shiki` → src/renderer/src/shiki/bundle.ts，
 *   已预先列入 ENTRY_POINTS）；
 * - 由测试/脚本按路径字符串加载或读源码断言的模块（`*.test.ts`、被 `tests/*.mjs`
 *   readFileSync 的生产文件）。这类文件「只有测试在用」，属于僵尸模块，报告里会
 *   单独标注 `testOnly`，删除时需连守护测试一起处理。
 *
 * 只读脚本，不修改仓库；退出码恒为 0（这是巡检工具，不是门禁）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const rootArg = args.includes("--root") ? args[args.indexOf("--root") + 1] : null;
const ROOT = rootArg ? resolve(rootArg) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const JSON_OUT = args.includes("--json");

/**
 * 入口清单与 electron.vite.config.ts / src/renderer/*.html 同步维护。
 * 新增构建入口时必须在这里补一行，否则它的整棵依赖树会被误报成死代码。
 */
const ENTRY_POINTS = [
	// main（electron-vite main.entry 多入口）
	"src/main/index.ts",
	"src/main/dsh/hostEntry.ts",
	"src/main/dsh/runnerConsolePreload.ts",
	"src/main/dsh/pideckPluginBridge.ts",
	"src/main/dsh/pideckCommandsBridge.ts",
	// preload
	"src/preload/index.ts",
	"src/preload/hostPlugin.ts",
	// renderer（src/renderer/*.html 的 <script type="module"> 入口）
	"src/renderer/src/main.tsx",
	"src/renderer/src/web-main.tsx",
	"src/renderer/src/pet/main.tsx",
	"src/renderer/src/floater/main.tsx",
	"src/renderer/src/selection-tool/main.tsx",
	// 由 vite alias 改写裸 `shiki` 到这里的 bundle，静态图里看不到 import 边
	"src/renderer/src/shiki/bundle.ts",
];

const ALIASES = [
	["@/", join(SRC, "renderer/src")],
	["@renderer/", join(SRC, "renderer/src")],
	["@shared/", join(SRC, "shared")],
];

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const CANDIDATES = [".ts", ".tsx", ".mjs", ".js", ".json"];
const INDEX_CANDIDATES = ["index.ts", "index.tsx"];

function listSourceFiles(dir, out = []) {
	for (const entry of readdirSafe(dir)) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) listSourceFiles(path, out);
		else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(path);
	}
	return out;
}

function readdirSafe(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

function resolveSpecifier(fromFile, specifier) {
	const clean = specifier.split("?")[0].split("#")[0];
	let base = null;
	if (clean.startsWith(".")) {
		base = resolve(dirname(fromFile), clean);
	} else {
		for (const [prefix, dir] of ALIASES) {
			if (clean.startsWith(prefix)) {
				base = join(dir, clean.slice(prefix.length));
				break;
			}
		}
	}
	if (!base) return null;
	if (isFile(base)) return base;
	for (const ext of CANDIDATES) if (isFile(base + ext)) return base + ext;
	for (const index of INDEX_CANDIDATES) if (isFile(join(base, index))) return join(base, index);
	return null;
}

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

const files = listSourceFiles(SRC);
const fileSet = new Set(files);
const reached = new Set();
const queue = [];

for (const rel of ENTRY_POINTS) {
	const abs = join(ROOT, rel);
	if (!isFile(abs)) {
		console.error(`[dead-code] 入口不存在：${rel}（ENTRY_POINTS 与构建配置漂移了）`);
		continue;
	}
	reached.add(abs);
	queue.push(abs);
}

while (queue.length > 0) {
	const file = queue.pop();
	let source;
	try {
		source = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	IMPORT_RE.lastIndex = 0;
	let match;
	while ((match = IMPORT_RE.exec(source)) !== null) {
		const target = resolveSpecifier(file, match[1]);
		if (!target || reached.has(target) || !fileSet.has(target)) continue;
		reached.add(target);
		queue.push(target);
	}
}

/** 测试与脚本里按路径字符串引用过的生产文件（`testOnly` 标注用）。 */
function loadTestBlob() {
	const blobs = [];
	for (const dir of ["tests", "e2e", "scripts"]) {
		const abs = join(ROOT, dir);
		if (!existsSync(abs)) continue;
		for (const file of listSourceFiles(abs)) {
			if (!/\.(mjs|js|ts)$/.test(file)) continue;
			try {
				blobs.push(readFileSync(file, "utf8"));
			} catch {
				// 读不到就当没有引用
			}
		}
	}
	return blobs.join("\n");
}

const testBlob = loadTestBlob();
const rows = [];
for (const file of files) {
	if (reached.has(file)) continue;
	const rel = relative(ROOT, file).split(sep).join("/");
	const lines = readFileSync(file, "utf8").split("\n").length;
	const isDeclaration = /\.d\.ts$/.test(rel);
	const isTestFile = /\.test\.ts$/.test(rel);
	const testOnly = !isDeclaration && !isTestFile && (testBlob.includes(rel) || testBlob.includes(rel.split("/").pop()));
	rows.push({ file: rel, lines, declaration: isDeclaration, testFile: isTestFile, testOnly });
}
rows.sort((a, b) => b.lines - a.lines);

if (JSON_OUT) {
	console.log(JSON.stringify(rows, null, 2));
} else {
	const total = rows.reduce((sum, row) => sum + row.lines, 0);
	console.log(`[dead-code] 扫描 ${files.length} 个源文件：不可达 ${rows.length} 个 / ${total} 行`);
	for (const row of rows) {
		const tag = row.declaration ? " (d.ts)" : row.testFile ? " (test)" : row.testOnly ? " (testOnly)" : "";
		console.log(`${String(row.lines).padStart(6)}  ${row.file}${tag}`);
	}
	console.log("\n(d.ts / test 文件是正常存在；testOnly = 只有测试在引用，属于僵尸模块)");
}
