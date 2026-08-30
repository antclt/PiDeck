#!/usr/bin/env node
/**
 * 校验 DSH runtime 归档（原「校验 asar 里的 dsh 包」，阶段 2 后职责迁移）。
 *
 *   node scripts/check-dsh-asar.mjs <dsh-runtime-*.tgz>
 *
 * 背景：runtime 外置后 app.asar 里**不该**再有 @deepseek-ai 包（它们已移入
 * devDependencies，electron-builder 不再收集）。所以校验对象从 asar 换成
 * runtime tarball——打包流水线在上传前跑一次，缺包就红。
 *
 * 只遍历归档条目、不解压：3 万多个文件的解压要一分钟，而这里只需要判断路径存在性。
 */
import * as tar from "tar";

const [archivePath] = process.argv.slice(2);

if (!archivePath) {
	console.error("用法: node scripts/check-dsh-asar.mjs <dsh-runtime-*.tgz>");
	process.exit(1);
}

/** 回归基线：原 asar 校验的 19 个顶层 dsh 依赖，缺一个 host 就起不来。 */
const REQUIRED = [
	"cordis-plugin-group",
	"dsh-anonymous-user-id",
	"dsh-atomic-write",
	"dsh-bash-local",
	"dsh-code-runtime",
	"dsh-compaction",
	"dsh-fs",
	"dsh-invariants",
	"dsh-output-retention",
	"dsh-sandbox",
	"dsh-scope",
	"dsh-session-telemetry",
	"dsh-session-title-llm",
	"dsh-shell",
	"dsh-spill",
	"dsh-subagent-in-process-driver",
	"dsh-subprocess",
	"dsh-timeout",
	"dsh-workflow",
];

/** hostEntry 动态 resolve 的入口，外加两个作用域外的种子包。 */
const ENTRY_PACKAGES = [
	"@deepseek-ai/dsh-base",
	"@deepseek-ai/dsh-app-boot",
	"@deepseek-ai/dsh-host-apiproxy",
	"@deepseek-ai/dsh-cmdline",
	"dsh-bill",
	"dsh-tool-pwsh-persistent",
];

const present = new Set();
let manifest = null;
let entryCount = 0;

await tar.t({
	file: archivePath,
	onReadEntry(entry) {
		entryCount += 1;
		const path = entry.path.replace(/\\/g, "/");
		if (path.endsWith("/manifest.json")) {
			// 归档约定：manifest 在顶层 dsh-runtime/manifest.json
			entry.on("data", (chunk) => {
				try {
					manifest = JSON.parse(chunk.toString("utf8"));
				} catch {
					/* 解析失败会在下面的校验里报出来 */
				}
			});
			entry.resume();
			return;
		}
		const match = path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//);
		if (match) present.add(match[1]);
	},
});

const failures = [];

if (!manifest) {
	failures.push("manifest.json missing or unreadable");
} else {
	if (manifest.schemaVersion !== 1) failures.push(`unexpected schemaVersion: ${manifest.schemaVersion}`);
	if (!manifest.runtimeVersion) failures.push("manifest.runtimeVersion missing");
	// 归档内 manifest 的 archiveSha256 按设计是空串：把归档哈希写进归档内容会
	// 自相矛盾（填了哈希 → 内容变 → 哈希失效）。校验值由下载源索引提供，
	// 这里只检查「如果填了，格式必须对」。
	if (manifest.archiveSha256 && !/^[0-9a-f]{64}$/i.test(manifest.archiveSha256)) {
		failures.push(`manifest.archiveSha256 is not a sha256 hex: ${manifest.archiveSha256}`);
	}
	for (const pkg of manifest.requiredPackages ?? []) {
		if (!present.has(pkg)) failures.push(`requiredPackages missing: ${pkg}`);
	}
}

for (const name of REQUIRED) {
	const scoped = `@deepseek-ai/${name}`;
	if (!present.has(scoped)) failures.push(`missing ${scoped}`);
}
for (const pkg of ENTRY_PACKAGES) {
	if (!present.has(pkg)) failures.push(`missing ${pkg}`);
}

console.log(`entries: ${entryCount} | packages: ${present.size}`);
if (manifest) {
	console.log(`runtimeVersion: ${manifest.runtimeVersion} | minAppVersion: ${manifest.minAppVersion}`);
}

if (failures.length > 0) {
	for (const failure of failures) console.error(`FAIL  ${failure}`);
	process.exit(1);
}
console.log(`OK    all ${REQUIRED.length} baseline + ${ENTRY_PACKAGES.length} entry packages present`);
