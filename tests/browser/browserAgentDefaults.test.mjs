import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const { createDefaultAppSettings } = loadTsCommonJs("src/shared/types/settings.ts");

/** 隔离 userData/home，避免默认值测试读写真实设置或 pi 配置。 */
function makeStore(t) {
	const root = mkdtempSync(join(tmpdir(), "pideck-browser-default-"));
	const userData = join(root, "userData");
	const home = join(root, "home");
	mkdirSync(userData);
	mkdirSync(home);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
		stubs: {
			electron: {
				app: { getPath: (key) => (key === "userData" ? userData : home) },
				BrowserWindow: class {},
				Menu: { setApplicationMenu: () => undefined },
			},
			"../logging/sharedLogger": { getAppLogger: () => undefined },
			"../git/gitExecutable": { setConfiguredGitPath: () => undefined },
		},
	});
	return { SettingsStore, filePath: join(userData, "settings.json") };
}

function seed(filePath, patch) {
	writeFileSync(filePath, JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, ...patch }));
}

test("shared defaults keep the browser agent off and approvals manual", () => {
	const settings = createDefaultAppSettings();
	assert.equal(settings.browserAgentEnabled, false);
	assert.equal(settings.browserAgentAutoApprove, false);
});

test("a fresh SettingsStore agrees with the shared defaults", async (t) => {
	const { SettingsStore } = makeStore(t);
	const store = new SettingsStore();
	assert.equal(store.get().browserAgentEnabled, false);
	assert.equal(store.get().browserAgentAutoApprove, false);
	await store.load();
	assert.equal(store.get().browserAgentEnabled, false);
	assert.equal(store.get().browserAgentAutoApprove, false);
});

test("an explicit opt-in survives saving and reloading", async (t) => {
	const { SettingsStore, filePath } = makeStore(t);
	seed(filePath, { browserAgentEnabled: true, browserAgentAutoApprove: true });
	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().browserAgentEnabled, true);
	await store.update({ browserAgentEnabled: false });
	assert.equal(JSON.parse(readFileSync(filePath, "utf8")).browserAgentEnabled, false);
	const reloaded = new SettingsStore();
	await reloaded.load();
	assert.equal(reloaded.get().browserAgentEnabled, false);
});

test("non-boolean IPC values never enable the browser agent or auto-approval", async (t) => {
	const { SettingsStore } = makeStore(t);
	const store = new SettingsStore();
	await store.update({ browserAgentEnabled: "yes", browserAgentAutoApprove: 1 });
	assert.equal(store.get().browserAgentEnabled, false);
	assert.equal(store.get().browserAgentAutoApprove, false);
});

test("preview, settings UI, anchors and i18n agree on the browser agent keys", () => {
	const preview = readFileSync("src/renderer/src/previewApi.ts", "utf8");
	assert.match(preview, /browserAgentEnabled\s*:\s*false\b/);
	assert.match(preview, /browserAgentAutoApprove\s*:\s*false\b/);

	const commonTab = readFileSync("src/renderer/src/components/app/settings/CommonTab.tsx", "utf8");
	assert.match(commonTab, /draft\.browserAgentEnabled\s*\?\?\s*false/);
	assert.match(commonTab, /draft\.browserAgentAutoApprove\s*\?\?\s*false/);
	assert.match(commonTab, /settings-section-common-browser-agent/);

	const fieldAnchors = readFileSync("src/renderer/src/utils/settingsFieldAnchors.ts", "utf8");
	assert.match(fieldAnchors, /common-browser-agent-enabled/);
	assert.match(fieldAnchors, /common-browser-agent-auto-approve/);
	const sectionAnchors = readFileSync("src/renderer/src/utils/settingsSectionAnchors.ts", "utf8");
	assert.match(sectionAnchors, /common-browser-agent/);

	const zhCopy = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	for (const key of ["settings.browserAgentSection", "settings.browserAgentEnabled", "settings.browserAgentAutoApprove", "cua.action.browser_click", "cua.action.browser_navigate"]) {
		assert.ok(zhCopy.includes(`"${key}"`), `missing i18n key: ${key}`);
	}
	const zhTw = readFileSync("src/renderer/src/i18n/rendererCopy.zh-TW.ts", "utf8");
	assert.ok(zhTw.includes('"settings.browserAgentEnabled"'), "zh-TW was not regenerated");
});
