import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DshRuntimeInstaller } = loadTsCommonJs("src/main/dsh/runtime/DshRuntimeInstaller.ts");

const APP_VERSION = "0.7.5";

const release = (over = {}) => ({
	runtimeVersion: "0.1.1-rc.2",
	minAppVersion: "0.7.0",
	maxAppVersion: "",
	url: "https://example.test/r.tgz",
	sha256: "abc",
	size: 100,
	...over,
});

/** 组装一个 installer，manager 用替身（不碰磁盘与网络）。 */
function makeInstaller({ index = { schemaVersion: 1, releases: [release()] }, url = "https://idx.test/i.json", manager = {} } = {}) {
	const progress = [];
	const calls = { installFromUrl: [], installFromArchive: [], uninstall: [] };
	const fakeManager = {
		installFromUrl: async (archiveUrl, sha256, options) => {
			calls.installFromUrl.push({ archiveUrl, sha256, options });
			// 复刻真实 manager 的阶段回调顺序（下载字节 → 校验 → 解压 → 落位）
			options?.onPhase?.("downloading");
			options?.onDownloadProgress?.(50, 100);
			for (const phase of ["verifying", "extracting", "finalizing"]) options?.onPhase?.(phase);
			return manager.installFromUrl ? manager.installFromUrl() : { ok: true, dirName: "0.1.1-rc.2" };
		},
		installFromArchive: async (filePath) => {
			calls.installFromArchive.push(filePath);
			return manager.installFromArchive
				? manager.installFromArchive()
				: { ok: true, dirName: "0.1.1-rc.2", manifest: { runtimeVersion: "0.1.1-rc.2" } };
		},
		uninstall: (dirName) => {
			calls.uninstall.push(dirName);
		},
		resolveActive: () => manager.resolveActive ?? undefined,
	};
	const installer = new DshRuntimeInstaller({
		manager: fakeManager,
		indexUrl: () => url,
		appVersion: () => APP_VERSION,
		fetchIndex: async () => index,
		onProgress: (p) => progress.push(p),
	});
	return { installer, progress, calls };
}

test("installFromIndex：按兼容区间挑版本并触发下载", async () => {
	const { installer, calls, progress } = makeInstaller();
	const result = await installer.installFromIndex();
	assert.equal(result.ok, true);
	assert.equal(calls.installFromUrl.length, 1);
	assert.equal(calls.installFromUrl[0].archiveUrl, "https://example.test/r.tgz");
	assert.equal(calls.installFromUrl[0].sha256, "abc");
	// 结束时必须是 done=100，UI 据此收起进度条
	assert.equal(progress.at(-1).phase, "done");
	assert.equal(progress.at(-1).percent, 100);
});

test("installFromIndex：下载字节进度映射到 0-70%，阶段进度随后推进", async () => {
	const { installer, progress } = makeInstaller();
	await installer.installFromIndex();
	const downloading = progress.filter((p) => p.phase === "downloading");
	// 一半字节 → 约 35%，且不超过 70（给校验/解压留进度空间）
	assert.ok(downloading.some((p) => p.percent === 35), JSON.stringify(downloading));
	assert.ok(downloading.every((p) => p.percent <= 70));
	assert.ok(progress.some((p) => p.phase === "extracting" && p.percent === 85));
});

test("installFromIndex：索引里没有兼容版本时不下载，避免下完才发现装不上", async () => {
	const { installer, calls, progress } = makeInstaller({
		index: { schemaVersion: 1, releases: [release({ minAppVersion: "9.0.0" })] },
	});
	const result = await installer.installFromIndex();
	assert.equal(result.ok, false);
	assert.equal(result.error, "no compatible runtime release");
	assert.equal(calls.installFromUrl.length, 0, "不该白耗几十 MB 流量");
	assert.equal(progress.at(-1).phase, "error");
});

test("installFromIndex：索引拉不到 / 未配置地址时失败且不下载", async () => {
	const noIndex = makeInstaller({ index: null });
	assert.equal((await noIndex.installer.installFromIndex()).error, "runtime index unavailable");
	assert.equal(noIndex.calls.installFromUrl.length, 0);

	const noUrl = makeInstaller({ url: "" });
	assert.equal((await noUrl.installer.installFromIndex()).error, "no runtime index url configured");
	assert.equal(noUrl.calls.installFromUrl.length, 0);
});

test("installFromIndex：落位失败时把原因带进进度事件（UI 能显示真实原因）", async () => {
	const { installer, progress } = makeInstaller({
		manager: { installFromUrl: () => ({ ok: false, error: "sha256 mismatch" }) },
	});
	const result = await installer.installFromIndex();
	assert.equal(result.ok, false);
	assert.equal(result.error, "sha256 mismatch");
	const last = progress.at(-1);
	assert.equal(last.phase, "error");
	assert.equal(last.error, "sha256 mismatch");
});

test("installFromLocalFile：走归档链路，不查索引也不联网", async () => {
	const { installer, calls, progress } = makeInstaller();
	const result = await installer.installFromLocalFile("C:/tmp/runtime.tgz");
	assert.equal(result.ok, true);
	assert.equal(calls.installFromArchive.length, 1);
	assert.equal(calls.installFromArchive[0], "C:/tmp/runtime.tgz");
	assert.equal(calls.installFromUrl.length, 0);
	assert.equal(progress.at(-1).phase, "done");
});

test("installFromLocalFile：本地导入失败时同样给出 error 进度", async () => {
	const { installer, progress } = makeInstaller({
		manager: { installFromArchive: () => ({ ok: false, error: "manifest missing" }) },
	});
	const result = await installer.installFromLocalFile("C:/tmp/bad.tgz");
	assert.equal(result.ok, false);
	assert.equal(progress.at(-1).error, "manifest missing");
});

test("uninstall：卸载当前启用版本；没装时返回明确错误", () => {
	const { installer, calls } = makeInstaller({
		manager: { resolveActive: { dirName: "0.1.1-rc.2", nodeModules: "x" } },
	});
	assert.equal(installer.uninstall().ok, true);
	assert.deepEqual(calls.uninstall, ["0.1.1-rc.2"]);

	const empty = makeInstaller();
	assert.equal(empty.installer.uninstall().error, "no runtime installed");
	assert.equal(empty.calls.uninstall.length, 0);
});
