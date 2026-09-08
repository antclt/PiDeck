import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readSrc(relativePath) {
	return readFileSync(join(root, relativePath), "utf8");
}

test("providerUsageAutoQueryEnabled defaults to false in settings type, store, App and preview", () => {
	const settingsType = readSrc("src/shared/types/settings.ts");
	assert.match(settingsType, /providerUsageAutoQueryEnabled:\s*boolean;/);

	const store = readSrc("src/main/settings/SettingsStore.ts");
	assert.match(store, /providerUsageAutoQueryEnabled:\s*false,/);

	const app = readSrc("src/renderer/src/App.tsx");
	assert.match(app, /providerUsageAutoQueryEnabled:\s*false,/);
	assert.match(app, /providerUsageAutoQueryEnabledAtom/);

	const preview = readSrc("src/renderer/src/previewApi.ts");
	assert.match(preview, /providerUsageAutoQueryEnabled:\s*false,/);
});

test("providerUsageAutoQueryEnabled is not injected into the pi child env", () => {
	const piProcess = readSrc("src/main/pi/PiProcess.ts");
	assert.doesNotMatch(piProcess, /providerUsageAutoQueryEnabled/);
});

test("CommonTab and FIELD_CATALOG wire the usage auto-query switch", () => {
	const commonTab = readSrc("src/renderer/src/components/app/settings/CommonTab.tsx");
	assert.match(commonTab, /draft\.providerUsageAutoQueryEnabled\s*\?\?\s*false/);
	assert.match(commonTab, /isDirty\("providerUsageAutoQueryEnabled"\)/);
	assert.match(commonTab, /updateDraft\(\{\s*providerUsageAutoQueryEnabled:\s*checked\s*\}\)/);
	assert.match(commonTab, /"settings\.providerUsageAutoQuery"/);
	assert.match(commonTab, /"settings\.providerUsageAutoQueryDesc"/);

	const catalog = readSrc("src/renderer/src/components/app/settings/unsavedChangesSummary.ts");
	assert.match(
		catalog,
		/field:\s*"providerUsageAutoQueryEnabled"[\s\S]*?itemKey:\s*"settings\.providerUsageAutoQuery"/,
	);
});

test("usage auto-query copy exists in both locales", () => {
	const zh = readSrc("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const en = readSrc("src/renderer/src/i18n/rendererCopy.en-US.ts");
	assert.match(zh, /"settings\.providerUsageAutoQuery":\s*"自动查询供应商用量"/);
	assert.match(zh, /"settings\.providerUsageAutoQueryDesc":/);
	assert.match(en, /"settings\.providerUsageAutoQuery":\s*"Automatically query provider usage"/);
	assert.match(en, /"settings\.providerUsageAutoQueryDesc":/);
});

test("hook gates mount/poll/batch through the shared strategy and keeps manual refresh ungated", () => {
	const hook = readSrc("src/renderer/src/hooks/useProviderUsage.ts");
	assert.match(hook, /from\s+"\.\/providerUsageAutoQuery"/);
	assert.match(hook, /reason:\s*"mount"/);
	assert.match(hook, /reason:\s*"poll"/);
	assert.match(hook, /reason:\s*"batch"/);
	assert.doesNotMatch(hook, /reason:\s*"manual"/);
	assert.match(hook, /providerUsageAutoQueryEnabledAtom/);
	assert.match(hook, /fetchUsage\(provider,\s*backend\)/);
});
