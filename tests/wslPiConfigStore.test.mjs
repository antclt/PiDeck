import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * WslPiConfigStore（P1-1）：hostId → WslHostStore 档案 → resolveWslEnvironment → 发行版 HOME 的
 * .pi/agent，读写 models.json / settings.json。
 *
 * 关键契约（都是行为断言，不是源码形状）：
 * - 只认档案：档案缺失/发行版不可用/路径不可读在**读文件之前**就回稳定码，绝不回退 Windows HOME；
 * - 解析出的目录只来自注入的环境，两个 store 实例之间没有共享单例；
 * - models.json 保存沿用本地校验规则，settings.json 保存沿用本地「资源键以磁盘为准」的合并规则；
 * - 写入是临时文件 + rename（默认 fs 端口用 durable 写），失败不留下半份文件。
 */

const storeModule = loadTsCommonJs("src/main/config/WslPiConfigStore.ts");
const shared = loadTsCommonJs("src/shared/piConfig.ts");
const wslPaths = loadTsCommonJs("src/main/wsl/WslPaths.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const DISTRO = "Ubuntu-26.04";
const USER = "dev";
const LINUX_HOME = "/home/dev";
const PROFILE = { id: HOST, label: "Ubuntu dev", distro: DISTRO, user: USER };
const DISTRO_ROOT = wslPaths.linuxPathToWslUnc("/", DISTRO);
const WINDOWS_HOME = wslPaths.linuxPathToWslUnc(LINUX_HOME, DISTRO);
const CONFIG_DIR = join(WINDOWS_HOME, ".pi", "agent");

async function rejectionCode(run) {
	try {
		await run();
	} catch (error) {
		return typeof error?.message === "string" ? error.message : String(error);
	}
	throw new Error("EXPECTED_REJECTION");
}

/** 注入式 fs：只记录调用、只认测试给的目录集合，用来证明「不读别处」。 */
function createFakeFs(options = {}) {
	const files = new Map(Object.entries(options.files ?? {}));
	const dirs = new Set(options.dirs ?? [DISTRO_ROOT, WINDOWS_HOME]);
	const calls = [];
	const fs = {
		async statDirectory(path) {
			calls.push(["stat", path]);
			if (options.statError === path) throw Object.assign(new Error("stat failed"), { code: "EACCES" });
			return dirs.has(path) ? { isDirectory: true } : null;
		},
		async readTextFile(path) {
			calls.push(["read", path]);
			if (options.readError === path) throw Object.assign(new Error("read failed"), { code: "EACCES" });
			return files.has(path) ? files.get(path) : null;
		},
		async writeTextFile(path, content) {
			calls.push(["write", path, content]);
			if (options.writeError === path) throw Object.assign(new Error("write failed"), { code: "EACCES" });
			files.set(path, content);
		},
	};
	return { fs, calls, files };
}

function createStore(fsPort, options = {}) {
	return storeModule.createWslPiConfigStore({
		listProfiles: async () => options.profiles ?? [PROFILE],
		resolveEnvironment: async (distro, user) => options.environment ?? { distro, user, linuxHome: LINUX_HOME, windowsHome: WINDOWS_HOME },
		fs: fsPort,
		translate: (key, params) => key + (params?.provider ? ":" + params.provider : ""),
	});
}

test("读取路径只来自档案环境：发行版 HOME 下的 .pi/agent（UNC 拼接）", async () => {
	const { fs, calls } = createFakeFs({ files: { [join(CONFIG_DIR, "models.json")]: '{"providers":{"openai":{"models":[]}}}' } });
	const snapshot = await createStore(fs).read({ hostId: HOST, file: "models" });
	assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
		kind: "wsl",
		hostId: HOST,
		file: "models",
		label: "Ubuntu dev",
		distro: DISTRO,
		user: USER,
		data: { providers: { openai: { models: [] } } },
	});
	// 先判定发行版根与 HOME（在读文件之前），再读 allowlist 里的单个文件。
	assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
		["stat", DISTRO_ROOT],
		["stat", WINDOWS_HOME],
		["read", join(CONFIG_DIR, "models.json")],
	]);
	assert.ok(CONFIG_DIR.startsWith("\\\\wsl.localhost\\" + DISTRO), "配置目录必须落在发行版 UNC 路径下: " + CONFIG_DIR);
});

test("文件缺失按新安装返回空配置，不报错也不回退本机", async () => {
	const { fs } = createFakeFs();
	const models = await createStore(fs).read({ hostId: HOST, file: "models" });
	assert.deepEqual(JSON.parse(JSON.stringify(models.data)), { providers: {} });
	const settings = await createStore(fs).read({ hostId: HOST, file: "settings" });
	assert.deepEqual(JSON.parse(JSON.stringify(settings.data)), {});
});

test("档案缺失/发行版未启动/HOME 不可读：读文件之前给稳定码", async () => {
	const missingProfile = createFakeFs();
	assert.equal(await rejectionCode(() => createStore(missingProfile.fs, { profiles: [] }).read({ hostId: HOST, file: "models" })), shared.WSL_CONFIG_CODES.hostNotFound);
	assert.equal(missingProfile.calls.length, 0, "档案缺失时不得触碰文件系统");

	const stopped = createFakeFs({ dirs: [] });
	assert.equal(await rejectionCode(() => createStore(stopped.fs).read({ hostId: HOST, file: "models" })), shared.WSL_CONFIG_CODES.distroUnavailable);
	assert.deepEqual(JSON.parse(JSON.stringify(stopped.calls)), [["stat", DISTRO_ROOT]]);

	const missingHome = createFakeFs({ dirs: [DISTRO_ROOT] });
	assert.equal(await rejectionCode(() => createStore(missingHome.fs).read({ hostId: HOST, file: "models" })), shared.WSL_CONFIG_CODES.pathUnreadable);
	assert.deepEqual(JSON.parse(JSON.stringify(missingHome.calls)), [
		["stat", DISTRO_ROOT],
		["stat", WINDOWS_HOME],
	]);

	const unreadable = createFakeFs({ readError: join(CONFIG_DIR, "models.json") });
	assert.equal(await rejectionCode(() => createStore(unreadable.fs).read({ hostId: HOST, file: "models" })), shared.WSL_CONFIG_CODES.pathUnreadable);

	const badHost = createFakeFs();
	assert.equal(await rejectionCode(() => createStore(badHost.fs).read({ hostId: "nope", file: "models" })), shared.WSL_CONFIG_CODES.targetInvalid);
});

test("JSON 损坏给 WSL_CONFIG_FILE_INVALID（不把坏文件当空配置展示）", async () => {
	const { fs } = createFakeFs({ files: { [join(CONFIG_DIR, "models.json")]: "{ providers: " } });
	assert.equal(await rejectionCode(() => createStore(fs).read({ hostId: HOST, file: "models" })), shared.WSL_CONFIG_CODES.fileInvalid);

	const nonObject = createFakeFs({ files: { [join(CONFIG_DIR, "settings.json")]: "[1,2,3]" } });
	assert.equal(await rejectionCode(() => createStore(nonObject.fs).read({ hostId: HOST, file: "settings" })), shared.WSL_CONFIG_CODES.fileInvalid);

	// UTF-8 BOM（Windows 手写文件）必须兼容。
	const bom = createFakeFs({ files: { [join(CONFIG_DIR, "settings.json")]: '\uFEFF{"theme":"dark"}' } });
	const snapshot = await createStore(bom.fs).read({ hostId: HOST, file: "settings" });
	assert.deepEqual(JSON.parse(JSON.stringify(snapshot.data)), { theme: "dark" });
});

test("models.json 保存沿用本地校验：不合格内容不落盘", async () => {
	const { fs, calls } = createFakeFs();
	const store = createStore(fs);
	const badName = await store.saveModels({ hostId: HOST, data: { providers: { "../evil": { models: [] } } } });
	assert.equal(badName.valid, false);
	assert.match(badName.error, /providerNameInvalid/);
	const badModel = await store.saveModels({ hostId: HOST, data: { providers: { openai: { models: [{ id: "x".repeat(300) }] } } } });
	assert.equal(badModel.valid, false);
	assert.match(badModel.error, /modelIdInvalid/);
	const noModels = await store.saveModels({ hostId: HOST, data: { providers: { openai: {} } } });
	assert.equal(noModels.valid, false);
	assert.match(noModels.error, /providerModelsRequired/);
	assert.deepEqual(
		calls.filter((call) => call[0] === "write"),
		[],
		"校验失败不得写盘",
	);

	const saved = await store.saveModels({ hostId: HOST, data: { providers: { openai: { baseUrl: "https://api.example.com/v1", models: [{ id: "gpt-4o" }] } } } });
	assert.equal(saved.valid, true);
	assert.deepEqual(JSON.parse(JSON.stringify(saved.receipt)), { kind: "wsl", hostId: HOST, file: "models" });
	const written = calls.filter((call) => call[0] === "write");
	assert.equal(written.length, 1);
	assert.equal(written[0][1], join(CONFIG_DIR, "models.json"));
	assert.deepEqual(JSON.parse(written[0][2]), { providers: { openai: { baseUrl: "https://api.example.com/v1", models: [{ id: "gpt-4o" }] } } });
});

test("settings.json 保存沿用本地合并规则：资源键以磁盘为准", async () => {
	const settingsPath = join(CONFIG_DIR, "settings.json");
	const { fs, calls } = createFakeFs({ files: { [settingsPath]: JSON.stringify({ packages: ["npm:pi-x"], theme: "light" }) } });
	const saved = await createStore(fs).saveSettings({ hostId: HOST, settings: { theme: "dark" } });
	assert.equal(saved.valid, true);
	const written = calls.filter((call) => call[0] === "write");
	assert.equal(written.length, 1);
	assert.equal(written[0][1], settingsPath);
	// 表单没编辑资源键：磁盘上的 packages 不能被页面快照冲掉。
	assert.deepEqual(JSON.parse(written[0][2]), { packages: ["npm:pi-x"], theme: "dark" });

	// 磁盘上的 settings.json 损坏时拒绝覆盖（否则用户手写内容会被静默写没）。
	const corrupt = createFakeFs({ files: { [settingsPath]: "{ oops" } });
	assert.equal(await rejectionCode(() => createStore(corrupt.fs).saveSettings({ hostId: HOST, settings: { theme: "dark" } })), shared.WSL_CONFIG_CODES.fileInvalid);
	assert.deepEqual(
		corrupt.calls.filter((call) => call[0] === "write"),
		[],
	);
});

test("保存路径也要先判定环境：档案/发行版/路径不可用时回稳定码且不写", async () => {
	const { fs, calls } = createFakeFs({ dirs: [] });
	assert.equal(await rejectionCode(() => createStore(fs).saveModels({ hostId: HOST, data: { providers: {} } })), shared.WSL_CONFIG_CODES.distroUnavailable);
	assert.deepEqual(
		calls.filter((call) => call[0] === "read" || call[0] === "write"),
		[],
		"环境不可用时不得读写文件",
	);

	const gone = createFakeFs();
	assert.equal(await rejectionCode(() => createStore(gone.fs, { profiles: [] }).saveSettings({ hostId: HOST, settings: {} })), shared.WSL_CONFIG_CODES.hostNotFound);
	assert.deepEqual(gone.calls, []);
});

test("两个目标实例互不污染：解析出的目录只属于各自档案", async () => {
	const homeA = wslPaths.linuxPathToWslUnc("/home/dev", DISTRO);
	const homeB = wslPaths.linuxPathToWslUnc("/root", "Ubuntu-24.04");
	const callsA = [];
	const callsB = [];
	const fsA = {
		async statDirectory(path) {
			callsA.push(path);
			return { isDirectory: true };
		},
		async readTextFile() {
			return null;
		},
		async writeTextFile() {},
	};
	const fsB = {
		async statDirectory(path) {
			callsB.push(path);
			return { isDirectory: true };
		},
		async readTextFile() {
			return null;
		},
		async writeTextFile() {},
	};
	const storeA = createStore(fsA, { environment: { distro: DISTRO, user: "dev", linuxHome: "/home/dev", windowsHome: homeA } });
	const storeB = storeModule.createWslPiConfigStore({
		listProfiles: async () => [{ id: "22222222-2222-4222-8222-222222222222", label: "root", distro: "Ubuntu-24.04", user: "root" }],
		resolveEnvironment: async () => ({ distro: "Ubuntu-24.04", user: "root", linuxHome: "/root", windowsHome: homeB }),
		fs: fsB,
		translate: (key) => key,
	});
	await storeA.read({ hostId: HOST, file: "models" });
	await storeB.read({ hostId: "22222222-2222-4222-8222-222222222222", file: "settings" });
	assert.ok(callsA.includes(homeA), "A 只碰自己的 HOME");
	assert.ok(!callsA.includes(homeB), "A 不得读 B 的 HOME");
	assert.ok(callsB.includes(homeB), "B 只碰自己的 HOME");
	// 没有共享单例目录：再读一次 A 仍落在 A。
	await storeA.read({ hostId: HOST, file: "settings" });
	assert.equal(callsA.filter((path) => path === homeB).length, 0);
});

test("默认 fs 端口的写入是临时文件 + rename：落盘完整、无残留临时文件", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-wsl-config-"));
	try {
		const realFs = storeModule.createNodeWslPiConfigFileSystem();
		const configDir = join(root, ".pi", "agent");
		const store = storeModule.createWslPiConfigStore({
			listProfiles: async () => [PROFILE],
			resolveEnvironment: async () => ({ distro: DISTRO, user: USER, linuxHome: LINUX_HOME, windowsHome: root }),
			fs: {
				statDirectory: async (path) => (path === DISTRO_ROOT ? { isDirectory: true } : realFs.statDirectory(path)),
				readTextFile: realFs.readTextFile,
				writeTextFile: realFs.writeTextFile,
			},
			translate: (key) => key,
		});
		const saved = await store.saveModels({ hostId: HOST, data: { providers: { openai: { models: [{ id: "gpt-4o" }] } } } });
		assert.equal(saved.valid, true);
		const entries = await readdir(configDir);
		assert.deepEqual(entries, ["models.json"], "只留目标文件，不残留 .tmp");
		const raw = await readFile(join(configDir, "models.json"), "utf8");
		assert.deepEqual(JSON.parse(raw), { providers: { openai: { models: [{ id: "gpt-4o" }] } } });
		// 覆盖写也要收敛到同一份文件（可重入）。
		await store.saveModels({ hostId: HOST, data: { providers: {} } });
		assert.deepEqual(await readdir(configDir), ["models.json"]);
		assert.deepEqual(JSON.parse(await readFile(join(configDir, "models.json"), "utf8")), { providers: {} });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
