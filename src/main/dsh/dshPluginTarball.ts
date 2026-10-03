/**
 * DSH 插件 tgz 处理与依赖闭包嵌套（install-dsh-plugin.mjs 的主进程移植，可单测）。
 *
 * 为什么不是简单 `npm i`：host 的模块解析锚点只有 runtime 的 node_modules，ESM 没有
 * NODE_PATH 双源回退；装到别处的包 host 看不见。装进 runtime node_modules 又会被
 * runtime 升级整目录删掉。所以采用「插件独立目录 + 自带静态 import 的依赖闭包」
 * 的自包含形态（与 scripts/install-dsh-plugin.mjs 同一结论）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isBuiltin as builtinIsBuiltin } from "node:module";
import { dirname, join } from "node:path";
import * as tar from "tar";
import type { DshPluginNpmRunner } from "./dshPluginNpmRunner";

export type PackedTgz = {
	/** 打包产物在磁盘上的绝对路径（已校验位于 destDir 内）。 */
	tarPath: string;
	/** npm pack 报告的 tarball 文件名（形如 pkg-name-1.0.0.tgz）。 */
	filename: string;
};

/**
 * npm pack 目标包到指定目录：`npm pack <spec> --json --pack-destination <dir>`。
 * 用 --json 而非 --silent 文本行：JSON 输出稳定可解析（文本行在多包/告警时不可靠）。
 */
export async function npmPackToDir(runNpm: DshPluginNpmRunner, spec: string, destDir: string): Promise<PackedTgz> {
	const result = await runNpm(["pack", spec, "--json", "--pack-destination", destDir], { cwd: destDir });
	if (result.code !== 0) {
		throw new Error(`npm pack ${spec} failed: ${result.stderr || result.stdout || "no output"}`);
	}
	let filename: string | undefined;
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		if (Array.isArray(parsed) && parsed.length > 0) {
			const last = parsed[parsed.length - 1];
			if (typeof last === "object" && last !== null && typeof Reflect.get(last, "filename") === "string") {
				filename = String(Reflect.get(last, "filename"));
			}
		}
	} catch {
		// 落到下面统一报错
	}
	if (filename === undefined || filename === "") {
		throw new Error(`npm pack ${spec} returned no tarball filename`);
	}
	// tarball 文件名必须无路径成分（registry 产物恒满足；异常输出按路径攻击处理）
	if (filename.includes("/") || filename.includes("\\") || filename.includes("..") || !filename.endsWith(".tgz")) {
		throw new Error(`npm pack returned unexpected tarball filename: ${filename}`);
	}
	return { tarPath: join(destDir, filename), filename };
}

/**
 * 解包 tgz 到 destDir（strip 1 去掉 npm tgz 固有的 package/ 前缀层）。
 * filter 拒绝绝对路径与含 .. 段的成员（zip-slip 防御，tar 默认有但显式再闸一道）。
 */
export async function extractTgz(tarPath: string, destDir: string): Promise<void> {
	mkdirSync(destDir, { recursive: true });
	await tar.x({
		file: tarPath,
		cwd: destDir,
		strip: 1,
		filter: (path) => {
			if (path.startsWith("/") || path.startsWith("\\")) return false;
			const segments = path.split(/[\\/]/);
			return !segments.some((segment) => segment === "..");
		},
	});
}

/** 递归列出目录下全部 .js 文件（依赖扫描的输入面；其余扩展名不 import）。 */
function listJsFiles(dir: string, out: string[] = []): string[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) listJsFiles(full, out);
		else if (entry.name.endsWith(".js")) out.push(full);
	}
	return out;
}

/**
 * 收集插件代码里静态 import / dynamic import 的裸包名（跳过相对路径与 node: 内置）。
 * 正则与 install-dsh-plugin.mjs 保持一致（ESM/CJS 混合仓库的实用近似，不求完整 AST）。
 */
export function collectStaticJsImports(dir: string): Set<string> {
	const found = new Set<string>();
	const importRe = /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
	for (const file of listJsFiles(dir)) {
		let code: string;
		try {
			code = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		let match: RegExpExecArray | null;
		while ((match = importRe.exec(code)) !== null) {
			const value = match[1] ?? match[2];
			if (!value || value.startsWith(".") || value.startsWith("node:")) continue;
			const parts = value.split("/");
			found.add(value.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
		}
	}
	return found;
}

/** 从 fromDir 向上找 node_modules/<name>（标准 Node 解析的目录 climbing 近似）。 */
function resolveInNodeModules(fromDir: string, name: string): string | undefined {
	let current = fromDir;
	for (;;) {
		const candidate = join(current, "node_modules", ...name.split("/"));
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** Node 内置模块判定（不带 node: 前缀引用的内置，如 http2/buffer，无需嵌套）。 */
function isBuiltinModule(name: string): boolean {
	try {
		return builtinIsBuiltin(name);
	} catch {
		return false;
	}
}

export type NestDepsResult = {
	/** runtime 与 Node 内置里都找不到、registry pack 也失败的裸包名（提示用）。 */
	missing: string[];
	/** 从 registry（npm pack）补齐的依赖数（诊断用；0 = 完全来自 runtime）。 */
	packedFromRegistry: number;
};

/**
 * 把插件静态 import 的依赖闭包从 runtime node_modules **嵌套**进插件自己的
 * node_modules（runtime 缺失的按父清单锁定 range 从 registry npm pack 补齐）。
 *
 * range 锁定在父清单声明值：与 npm 语义一致，避免解析到最新版引入未声明的传递依赖。
 */
export async function nestDependencyClosure(input: {
	pluginDir: string;
	/** runtime 的 node_modules 目录（依赖优先从这里取，保证与 host 同版本）；未安装时 undefined。 */
	runtimeNodeModules?: string;
	runNpm: DshPluginNpmRunner;
	/** registry 补齐的预算（防恶意包爆炸式依赖 DoS）。 */
	maxPackedDeps?: number;
}): Promise<NestDepsResult> {
	const { pluginDir, runtimeNodeModules, runNpm } = input;
	const maxPacked = input.maxPackedDeps ?? 40;
	const targetNm = join(pluginDir, "node_modules");
	const seen = new Set<string>();
	const missing: string[] = [];
	let packedFromRegistry = 0;

	/** 已在插件 node_modules 里就不用再拷。 */
	const alreadyNested = (name: string): boolean => existsSync(join(targetNm, ...name.split("/"), "package.json"));

	/** 把一个包目录拷进插件的 node_modules（整目录复制；其依赖由闭包递归另行保证）。 */
	const copyInto = (srcDir: string, name: string): void => {
		const dest = join(targetNm, ...name.split("/"));
		mkdirSync(dirname(dest), { recursive: true });
		cpSync(srcDir, dest, { recursive: true });
	};

	/** 递归嵌套 <pkgDir>/package.json 声明的 dependencies（闭包）。 */
	const nest = async (pkgDir: string, name: string): Promise<void> => {
		if (seen.has(name)) return;
		seen.add(name);
		let manifest: Record<string, unknown>;
		try {
			manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
		} catch {
			return;
		}
		const deps: Record<string, unknown> = { ...((manifest.dependencies as Record<string, unknown>) ?? {}), ...((manifest.optionalDependencies as Record<string, unknown>) ?? {}) };
		for (const [depName, range] of Object.entries(deps)) {
			if (alreadyNested(depName)) continue;
			const src = resolveInNodeModules(pkgDir, depName) ?? (runtimeNodeModules ? resolveInNodeModules(runtimeNodeModules, depName) : undefined);
			if (src !== undefined) {
				copyInto(src, depName);
			} else if (typeof range === "string" && range.length > 0 && packedFromRegistry < maxPacked) {
				// runtime 缺失：按父清单锁定的 range 从 registry 补（临时目录解包再嵌套）
				const tmp = join(targetNm, ".tmp-pack");
				try {
					const packed = await npmPackToDir(runNpm, `${depName}@${range}`, tmp);
					const unpacked = join(tmp, "unpacked");
					await extractTgz(packed.tarPath, unpacked);
					copyInto(unpacked, depName);
					packedFromRegistry += 1;
				} finally {
					rmSync(tmp, { recursive: true, force: true });
				}
			} else {
				missing.push(depName);
				continue;
			}
			await nest(join(targetNm, ...depName.split("/")), depName);
		}
	};

	// 插件自身 manifest 声明的依赖 range：直接 import 的包优先按声明 range 锁定补齐
	// （与 npm 语义一致，避免解析到最新版引入未声明的传递依赖）
	let pluginDeclaredRanges = new Map<string, string>();
	try {
		const ownManifest = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")) as Record<string, unknown>;
		const ownDeps: Record<string, unknown> = { ...((ownManifest.dependencies as Record<string, unknown>) ?? {}), ...((ownManifest.optionalDependencies as Record<string, unknown>) ?? {}) };
		pluginDeclaredRanges = new Map(Object.entries(ownDeps).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0));
	} catch {
		// manifest 不可读：裸包名 pack（nest 递归同样兜底）
	}
	for (const name of collectStaticJsImports(pluginDir)) {
		if (alreadyNested(name)) {
			await nest(join(targetNm, ...name.split("/")), name);
			continue;
		}
		const src = runtimeNodeModules ? resolveInNodeModules(runtimeNodeModules, name) : undefined;
		if (src !== undefined) {
			copyInto(src, name);
		} else if (isBuiltinModule(name)) {
			continue;
		} else if (packedFromRegistry < maxPacked) {
			// 插件直接 import 但 runtime 没有：按 manifest 声明 range（若有）补齐
			const declared = pluginDeclaredRanges.get(name);
			const packSpec = declared !== undefined ? `${name}@${declared}` : name;
			const tmp = join(targetNm, ".tmp-pack");
			try {
				const packed = await npmPackToDir(runNpm, packSpec, tmp);
				const unpacked = join(tmp, "unpacked");
				await extractTgz(packed.tarPath, unpacked);
				copyInto(unpacked, name);
				packedFromRegistry += 1;
			} catch {
				missing.push(name);
				continue;
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		} else {
			missing.push(name);
			continue;
		}
		await nest(join(targetNm, ...name.split("/")), name);
	}
	return { missing, packedFromRegistry };
}
