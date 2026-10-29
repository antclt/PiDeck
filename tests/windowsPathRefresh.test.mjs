/**
 * Windows PATH 自刷新契约测试:
 * 用户开着 PiDeck 时装了 CLI（Qoder CLI CN 的官网脚本只改注册表 PATH），已运行进程的
 * process.env 是启动快照 → spawn 出去一律「不是内部或外部命令」、设置页「检测」报未安装。
 * 这里锁住修复的四条硬规则:
 * - 只追加不重排（既有优先级、会话级 PATH 覆盖都不能被冲掉）；
 * - 大小写不敏感去重（Windows 路径语义）、去引号去空段；
 * - 读注册表失败/超时一律当没读到，不抛、不改 PATH；
 * - 5 秒记忆窗口内的重复调用不再打 PowerShell。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const pathRefresh = loadTsCommonJs("src/main/process/windowsPathRefresh.ts");
const { expandEnvReferences, splitPathList, appendMissingPaths, mergePathValues, parseRegQueryOutput, ensureWindowsPathFresh, resetWindowsPathRefreshCacheForTest } = pathRefresh;

/** 每个用例都从干净的记忆窗口开始（模块级缓存）。 */
function freshModule() {
	resetWindowsPathRefreshCacheForTest();
}

// 模块跑在 vm 沙箱里，返回的数组/对象是另一个 realm 的原型，deepStrictEqual 会比原型；
// 比较前统一搬回宿主 realm。
const list = (value) => Array.from(value);

test("splitPathList:去空白/去引号/丢空段", () => {
	assert.deepEqual(list(splitPathList(null)), []);
	assert.deepEqual(list(splitPathList("")), []);
	assert.deepEqual(list(splitPathList("C:\\a;C:\\b;")), ["C:\\a", "C:\\b"]);
	assert.deepEqual(list(splitPathList(" ; C:\\a ; ; ")), ["C:\\a"]);
	assert.deepEqual(list(splitPathList('"C:\\Program Files\\x";C:\\b')), ["C:\\Program Files\\x", "C:\\b"]);
	// 落单的引号不当成成对引号处理，避免把路径截断
	assert.deepEqual(list(splitPathList('"C:\\a')), ['"C:\\a']);
});

test("expandEnvReferences:%VAR% 按 env 展开(大小写不敏感)，展不开的原样保留", () => {
	const env = { USERPROFILE: "C:\\Users\\张三", SystemRoot: "C:\\Windows" };
	assert.equal(expandEnvReferences("%USERPROFILE%\\.qoder-cn\\bin", env), "C:\\Users\\张三\\.qoder-cn\\bin");
	assert.equal(expandEnvReferences("%userprofile%\\x", env), "C:\\Users\\张三\\x");
	// 外部引用（注册表里 %NVM_HOME% 这类）展不开就保留，不整条丢弃
	assert.equal(expandEnvReferences("%NVM_HOME%\\bin;%SystemRoot%", env), "%NVM_HOME%\\bin;C:\\Windows");
});

test("appendMissingPaths:只追加差集、不重排、大小写不敏感去重", () => {
	const current = "C:\\Windows;C:\\existing";
	const { value, added } = appendMissingPaths(current, ["C:\\WINDOWS", "C:\\new", "c:\\new", "C:\\Users\\me\\.qoder-cn\\bin"]);
	assert.equal(value, "C:\\Windows;C:\\existing;C:\\new;C:\\Users\\me\\.qoder-cn\\bin");
	assert.deepEqual(list(added), ["C:\\new", "C:\\Users\\me\\.qoder-cn\\bin"]);
	// 已在 PATH 里的目录不算新增
	assert.deepEqual(list(appendMissingPaths(current, ["c:\\existing"]).added), []);
	// 空 PATH 直接给新增项（不要以 ";" 开头）
	assert.equal(appendMissingPaths("", ["C:\\a"]).value, "C:\\a");
	assert.deepEqual(list(appendMissingPaths("", ["C:\\a"]).added), ["C:\\a"]);
	// 尾部多余的 ";" 不会堆积
	assert.equal(appendMissingPaths("C:\\a;;;", ["C:\\b"]).value, "C:\\a;C:\\b");
});

test("mergePathValues 与 appendMissingPaths 同源", () => {
	assert.equal(mergePathValues("C:\\a", ["C:\\b"]), appendMissingPaths("C:\\a", ["C:\\b"]).value);
});

test("parseRegQueryOutput:认 REG_SZ 与 REG_EXPAND_SZ，缺 Path 行返回 null", () => {
	const expanded = ["HKEY_CURRENT_USER\\Environment", "    Path    REG_EXPAND_SZ    %USERPROFILE%\\.qoder-cn\\bin;C:\\x", ""].join("\r\n");
	assert.equal(parseRegQueryOutput(expanded), "%USERPROFILE%\\.qoder-cn\\bin;C:\\x");
	const plain = "    Path    REG_SZ    C:\\Windows";
	assert.equal(parseRegQueryOutput(plain), "C:\\Windows");
	assert.equal(parseRegQueryOutput("HKEY_CURRENT_USER\\Environment\r\n    TEMP    REG_SZ    C:\\Temp"), null);
});

test("ensureWindowsPathFresh:非 win32 直接返回空数组", async () => {
	freshModule();
	const env = { PATH: "C:\\Windows" };
	assert.deepEqual(list(await ensureWindowsPathFresh({ platform: "linux", env, readRegistryPath: async () => "C:\\x" })), []);
	assert.equal(env.PATH, "C:\\Windows");
});

test("ensureWindowsPathFresh:把注册表新增目录补进 env.PATH 并回报 added", async () => {
	freshModule();
	// 模拟中文用户名 + REG_EXPAND_SZ 引用 + 已在 PATH 里的重复项
	const env = { PATH: "C:\\Windows;C:\\existing", USERPROFILE: "C:\\Users\\张三" };
	const added = [];
	let now = 1_000;
	const result = await ensureWindowsPathFresh({
		platform: "win32",
		env,
		now: () => now,
		onAdded: (directories) => added.push(...directories),
		readRegistryPath: async (hive) =>
			hive === "user" ? "%USERPROFILE%\\.qoder-cn\\bin;C:\\existing" : "C:\\Windows\\System32;C:\\Program Files\\nodejs",
	});
	// 去重按整条路径做（不按父子目录），所以 machine 里的 System32 确实算新增
	assert.deepEqual(list(result), ["C:\\Users\\张三\\.qoder-cn\\bin", "C:\\Windows\\System32", "C:\\Program Files\\nodejs"]);
	assert.equal(env.PATH, "C:\\Windows;C:\\existing;C:\\Users\\张三\\.qoder-cn\\bin;C:\\Windows\\System32;C:\\Program Files\\nodejs");
	assert.deepEqual(list(added), list(result));
});

test("ensureWindowsPathFresh:无新增时原样保留 PATH，不写 env", async () => {
	freshModule();
	const env = { PATH: "C:\\Windows" };
	const before = env.PATH;
	const result = await ensureWindowsPathFresh({ platform: "win32", env, readRegistryPath: async () => "c:\\windows;" });
	assert.deepEqual(list(result), []);
	assert.equal(env.PATH, before);
});

test("ensureWindowsPathFresh:读注册表失败/抛错时不动 PATH", async () => {
	freshModule();
	const env = { PATH: "C:\\Windows" };
	const emptyRead = await ensureWindowsPathFresh({
		platform: "win32",
		env,
		readRegistryPath: async () => {
			throw new Error("reg query failed");
		},
	});
	assert.deepEqual(list(emptyRead), []);
	assert.equal(env.PATH, "C:\\Windows");

	freshModule();
	assert.deepEqual(list(await ensureWindowsPathFresh({ platform: "win32", env, readRegistryPath: async () => null })), []);
	assert.equal(env.PATH, "C:\\Windows");
});

test("ensureWindowsPathFresh:5 秒记忆窗口内不重复读注册表", async () => {
	freshModule();
	const env = { PATH: "C:\\Windows" };
	let reads = 0;
	let now = 1_000;
	const options = {
		platform: "win32",
		env,
		now: () => now,
		readRegistryPath: async () => {
			reads += 1;
			return "C:\\Windows";
		},
	};
	await ensureWindowsPathFresh(options);
	await ensureWindowsPathFresh(options);
	assert.equal(reads, 2, "一次刷新读 user+machine 两个 hive，第二次调用走缓存");
	// 窗口过后再刷
	now += 6_000;
	await ensureWindowsPathFresh(options);
	assert.equal(reads, 4);
});
