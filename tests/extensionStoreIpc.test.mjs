import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 扩展商店（pi.dev Package Catalog）IPC 契约测试。
 *
 * 规则：新增 IPC 必须三处同步——shared/ipc.ts 通道、主进程 handler、preload 暴露；
 * 本文件以源码断言锁住这条链路，防止任何一处漏注册导致运行时 undefined。
 */

const ipcSource = readFileSync("src/shared/ipc.ts", "utf8");
const storeIpc = readFileSync("src/main/ipc/storeIpc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");

test("extensionsCatalog 通道名定义为 extensions:catalog", () => {
	assert.match(ipcSource, /extensionsCatalog: "extensions:catalog"/);
});

test("主进程 storeIpc 注册 extensionsCatalog handler 并转发到 getPiPackageCatalog", () => {
	assert.match(storeIpc, /ipcChannels\.extensionsCatalog/);
	assert.match(storeIpc, /getPiPackageCatalog/);
	assert.match(storeIpc, /store\.packageCatalogFailed/);
});

test("preload 暴露 extensions.catalog（带类型查询参数）", () => {
	assert.match(preload, /catalog: \(query: import\("\.\.\/shared\/types"\)\.PiPackageCatalogQuery\)/);
	assert.match(preload, /ipcChannels\.extensionsCatalog, query/);
});

test("解析模块不依赖 electron（可在纯 Node 环境测试）", () => {
	const source = readFileSync("src/main/extensions/piPackageCatalog.ts", "utf8");
	assert.doesNotMatch(source, /from ["']electron["']/);
	assert.match(source, /parsePackageCatalogHtml/);
	assert.match(source, /parseCatalogIndexMeta/);
	assert.match(source, /CATALOG_TTL_MS/);
});

test("共享类型同时从 shared/types 与 types.ts 出口", () => {
	const types = readFileSync("src/shared/types.ts", "utf8");
	assert.match(types, /export \* from "\.\/types\/packageCatalog"/);
	const pkgTypes = readFileSync("src/shared/types/packageCatalog.ts", "utf8");
	assert.match(pkgTypes, /export type PiPackageCatalogItem/);
	assert.match(pkgTypes, /export type PiPackageCatalogQuery/);
});

test("渲染层 ExtensionStoreTab 使用 catalog 查询并复用 extensions.install", () => {
	const tab = readFileSync("src/renderer/src/config/ExtensionStoreTab.tsx", "utf8");
	assert.match(tab, /api\.extensions\.catalog/);
	assert.match(tab, /api\.extensions\.install/);
	assert.match(tab, /installSource/);
	// 搜索防抖：查询变化后 300ms 回到第一页
	assert.match(tab, /setTimeout/);
});

test("ExtensionsTab 挂载商店 Tab（已安装/商店两级）", () => {
	const tab = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
	assert.match(tab, /ExtensionStoreTab/);
	assert.match(tab, /config\.extensionStoreTab/);
	assert.match(tab, /installedExtensions=/);
	assert.match(tab, /onInstalled=/);
});
