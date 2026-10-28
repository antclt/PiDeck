import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { readHostPluginPackage, readPluginFile } = loadTsCommonJs("src/main/plugins/hostPluginFiles.ts");
const { HostPluginManager } = loadTsCommonJs("src/main/plugins/HostPluginManager.ts");

/**
 * 随包内置宿主插件（`resources/host-plugins/<id>/`，由 `HostPluginManager.seedBuiltin` 落位）的出厂契约。
 *
 * 为什么需要这层守卫：`seedBuiltin` 对任何读取失败都是 `.catch(() => undefined)` 静默跳过——
 * 内置包少一个文件、manifest 写错、入口指向不存在的资产，用户侧只会「这个插件没了」，
 * 没有任何报错。这里把「能装、能落位、能力面没偷偷扩大」钉成测试。
 */
const BUILTIN_DIRECTORY = join(process.cwd(), "resources", "host-plugins");

/**
 * 内置插件的已审能力面登记表：权限/服务/面板形态变化必须先审一遍数据外发与命令执行风险，再改这里。
 * 新增内置插件也要先登记——测试要求目录与登记表一一对应，避免「悄悄多了一个随包插件」。
 */
const BUILTIN_PLUGINS = {
	"billion-context": { permissions: ["service.local"], services: ["billion-context"], panelId: "main", presentation: "popover", icon: "activity" },
	"session-groups": { permissions: ["sessions.read", "sessions.read.workspace", "workbench.navigate", "sessionGroups.manage"], panelId: "main", presentation: "page", icon: "layers" },
};

/** 面板 HTML 引用的包内资产（`src`/`href`），外链与锚点单独判定，不当作包内路径。 */
function referencedAssets(html) {
	return [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
}

test("内置插件目录与登记表一一对应，每个包都能过安装校验", async () => {
	const entries = (await readdir(BUILTIN_DIRECTORY, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
	assert.deepEqual(entries.sort(), Object.keys(BUILTIN_PLUGINS).sort(), "新增/删除内置插件必须同步本文件的登记表");
	for (const name of entries) {
		const plugin = await readHostPluginPackage(join(BUILTIN_DIRECTORY, name));
		// seedBuiltin 按目录名落位，manifest.id 与目录名不一致会让授权记录落到另一个 id 上。
		assert.equal(plugin.manifest.id, name, `${name}: manifest.id 必须等于目录名`);
		assert.equal(plugin.manifest.apiVersion, 1);
		// manifest 自带 `pideck-plugin.json` 在资产表里，但宿主永不服务它（asset-not-allowed）；这里确认它没被漏进指纹。
		assert.ok(plugin.assets.has("pideck-plugin.json"));
	}
});

test("内置插件的面板入口只引用包内资产，不挂外链", async () => {
	for (const name of Object.keys(BUILTIN_PLUGINS)) {
		const plugin = await readHostPluginPackage(join(BUILTIN_DIRECTORY, name));
		const base = plugin.root;
		for (const panel of plugin.manifest.contributes.panels) {
			const html = (await readPluginFile(base, panel.entry)).toString("utf8");
			const directory = panel.entry.includes("/") ? panel.entry.slice(0, panel.entry.lastIndexOf("/") + 1) : "";
			for (const reference of referencedAssets(html)) {
				assert.equal(/^https?:\/\//i.test(reference), false, `${name}: 面板不能引用外链（CSP default-src 'none' 会直接拦掉）：${reference}`);
				if (reference.startsWith("#") || reference.startsWith("data:")) continue;
				const asset = join(directory, reference.replace(/^\.\//, ""));
				assert.ok(plugin.assets.has(asset), `${name}: 面板引用了没有随包的资产 ${asset}（漏复制 / 改名 / 大小写不一致）`);
			}
		}
	}
});

test("session-groups：能力面锁定在只读会话 + 工作区范围 + 工作台跳转", async () => {
	const plugin = await readHostPluginPackage(join(BUILTIN_DIRECTORY, "session-groups"));
	const expected = BUILTIN_PLUGINS["session-groups"];
	assert.deepEqual(Array.from(plugin.manifest.permissions), expected.permissions);
	// 分组关系只存插件私有 storage（不需要权限），因此它不该有任何网络/服务能力。
	assert.equal(plugin.manifest.network, undefined);
	assert.equal(plugin.manifest.services, undefined);
	assert.deepEqual(
		Array.from(plugin.manifest.contributes.panels, (panel) => ({ id: panel.id, entry: panel.entry, icon: panel.icon, presentation: panel.presentation })),
		[{ id: expected.panelId, entry: "app.html", icon: expected.icon, presentation: expected.presentation }],
	);
	// 侧栏入口靠已启用插件的面板声明；命令表可以为空，但不能指向不存在的面板。
	assert.deepEqual(Array.from(plugin.manifest.contributes.commands), []);
});

test("内置插件随包落位到 userData，默认仍是待授权状态", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-builtin-host-plugins-"));
	try {
		const manager = new HostPluginManager(join(root, "userData"));
		await manager.seedBuiltin(BUILTIN_DIRECTORY);
		await manager.load();
		const catalog = manager.catalog();
		assert.deepEqual(Array.from(catalog.issues), []);
		assert.deepEqual(Array.from(catalog.plugins, (plugin) => plugin.manifest.id).sort(), Object.keys(BUILTIN_PLUGINS).sort());
		// 落位 ≠ 授权：内置插件同样要用户在设置页按指纹批准，侧栏只列已启用面板。
		for (const plugin of catalog.plugins) {
			assert.equal(plugin.enabled, false, `${plugin.manifest.id}: 内置插件不得默认启用`);
			assert.equal(plugin.requiresConsent, true, `${plugin.manifest.id}: 内置插件首次落位必须重新授权`);
		}
		const sessionGroups = catalog.plugins.find((plugin) => plugin.manifest.id === "session-groups");
		const granted = await manager.setEnabled("session-groups", true, sessionGroups.fingerprint);
		assert.equal(granted.plugins.find((plugin) => plugin.manifest.id === "session-groups").enabled, true);
		// 内置插件不允许卸载（下次启动会被重新落位），要停用只能用禁用。
		await assert.rejects(() => manager.remove("session-groups"), /plugin-builtin/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/**
 * 内置载荷升级时的授权边界：权限没扩大才顺延，多要一项权限必须回到待授权。
 * 反例（本次 session-groups v1.6.0 → v2.0.0 新增 `sessions.read.workspace`）：顺延会让插件在用户没批准过的
 * 范围（整个工作区）上取数据，等于绕过设置页的授权。
 */
test("内置载荷升级只在权限没扩大时顺延授权", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-builtin-host-plugins-"));
	const baseline = join(root, "baseline", "example.plugin");
	const wider = join(root, "wider", "example.plugin");
	const narrower = join(root, "narrower", "example.plugin");
	const write = async (directory, version, permissions) => {
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "pideck-plugin.json"), JSON.stringify({ schemaVersion: 1, apiVersion: 1, id: "example.plugin", name: "Example", version, permissions, contributes: { panels: [{ id: "main", title: "Main", entry: "app.html" }], commands: [] } }));
		await writeFile(join(directory, "app.html"), "<!doctype html><p>example</p>");
	};
	await write(baseline, "1.0.0", ["sessions.read"]);
	await write(wider, "2.0.0", ["sessions.read", "sessions.read.workspace"]);
	await write(narrower, "1.1.0", ["sessions.read"]);
	try {
		const manager = new HostPluginManager(join(root, "userData"));
		await manager.seedBuiltin(join(root, "baseline"));
		await manager.load();
		const seeded = manager.catalog().plugins.find((plugin) => plugin.manifest.id === "example.plugin");
		assert.equal(seeded.manifest.version, "1.0.0");
		await manager.setEnabled("example.plugin", true, seeded.fingerprint);
		assert.equal(manager.catalog().plugins.find((plugin) => plugin.manifest.id === "example.plugin").enabled, true);

		// 同样权限的新版载荷：授权跟着走，用户不必每次升级都重新点一遍。
		await manager.seedBuiltin(join(root, "narrower"));
		await manager.load();
		const carried = manager.catalog().plugins.find((plugin) => plugin.manifest.id === "example.plugin");
		assert.equal(carried.manifest.version, "1.1.0");
		assert.equal(carried.enabled, true);

		// 多要一项权限：旧的授权不能顺延到加载物上。
		await manager.seedBuiltin(join(root, "wider"));
		await manager.load();
		const widened = manager.catalog().plugins.find((plugin) => plugin.manifest.id === "example.plugin");
		assert.equal(widened.manifest.version, "2.0.0");
		assert.equal(widened.enabled, false, "权限扩大的内置升级必须回到待授权");
		assert.equal(widened.requiresConsent, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
