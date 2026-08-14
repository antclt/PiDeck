// 临时验证：apiProxy 的 RPC 响应 content-type（决定 hostEntry 的 isStream 判断）
// 用法：node scripts/tmp-verify-ct.mjs
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { boot, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { InProcessApiClient, toFetchHandler } from "@deepseek-ai/dsh-host-apiproxy";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");

process.env.DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
process.env.DSH_TELEMETRY_DISABLED = "1";

const basePatchPath = require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml");
const patches = loadOverlayPatches("pideck-dsh", basePatchPath);
patches.push({ id: "hmr", disabled: true });
patches.push({ id: "session-telemetry-otel", disabled: true });
patches.push({
	insert: [
		{ id: "storage", name: "@deepseek-ai/dsh-storage" },
		{ id: "storage-json", name: "@deepseek-ai/dsh-storage-json", config: { root: { __jsExpr: "dshHomePath('storages')" } } },
		{ id: "storage-domain", name: "@deepseek-ai/dsh-storage-domain", config: { backend: "json" } },
		{ id: "workspace", name: "@deepseek-ai/dsh-workspace" },
		{ id: "api-gateway", name: "@deepseek-ai/dsh-host-apiproxy" },
		{ id: "pideck-directory-picker", name: "./pideck-directory-picker.js" },
	],
});
const configDir = mkdtempSync(join(tmpdir(), "pideck-dsh-ct-"));
writeFileSync(join(configDir, "cordis.yml"), "[]\n");
writeFileSync(
	join(configDir, "pideck-directory-picker.js"),
	[
		"export default {",
		"  apply(ctx) {",
		"    ctx.provide('directoryPicker', {",
		"      capability() { return { kind: 'none' }; },",
		"    });",
		"  },",
		"};",
		"",
	].join("\n"),
);

const ctx = await boot(
	"pideck-dsh",
	join(configDir, "cordis.yml"),
	patches,
	(h) => { provideCmdline(h, { args: [], exit: () => {} }); },
	pathToFileURL(join(projectRoot, "node_modules") + "/").href,
);
console.log("boot OK");

const handler = toFetchHandler(ctx.apiProxy);
const client = new InProcessApiClient(handler);

// 用 client 触发一次 describe，同时拦截 handler 的 fetch 观察响应头
// InProcessApiClient 内部走 fetch，无法直接看 headers；改用代理 fetch：
const wrappedHandler = {
	fetch: async (url, init) => {
		const response = await handler.fetch(url, init);
		console.log("RPC URL:", String(url));
		console.log("RPC content-type:", response.headers.get("content-type"));
		console.log("RPC status:", response.status);
		return response;
	},
};
const probeClient = new InProcessApiClient(wrappedHandler);
const described = await probeClient.settings.describe({});
console.log("describe ok:", described.result.ok);

await ctx.fiber.dispose();
rmSync(configDir, { recursive: true, force: true });
console.log("DONE");
