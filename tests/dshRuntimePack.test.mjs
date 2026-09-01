import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as tar from "tar";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// dshRuntimeIo 依赖 electron（仅用于下载），测试里给个最小替身即可加载解压实现。
const { createTarExtractor, createNetDownloader, fetchDshRuntimeIndex } = loadTsCommonJs(
	"src/main/dsh/runtime/dshRuntimeIo.ts",
	{ stubs: { electron: { net: { request: () => undefined } } } },
);
const createFetchIndex = () => fetchDshRuntimeIndex;

const { DshRuntimeManager } = loadTsCommonJs("src/main/dsh/runtime/DshRuntimeManager.ts");

const APP_VERSION = "0.7.5";
const VERSION = "0.1.1-rc.2";

const manifest = (over = {}) => ({
	schemaVersion: 1,
	runtimeVersion: VERSION,
	builtByAppVersion: APP_VERSION,
	minAppVersion: "0.7.0",
	maxAppVersion: "",
	archiveSha256: "",
	requiredPackages: ["@deepseek-ai/dsh-base"],
	packageCount: 1,
	...over,
});

/** 造一个符合归档约定的 tgz：顶层 dsh-runtime/{manifest.json,node_modules/...}。 */
async function buildArchive(archivePath, { packages = ["@deepseek-ai/dsh-base"], manifestOver = {}, evil = false } = {}) {
	const src = mkdtempSync(join(tmpdir(), "dsh-tarsrc-"));
	mkdirSync(join(src, "node_modules"), { recursive: true });
	for (const pkg of packages) {
		mkdirSync(join(src, "node_modules", pkg), { recursive: true });
		writeFileSync(join(src, "node_modules", pkg, "package.json"), "{}");
	}
	writeFileSync(join(src, "manifest.json"), JSON.stringify(manifest(manifestOver)));
	await tar.c(
		{
			gzip: true,
			file: archivePath,
			cwd: src,
			portable: true,
			onWriteEntry: (entry) => {
				entry.path = `dsh-runtime/${entry.path}`;
			},
		},
		["./manifest.json", "./node_modules"],
	);
	// 额外塞一条逃逸条目（tar slip）：手动改写会破坏 gzip 流，这里用追加的方式
	// 单独生成一个未压缩条目不在本测试范围——改为在解压侧直接验证过滤器。
	if (evil) {
		const evilSrc = mkdtempSync(join(tmpdir(), "dsh-evil-"));
		writeFileSync(join(evilSrc, "evil.txt"), "pwned");
		await tar.c(
			{
				file: archivePath.replace(/\.tgz$/, "-evil.tar"),
				cwd: evilSrc,
				portable: true,
				onWriteEntry: (entry) => {
					entry.path = "../../escaped/evil.txt";
				},
			},
			["./evil.txt"],
		);
		rmSync(evilSrc, { recursive: true, force: true });
	}
	rmSync(src, { recursive: true, force: true });
	return archivePath;
}

test("打包产物能被安装端完整消费：剥掉顶层目录后落位正确", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-e2e-"));
	const archive = join(root, "runtime.tgz");
	await buildArchive(archive, { packages: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-app-boot"] });

	const manager = new DshRuntimeManager({
		layout: { runtimesRoot: join(root, "runtimes", "dsh"), tempRoot: join(root, "runtimes", ".tmp") },
		appVersion: () => APP_VERSION,
		extract: createTarExtractor(),
	});
	const result = await manager.installFromArchive(archive);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.dirName, VERSION);

	const installed = join(root, "runtimes", "dsh", VERSION);
	assert.equal(existsSync(join(installed, "manifest.json")), true);
	assert.equal(existsSync(join(installed, "node_modules", "@deepseek-ai", "dsh-base", "package.json")), true);
	// 顶层目录必须被剥掉，不能嵌套一层 dsh-runtime/
	assert.equal(existsSync(join(installed, "dsh-runtime")), false);
	assert.equal(manager.resolveActive()?.dirName, VERSION);
	rmSync(root, { recursive: true, force: true });
});

test("安装端拒绝版本不兼容的归档（打包自更高 app 版本）", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-e2e-"));
	const archive = join(root, "runtime.tgz");
	await buildArchive(archive, { manifestOver: { minAppVersion: "9.0.0" } });

	const manager = new DshRuntimeManager({
		layout: { runtimesRoot: join(root, "runtimes", "dsh"), tempRoot: join(root, "runtimes", ".tmp") },
		appVersion: () => APP_VERSION,
		extract: createTarExtractor(),
	});
	const result = await manager.installFromArchive(archive);
	assert.equal(result.ok, false);
	assert.equal(result.error, "app version incompatible");
	rmSync(root, { recursive: true, force: true });
});

test("本地下载源：file:// 索引与归档都能读（发布位置未就绪时也能跑通链路）", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-local-"));
	const archive = join(root, "runtime.tgz");
	await buildArchive(archive);

	const { createHash } = await import("node:crypto");
	const { createReadStream } = await import("node:fs");
	const { pathToFileURL } = await import("node:url");
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(archive)) hash.update(chunk);

	const indexPath = join(root, "dsh-runtime-releases.json");
	writeFileSync(
		indexPath,
		JSON.stringify({
			schemaVersion: 1,
			releases: [
				{
					runtimeVersion: VERSION,
					minAppVersion: "0.7.0",
					maxAppVersion: "",
					url: pathToFileURL(archive).href,
					sha256: hash.digest("hex"),
					size: 1,
				},
			],
		}),
	);

	// 索引：file:// 走本地文件读取（Electron net 不发 file 请求）
	const index = await createFetchIndex()(pathToFileURL(indexPath).href);
	assert.equal(index?.releases?.length, 1);
	assert.equal(index.releases[0].runtimeVersion, VERSION);

	// 归档：file:// 走本地复制，且复制后的内容哈希与源一致
	const manager = new DshRuntimeManager({
		layout: { runtimesRoot: join(root, "runtimes", "dsh"), tempRoot: join(root, "runtimes", ".tmp") },
		appVersion: () => APP_VERSION,
		download: createNetDownloader(),
		extract: createTarExtractor(),
	});
	const result = await manager.installFromUrl(
		pathToFileURL(archive).href,
		index.releases[0].sha256,
	);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(manager.resolveActive()?.dirName, VERSION);
	rmSync(root, { recursive: true, force: true });
});

const { readBundledRuntime } = loadTsCommonJs("src/main/dsh/runtime/DshRuntimeManager.ts");

/** 造一个随包资源目录：manifest.json + dsh-runtime-<platform>-<arch>.tgz */
async function makeBundledDir(root, { over = {}, withArchive = true } = {}) {
	const dir = join(root, "dsh-runtime");
	mkdirSync(dir, { recursive: true });
	const archivePath = join(dir, `dsh-runtime-${process.platform}-${process.arch}.tgz`);
	if (withArchive) await buildArchive(archivePath);
	// 随包 manifest 必须带归档的真实 sha256（打包脚本就是这么写的），
	// 安装端会拿它校验——填占位值会直接被判 sha256 mismatch。
	const { createHash } = await import("node:crypto");
	const { createReadStream } = await import("node:fs");
	const hash = createHash("sha256");
	if (withArchive) {
		for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
	}
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify(manifest({ archiveSha256: hash.digest("hex"), ...over })),
	);
	return dir;
}

test("readBundledRuntime：目录缺失 / 清单缺失 / 版本不兼容都返回 undefined", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-bundled-"));
	assert.equal(readBundledRuntime(undefined, APP_VERSION), undefined);
	assert.equal(readBundledRuntime(join(root, "nope"), APP_VERSION), undefined);
	// 只有清单没有归档（或反之）都不算可用
	const noArchive = await makeBundledDir(join(root, "a"), { withArchive: false });
	assert.equal(readBundledRuntime(noArchive, APP_VERSION), undefined, "归档缺失不可用");
	const incompatible = await makeBundledDir(join(root, "b"), { over: { minAppVersion: "9.0.0" } });
	assert.equal(readBundledRuntime(incompatible, APP_VERSION), undefined, "不兼容必须跳过");
	rmSync(root, { recursive: true, force: true });
});

test("readBundledRuntime：清单与归档齐备且兼容时返回可安装的一份", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-bundled-"));
	const dir = await makeBundledDir(root);
	const bundled = readBundledRuntime(dir, APP_VERSION);
	assert.ok(bundled, "应能读到随包 runtime");
	assert.equal(bundled.manifest.runtimeVersion, VERSION);
	assert.equal(existsSync(bundled.archivePath), true);
	rmSync(root, { recursive: true, force: true });
});

test("installFromIndex 优先用随包资源：不联网也能装成功", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-bundled-"));
	const dir = await makeBundledDir(root);

	let fetchCalled = false;
	const { DshRuntimeInstaller } = loadTsCommonJs("src/main/dsh/runtime/DshRuntimeInstaller.ts");
	const installer = new DshRuntimeInstaller({
		manager: new DshRuntimeManager({
			layout: { runtimesRoot: join(root, "runtimes", "dsh"), tempRoot: join(root, "runtimes", ".tmp") },
			appVersion: () => APP_VERSION,
			extract: createTarExtractor(),
		}),
		indexUrl: () => "https://unreachable.test/index.json",
		appVersion: () => APP_VERSION,
		// 若走到在线分支就会被调用；用它断言「本地资源优先」
		fetchIndex: async () => {
			fetchCalled = true;
			return null;
		},
		onProgress: () => {},
		bundledRuntime: () => readBundledRuntime(dir, APP_VERSION),
	});

	const result = await installer.installFromIndex();
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(fetchCalled, false, "有随包资源时不应发起网络请求");
	rmSync(root, { recursive: true, force: true });
});

test("没有随包资源时回退到在线索引", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-bundled-"));
	const { DshRuntimeInstaller } = loadTsCommonJs("src/main/dsh/runtime/DshRuntimeInstaller.ts");
	let fetchCalled = false;
	const installer = new DshRuntimeInstaller({
		manager: new DshRuntimeManager({
			layout: { runtimesRoot: join(root, "runtimes", "dsh"), tempRoot: join(root, "runtimes", ".tmp") },
			appVersion: () => APP_VERSION,
			extract: createTarExtractor(),
		}),
		indexUrl: () => "https://idx.test/i.json",
		appVersion: () => APP_VERSION,
		fetchIndex: async () => {
			fetchCalled = true;
			return null;
		},
		onProgress: () => {},
		bundledRuntime: () => undefined,
	});
	const result = await installer.installFromIndex();
	assert.equal(result.ok, false);
	assert.equal(fetchCalled, true, "没有随包资源时必须走在线索引");
	rmSync(root, { recursive: true, force: true });
});

test("解压器过滤逃逸条目：../ 不会写出目标目录", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-slip-"));
	const src = mkdtempSync(join(tmpdir(), "dsh-slipsrc-"));
	writeFileSync(join(src, "evil.txt"), "pwned");
	const archive = join(src, "evil.tar");
	await tar.c(
		{ file: archive, cwd: src, portable: true, onWriteEntry: (e) => { e.path = "../../escaped/evil.txt"; } },
		["./evil.txt"],
	);

	const dest = join(root, "dest");
	await createTarExtractor()(archive, dest);
	// 目标目录内不应出现任何越界文件；escaped/ 若被写出会在 root 之外一层
	assert.equal(existsSync(join(dest, "escaped")), false, "逃逸条目必须被过滤");
	const leaked = join(root, "..", "escaped", "evil.txt");
	assert.equal(existsSync(leaked), false, "绝不能写到目标目录之外");
	rmSync(root, { recursive: true, force: true });
	rmSync(src, { recursive: true, force: true });
});
