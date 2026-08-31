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
import { existsSync } from "node:fs";
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
