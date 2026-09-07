/**
 * pi-ai 目录更新（npm latest 主源 + 防降级）单测。
 *
 * 背景：旧更新器从 PiDeck 仓库 main 分支拉预生成件，main 停在 0.85.0 而本地内置
 * 已是 0.85.1，且比较用 `!==` 会把更旧的 0.85.0 误报为「新版本」并降级覆盖。
 * 修复：主源改为 @earendil-works/pi-ai npm latest（运行时生成），比较改语义版本，
 * 远端不高于当前生效版本时 hasUpdate=false / update 不写（防降级）。
 *
 * 测试用 fetch 替身模拟 npm registry latest + jsDelivr flat + 单文件，不触网。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PiAiCatalogUpdater } = loadTsCommonJs("src/main/pi/PiAiCatalogUpdater.ts");

function okResponse(text) {
	return { ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
}

/** 构造一份合法的来源数据文件内容（{ group: { modelId: model } }）。 */
function demoDataFileContent(modelId = "model-a") {
	return JSON.stringify({
		demo: {
			[modelId]: {
				id: modelId,
				name: "Model A",
				provider: "demo",
				contextWindow: 1000,
			},
		},
	});
}

/**
 * npm 源 fetch 替身：只认识 npm registry latest、jsDelivr flat 列表、jsDelivr 单文件。
 * version 为 latest 返回的版本号；dataFiles 为 flat 列表里的文件名（不含目录前缀）。
 */
function makeNpmFetch(version, dataFiles) {
	return async (url) => {
		if (url.includes("registry.npmmirror.com") || url.includes("registry.npmjs.org")) {
			if (!url.endsWith("/latest")) throw new Error(`unexpected npm url ${url}`);
			return okResponse(JSON.stringify({ version }));
		}
		if (url.includes("data.jsdelivr.com") && url.endsWith("/flat")) {
			const files = dataFiles.map((name) => ({ name: `/dist/providers/data/${name}` }));
			return okResponse(JSON.stringify({ files }));
		}
		if (url.includes("cdn.jsdelivr.net")) {
			const after = url.split("pi-ai@")[1] ?? "";
			const name = after.split("/").slice(1).join("/"); // dist/providers/data/<file>
			const file = name.slice("dist/providers/data/".length);
			if (!dataFiles.includes(file)) throw new Error(`unexpected file ${url}`);
			return okResponse(demoDataFileContent(file));
		}
		throw new Error(`unexpected url ${url}`);
	};
}

function tempDir() {
	return mkdtempSync(join(tmpdir(), "pideck-catalog-npm-"));
}

function cleanup(dir) {
	rmSync(dir, { recursive: true, force: true });
}

test("catalog:update npm latest 高于本地（9.9.9）：写入覆盖层并生效", async () => {
	const dir = tempDir();
	try {
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeNpmFetch("9.9.9", ["demo.json"]),
			timeoutMs: 200,
		});
		const result = await updater.update("main");
		assert.equal(result.ok, true);
		assert.equal(result.updated, true);
		const status = updater.getStatus();
		assert.equal(status.overlay?.packageVersion, "9.9.9");
		assert.equal(status.overlay?.entryCount, 1);
		assert.ok(existsSync(join(dir, "pi-ai-catalog.json")));
	} finally {
		cleanup(dir);
	}
});

test("catalog: 防降级 —— npm latest 0.85.0 不高于本地内置 0.85.1：不写不覆盖", async () => {
	const dir = tempDir();
	try {
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeNpmFetch("0.85.0", ["demo.json"]),
			timeoutMs: 200,
		});
		const result = await updater.update("main");
		assert.equal(result.ok, true);
		assert.equal(result.updated, false, "远端不高于本地时不得覆盖写");
		assert.equal(existsSync(join(dir, "pi-ai-catalog.json")), false, "未发生降级写，仍用内置");
		assert.equal(existsSync(join(dir, "pi-ai-catalog.manifest.json")), false);
	} finally {
		cleanup(dir);
	}
});

test("catalog: 检查更新 —— 远端 0.85.0 相对本地 0.85.1 应 hasUpdate=false（修掉误报降级）", async () => {
	const dir = tempDir();
	try {
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeNpmFetch("0.85.0", ["demo.json"]),
			timeoutMs: 200,
		});
		const checked = await updater.checkRemote("main");
		assert.equal(checked.ok, true);
		assert.equal(checked.remoteVersion, "0.85.0");
		assert.equal(checked.hasUpdate, false, "0.85.0 比本地 0.85.1 旧，不应报新版本");
	} finally {
		cleanup(dir);
	}
});

test("catalog: 检查更新 —— 远端 9.9.9 高于本地应 hasUpdate=true", async () => {
	const dir = tempDir();
	try {
		const updater = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeNpmFetch("9.9.9", ["demo.json"]),
			timeoutMs: 200,
		});
		const checked = await updater.checkRemote("main");
		assert.equal(checked.ok, true);
		assert.equal(checked.remoteVersion, "9.9.9");
		assert.equal(checked.hasUpdate, true);
	} finally {
		cleanup(dir);
	}
});

test("catalog: 已有覆盖层时，npm latest 不高于覆盖层也不覆盖", async () => {
	const dir = tempDir();
	try {
		// 先用分支回退源写入一个高版本覆盖层，再验证 npm 低版本不覆盖。
		// 这里直接用一个能写覆盖层的路径：npm 9.9.9 写入。
		const newer = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeNpmFetch("9.9.9", ["demo.json"]),
			timeoutMs: 200,
		});
		await newer.update("main");
		// 再模拟 npm 返回 1.0.0（低于覆盖层 9.9.9）：不得覆盖。
		const downgrade = new PiAiCatalogUpdater({
			userDataDir: dir,
			fetchImpl: makeNpmFetch("1.0.0", ["demo.json"]),
			timeoutMs: 200,
		});
		const result = await downgrade.update("main");
		assert.equal(result.ok, true);
		assert.equal(result.updated, false);
		assert.equal(downgrade.getStatus().overlay?.packageVersion, "9.9.9", "覆盖层仍为更高版本");
	} finally {
		cleanup(dir);
	}
});
