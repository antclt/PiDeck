/**
 * 更新检查无配额方案测试（src/main/update/）。
 *
 * 覆盖：
 * - latest.yml / atom feed / 重定向 URL 解析（githubFeed 纯函数）；
 * - checkAppUpdate 主路径（latest.yml）与降级路径（atom + API 兜底）编排；
 * - 版本比较与资产推荐。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, requireOverride) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = requireOverride
		? (specifier) => requireOverride(specifier) ?? nodeRequire(specifier)
		: nodeRequire;
	vm.runInNewContext(output, { module, exports: module.exports, require: localRequire, console, URL: globalThis.URL, process: globalThis.process }, { filename: filePath });
	return module.exports;
}

const githubFeed = compileModule("src/main/update/githubFeed.ts");
const appUpdateCheck = compileModule("src/main/update/appUpdateCheck.ts", (specifier) => {
	if (specifier === "./githubFeed") return githubFeed;
	return null;
});

const { parseLatestYml, parseAtomFeed, extractTagFromRedirectUrl, extractTagFromAtomLink, compareVersions, latestYmlAssets, createGithubRepo, getChannelFilename, fetchLatestYml } = githubFeed;
const { checkAppUpdate, selectRecommendedAsset } = appUpdateCheck;

// ── 解析层 ──────────────────────────────────────────────────────────

test("parseLatestYml: 标准 electron-builder 结构", () => {
	const text = [
		"version: 2.0.0",
		"files:",
		"  - url: PiDeck-2.0.0-win.exe",
		"    sha512: aaa",
		"    size: 12345",
		"  - url: PiDeck-2.0.0-setup.exe",
		"    sha512: bbb",
		"    size: 67890",
		"path: PiDeck-2.0.0-setup.exe",
		"sha512: bbb",
		"releaseDate: 2026-06-01T00:00:00.000Z",
	].join("\n");
	const info = parseLatestYml(text);
	assert.ok(info);
	assert.equal(info.version, "2.0.0");
	assert.equal(info.files.length, 2);
	assert.equal(info.files[0].url, "PiDeck-2.0.0-win.exe");
	assert.equal(info.files[0].size, 12345);
	assert.equal(info.files[0].sha512, "aaa");
	assert.equal(info.releaseDate, "2026-06-01T00:00:00.000Z");
});

test("parseLatestYml: 缺 version 返回 null", () => {
	assert.equal(parseLatestYml("files:\n  - url: x.exe\n"), null);
	assert.equal(parseLatestYml(""), null);
	assert.equal(parseLatestYml(null), null);
});

test("parseAtomFeed: 解析第一个 entry 的 tag/标题/说明", () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Releases · ayuayue/PiDeck</title>
  <entry>
    <title>v2.0.0</title>
    <link rel="alternate" href="https://github.com/ayuayue/PiDeck/releases/tag/v2.0.0"/>
    <published>2026-06-01T00:00:00Z</published>
    <content type="html">What&amp;#39;s new</content>
  </entry>
  <entry>
    <title>v1.9.0</title>
    <link rel="alternate" href="https://github.com/ayuayue/PiDeck/releases/tag/v1.9.0"/>
  </entry>
</feed>`;
	const info = parseAtomFeed(xml);
	assert.ok(info);
	assert.equal(info.tag, "v2.0.0");
	assert.equal(info.version, "2.0.0");
	assert.equal(info.releaseName, "v2.0.0");
	assert.equal(info.publishedAt, "2026-06-01T00:00:00Z");
	assert.ok(info.releaseNotes);
});

test("parseAtomFeed: 无 entry/无 tag 返回 null", () => {
	assert.equal(parseAtomFeed("<feed></feed>"), null);
	assert.equal(parseAtomFeed(""), null);
});

test("extractTagFromRedirectUrl / extractTagFromAtomLink", () => {
	assert.equal(extractTagFromRedirectUrl("https://github.com/ayuayue/PiDeck/releases/tag/v2.0.0"), "v2.0.0");
	assert.equal(extractTagFromRedirectUrl("https://github.com/ayuayue/PiDeck/releases/tag/v2.0.0/"), "v2.0.0");
	assert.equal(extractTagFromRedirectUrl("https://github.com/other/repo/releases"), null);
	assert.equal(extractTagFromAtomLink("https://github.com/ayuayue/PiDeck/releases/tag/v1.9.0"), "v1.9.0");
	assert.equal(extractTagFromAtomLink("https://github.com/o/r/releases/tag/beta-1"), "beta-1");
});

test("getChannelFilename: 平台 channel 元数据文件名", () => {
	assert.equal(getChannelFilename("win32"), "latest.yml");
	assert.equal(getChannelFilename("darwin"), "latest-mac.yml");
	assert.equal(getChannelFilename("linux"), "latest-linux.yml");
});

test("fetchLatestYml: 按平台 channel 文件名下载", async () => {
	const repo = createGithubRepo("ayuayue", "PiDeck");
	const urls = [];
	const fetchImpl = async (url) => {
		urls.push(url);
		return { ok: true, status: 200, url, text: async () => "version: 1.0.0\nfiles:\n  - url: a.dmg\n", json: async () => ({}) };
	};
	await fetchLatestYml("v1.0.0", repo, fetchImpl, "latest-mac.yml");
	assert.equal(urls[0], "https://github.com/ayuayue/PiDeck/releases/download/v1.0.0/latest-mac.yml");
	// 默认：跟随当前平台（win 测试环境为 latest.yml）
	await fetchLatestYml("v1.0.0", repo, fetchImpl);
	assert.equal(urls[1], "https://github.com/ayuayue/PiDeck/releases/download/v1.0.0/latest.yml");
});

test("compareVersions / 资产 URL 构造", () => {
	assert.equal(compareVersions("2.0.0", "1.9.0"), 1);
	assert.equal(compareVersions("v1.9.0", "v1.9.0"), 0);
	assert.equal(compareVersions("1.9.0", "2.0.0"), -1);
	assert.equal(compareVersions("1.9.0", "1.10.0"), -1);
	// 预发布语义（semver 对齐）：同版本号下正式版 > 测试版，
	// beta 客户端（如 0.7.2-beta）在正式版发布后必须收到更新提示。
	assert.equal(compareVersions("0.7.2", "0.7.2-beta"), 1);
	assert.equal(compareVersions("0.7.2-beta", "0.7.2"), -1);
	// 更新核心号的 beta 仍高于旧正式版；beta 迭代之间按数字比
	assert.equal(compareVersions("0.7.2-beta", "0.7.1"), 1);
	assert.equal(compareVersions("0.7.2-beta.2", "0.7.2-beta.1"), 1);
	assert.equal(compareVersions("0.7.2-beta", "0.7.2-beta"), 0);
	const repo = createGithubRepo("ayuayue", "PiDeck");
	const assets = latestYmlAssets(
		{ version: "2.0.0", files: [{ url: "PiDeck-2.0.0-setup.exe", size: 100 }] },
		repo,
		"v2.0.0",
	);
	assert.equal(assets[0].url, "https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/PiDeck-2.0.0-setup.exe");
	assert.equal(assets[0].size, 100);
});

// ── checkAppUpdate 编排 ──────────────────────────────────────────────

function mockFetch(routes) {
	return async (url, init) => {
		const method = init?.method ?? "GET";
		for (const [prefix, handler] of routes) {
			if (url.startsWith(prefix)) return handler(url, method);
		}
		throw new Error(`unexpected fetch: ${method} ${url}`);
	};
}
function okResponse(body, url = "") {
	return { ok: true, status: 200, url, text: async () => body, json: async () => JSON.parse(body) };
}
function notFound(url) {
	return { ok: false, status: 404, url, text: async () => "not found", json: async () => ({}) };
}

const LATEST_YML = [
	"version: 2.0.0",
	"files:",
	"  - url: PiDeck-2.0.0-setup.exe",
	"    sha512: aaa",
	"    size: 100",
	"  - url: PiDeck-2.0.0-portable.exe",
	"    sha512: bbb",
	"    size: 50",
	"path: PiDeck-2.0.0-setup.exe",
	"sha512: aaa",
	"releaseDate: 2026-06-01T00:00:00.000Z",
].join("\n");

const ATOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>v2.0.0</title>
    <link rel="alternate" href="https://github.com/ayuayue/PiDeck/releases/tag/v2.0.0"/>
    <published>2026-06-01T00:00:00Z</published>
    <content type="html">Release notes here</content>
  </entry>
</feed>`;

test("checkAppUpdate: 主路径 latest.yml + atom 补齐说明", async () => {
	const calls = [];
	const headCalls = [];
	const fetchImpl = mockFetch([
		["https://github.com/ayuayue/PiDeck/releases/latest", () => okResponse("", "https://github.com/ayuayue/PiDeck/releases/tag/v2.0.0")],
		["https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/latest.yml", () => { calls.push("yml"); return okResponse(LATEST_YML); }],
		["https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/PiDeck-2.0.0", (url, method) => {
			// 推荐资产可用性 HEAD 探测（原名可用 → URL 不变）
			if (method !== "HEAD") throw new Error(`unexpected GET: ${url}`);
			headCalls.push(url);
			return okResponse("", url);
		}],
		["https://github.com/ayuayue/PiDeck/releases.atom", () => { calls.push("atom"); return okResponse(ATOM_XML); }],
	]);
	const info = await checkAppUpdate({
		owner: "ayuayue",
		repo: "PiDeck",
		currentVersion: "1.9.0",
		installationType: "installed",
		fetchImpl,
	});
	assert.ok(info.hasUpdate);
	assert.equal(info.latestVersion, "2.0.0");
	assert.equal(info.releaseNotes, "Release notes here");
	assert.equal(info.assets.length, 2);
	assert.equal(info.recommendedAsset?.name, "PiDeck-2.0.0-setup.exe");
	assert.equal(info.recommendedAsset?.url, "https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/PiDeck-2.0.0-setup.exe");
	assert.equal(headCalls.length, 1);
	assert.deepEqual(calls.sort(), ["atom", "yml"]);
	// 无更新时不提示，也不做推荐资产 HEAD 探测
	const upToDate = await checkAppUpdate({
		owner: "ayuayue",
		repo: "PiDeck",
		currentVersion: "2.0.0",
		installationType: "installed",
		fetchImpl,
	});
	assert.equal(upToDate.hasUpdate, false);
	assert.equal(headCalls.length, 1);
});

test("checkAppUpdate: 推荐资产原名 404 时回退命名变体（GitHub 空格→点号）", async () => {
	// v0.7.1 实测场景：latest.yml 写连字符名，GitHub 真实资产是点号名（空格被 GitHub 替换）。
	const headUrls = [];
	const fetchImpl = mockFetch([
		["https://github.com/ayuayue/PiDeck/releases/latest", () => okResponse("", "https://github.com/ayuayue/PiDeck/releases/tag/v2.0.0")],
		["https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/latest.yml", () => okResponse(LATEST_YML)],
		["https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/PiDeck-2.0.0", (url, method) => {
			if (method !== "HEAD") throw new Error(`unexpected GET: ${url}`);
			headUrls.push(url);
			return notFound(url);
		}],
		["https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/PiDeck.2.0.0", (url, method) => {
			if (method !== "HEAD") throw new Error(`unexpected GET: ${url}`);
			headUrls.push(url);
			return okResponse("", url);
		}],
		["https://github.com/ayuayue/PiDeck/releases.atom", () => okResponse(ATOM_XML)],
	]);
	const info = await checkAppUpdate({
		owner: "ayuayue",
		repo: "PiDeck",
		currentVersion: "1.9.0",
		installationType: "installed",
		fetchImpl,
	});
	assert.ok(info.hasUpdate);
	// URL 修正为点号变体；展示名保持 latest.yml 的原名
	assert.equal(info.recommendedAsset?.url, "https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/PiDeck.2.0.0.setup.exe");
	assert.equal(info.recommendedAsset?.name, "PiDeck-2.0.0-setup.exe");
	assert.equal(headUrls.length, 2);
});

test("checkAppUpdate: 推荐资产全部变体不可用时放弃（UI 回退浏览器下载）", async () => {
	const fetchImpl = mockFetch([
		["https://github.com/ayuayue/PiDeck/releases/latest", () => okResponse("", "https://github.com/ayuayue/PiDeck/releases/tag/v2.0.0")],
		["https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/latest.yml", () => okResponse(LATEST_YML)],
		["https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/PiDeck-2.0.0", (url, method) => {
			if (method !== "HEAD") throw new Error(`unexpected GET: ${url}`);
			return notFound(url);
		}],
		["https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/PiDeck.2.0.0", (url, method) => {
			if (method !== "HEAD") throw new Error(`unexpected GET: ${url}`);
			return notFound(url);
		}],
		["https://github.com/ayuayue/PiDeck/releases.atom", () => okResponse(ATOM_XML)],
	]);
	const info = await checkAppUpdate({
		owner: "ayuayue",
		repo: "PiDeck",
		currentVersion: "1.9.0",
		installationType: "installed",
		fetchImpl,
	});
	// 检查本身不失败：hasUpdate/说明/资产清单保留，仅放弃应用内下载推荐
	assert.ok(info.hasUpdate);
	assert.equal(info.recommendedAsset, undefined);
	assert.equal(info.assets.length, 2);
	assert.ok(info.releaseUrl);
});

test("checkAppUpdate: latest.yml 404 时降级 atom + API 资产兜底", async () => {
	const fetchImpl = mockFetch([
		["https://github.com/ayuayue/PiDeck/releases/latest", () => okResponse("", "https://github.com/ayuayue/PiDeck/releases/tag/v2.0.0")],
		["https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/latest.yml", () => notFound("")],
		["https://github.com/ayuayue/PiDeck/releases.atom", () => okResponse(ATOM_XML)],
		["https://api.github.com/repos/ayuayue/PiDeck/releases/tags/v2.0.0", () => okResponse(JSON.stringify({
			tag_name: "v2.0.0",
			assets: [{ name: "PiDeck-2.0.0-setup.exe", browser_download_url: "https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/PiDeck-2.0.0-setup.exe", size: 100 }],
		}))],
	]);
	const info = await checkAppUpdate({
		owner: "ayuayue",
		repo: "PiDeck",
		currentVersion: "1.9.0",
		installationType: "installed",
		fetchImpl,
	});
	assert.ok(info.hasUpdate);
	assert.equal(info.latestVersion, "2.0.0");
	assert.equal(info.assets.length, 1);
	assert.equal(info.assets[0].name, "PiDeck-2.0.0-setup.exe");
});

test("checkAppUpdate: 全部失败时抛错（上层转用户可读文案）", async () => {
	const fetchImpl = mockFetch([
		["https://github.com/ayuayue/PiDeck/releases/latest", () => notFound("")],
	]);
	await assert.rejects(
		checkAppUpdate({ owner: "ayuayue", repo: "PiDeck", currentVersion: "1.9.0", installationType: "installed", fetchImpl }),
		/GitHub latest release redirect failed/,
	);
});

test("checkAppUpdate: 正式版发布后，同版本号 beta 客户端能收到提示", async () => {
	const fetchImpl = mockFetch([
		["https://github.com/ayuayue/PiDeck/releases/latest", () => okResponse("", "https://github.com/ayuayue/PiDeck/releases/tag/v2.0.0")],
		["https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/latest.yml", () => okResponse(LATEST_YML)],
		["https://github.com/ayuayue/PiDeck/releases/download/v2.0.0/PiDeck-2.0.0", (url, method) => {
			if (method !== "HEAD") throw new Error(`unexpected GET: ${url}`);
			return okResponse("", url);
		}],
		["https://github.com/ayuayue/PiDeck/releases.atom", () => okResponse(ATOM_XML)],
	]);
	const info = await checkAppUpdate({
		owner: "ayuayue",
		repo: "PiDeck",
		currentVersion: "2.0.0-beta",
		installationType: "installed",
		fetchImpl,
	});
	// 0.7.2-beta < 0.7.2：beta 测试客户端在正式版发布后必须收到更新提示
	assert.ok(info.hasUpdate);
});

test("selectRecommendedAsset: 安装版优先 Setup exe", () => {
	const assets = [
		{ name: "PiDeck-2.0.0-portable.exe", url: "x", size: 1 },
		{ name: "PiDeck-2.0.0-setup.exe", url: "y", size: 2 },
		{ name: "PiDeck-2.0.0-win.zip", url: "z", size: 3 },
	];
	// 安装版（无 PORTABLE_EXECUTABLE_DIR）：优先 Setup
	assert.equal(selectRecommendedAsset(assets, "installed")?.name, "PiDeck-2.0.0-setup.exe");
});
