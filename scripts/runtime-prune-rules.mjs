/**
 * DSH runtime 打包的裁剪规则（与 scripts/pack-dsh-runtime.mjs 共享的唯一来源）。
 *
 * 原则：只删运行时不会 require 的东西，绝不删可能被加载的文件。
 *
 * 已知雷区（2026-08 实测踩坑）：
 * - `yaml` 包的编译产物里有 `dist/doc/` 目录（Document.js 等），composer.js 会
 *   `require('../doc/directives.js')`。早年正则用 `docs?` 把 `doc` 也当成文档裁掉，
 *   导致 host 启动即崩（Cannot find module '../doc/directives.js' → exit(1)）。
 *   因此这里只裁 **docs/**（复数，npm 文档惯例），单数 `doc/` 一律保留——
 *   不裁多出的体积可忽略，裁错就是 host 起不来。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 包内是否有编译产物目录。有 lib/ 或 dist/ 时，src/ 只是源码副本，
 * 运行时加载的是产物，src 可以整块丢掉（这是归档里最大的一块冗余）。
 */
export function hasBuildOutput(pkgDir) {
	return (
		existsSync(join(pkgDir, "lib")) ||
		existsSync(join(pkgDir, "dist")) ||
		existsSync(join(pkgDir, "build"))
	);
}

/**
 * 从 main/exports 提取运行时会加载的入口（相对包目录，统一 `/` 分隔）。
 * 取 main 与 exports["."] 的运行时条件（import/require/node/default），
 * types 等纯类型条件不在此列。供打包裁剪（磁盘目录）与归档校验（tar 条目）共用。
 */
export function entryPointsFromPkg(main, exports) {
	const entries = [];
	if (typeof main === "string") entries.push(main);
	const dot = exports?.["."];
	if (typeof dot === "string") {
		entries.push(dot);
	} else if (dot && typeof dot === "object") {
		// 条件对象：按运行时优先级取第一个命中（import > require > node > default）
		for (const cond of ["import", "require", "node", "default"]) {
			if (typeof dot[cond] === "string") {
				entries.push(dot[cond]);
				break;
			}
		}
	}
	return entries;
}

/**
 * 运行时会加载的入口文件（相对包目录，统一 `/` 分隔）。
 * 取 package.json 的 main 与 exports["."] 的运行时条件（import/require/node/default），
 * types 等纯类型条件不在此列。
 */
export function runtimeEntryPoints(pkgDir) {
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	} catch {
		return [];
	}
	return entryPointsFromPkg(pkg.main, pkg.exports);
}

/**
 * 少数包不遵循「源码在 src/、产物在 lib|dist/」的惯例：
 * 运行时代码本身就在 src/ 里，lib/ 只是原生二进制等非 JS 产物。
 * 对这些包必须保留 src/，否则入口解析到一半崩（koffi 事故：
 * index.cjs -> require('./src/koffi/index.cjs')，src/ 被裁后
 * dsh-subprocess-local / dsh-sandbox-local 全部加载失败）。
 */
export const KEEP_SRC_PACKAGES = new Set(["koffi"]);

/**
 * src/ 是否可裁（整包级判定）：
 * - 有编译产物（lib|dist|build）是前提；
 * - 但入口（main / exports["."] 运行时条件）落在 src/ 里的包不能裁
 *   （如 node-fetch main=./src/index.js、ecdsa-sig-formatter main=src/…），
 *   入口在 src/ 说明运行时直接加载源码；
 * - KEEP_SRC_PACKAGES 白名单兜底间接引用（入口在根目录、但内部 require 到 src/ 的包）。
 */
export function isSrcPrunable(pkgDir) {
	if (!hasBuildOutput(pkgDir)) return false;
	try {
		const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
		if (pkg.name && KEEP_SRC_PACKAGES.has(pkg.name)) return false;
	} catch {
		// 读不到 package.json 的目录不是合法包，交给入口判定（返回空则继续）
	}
	return !runtimeEntryPoints(pkgDir).some((entry) => entry.replace(/^\.\//, "").split("/")[0] === "src");
}

/** 其他平台的 prebuilds：Electron 只跑当前平台。 */
export function isOtherPlatformPrebuild(relPath, platform) {
	const match = relPath.match(/prebuilds[/\\]([a-z0-9]+)-[\w-]+[/\\]/);
	if (!match) return false;
	return match[1] !== platform;
}

/**
 * 文件级裁剪判定。
 * relPath 是相对包目录的路径（统一用 `/` 分隔）；srcPrunable 表示包内已有编译产物。
 *
 * 排除的都是「运行时不会被 require 的东西」：调试符号、source map、测试、示例、
 * 文档（仅 docs/）、类型声明、其他平台的原生二进制、官方包内的历史版本副本，
 * 以及有编译产物时的 src/ 源码。**LICENSE 一律保留**（分发合规）。
 */
export function isExcluded(relPath, pkgDir, srcPrunable, platform = process.platform) {
	if (relPath.endsWith(".pdb")) return true;
	if (relPath.endsWith(".map")) return true;
	if (relPath.endsWith(".d.ts")) return true;
	// third_party：官方包内的历史版本副本（运行时只取 prebuilds/ 里的当前版本）。
	// 用锚点正则覆盖「包根目录下」与「嵌套路径中」两种位置。
	if (/(^|\/)third_party\//.test(relPath) || relPath.includes("\\third_party\\")) return true;
	if (isOtherPlatformPrebuild(relPath, platform)) return true;
	// 测试 / 示例 / 文档（复数 docs/）：npm 包常带，运行时不加载。
	// 注意 docs? 会误伤 yaml 的 dist/doc/（编译产物），见文件头说明，这里只用 docs。
	if (/(^|\/)(tests?|__tests__|spec|examples?|demo|docs)\//.test(relPath)) return true;
	if (/\.(test|spec)\.[cm]?js$/.test(relPath)) return true;
	// README/CHANGELOG 之类：运行时不读，且量不小（数百个包累加约 5MB）
	if (/\.(md|markdown)$/.test(relPath)) return true;
	// 有 lib/ 或 dist/ 时，src/ 是源码副本
	if (srcPrunable && relPath.startsWith("src/")) return true;
	return false;
}
