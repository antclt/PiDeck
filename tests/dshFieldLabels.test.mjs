import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { dshFieldCopy, isDshCustomSettingsHiddenField } = loadTsCommonJs(
	"src/renderer/src/config/dshFieldLabels.ts",
	{
		stubs: {
			"../i18n": {
				t: (key) => key,
			},
		},
	},
);

test("known DSH fields get human labels instead of raw keys or (root)", () => {
	assert.equal(dshFieldCopy("baseURL").label, "config.dsh.field.baseURL");
	assert.equal(dshFieldCopy("baseURL").hint, "config.dsh.field.baseURLHint");
	assert.equal(dshFieldCopy("baseURL").placeholder, "config.dsh.field.baseURLPlaceholder");
	assert.equal(dshFieldCopy("api").label, "config.dsh.field.api");
	assert.equal(dshFieldCopy("apiKeyEnv").label, "config.dsh.field.apiKeyEnv");
	assert.equal(dshFieldCopy("displayName").label, "config.dsh.field.displayName");
});

test("empty field name does not fall back to (root)", () => {
	assert.equal(dshFieldCopy("").label, "");
	assert.equal(dshFieldCopy("timeout").label, "timeout");
});

test("custom settings hide secret and credential-ref slots so users do not paste keys there", () => {
	assert.equal(isDshCustomSettingsHiddenField("apiKeyEnv"), true);
	assert.equal(isDshCustomSettingsHiddenField("models"), true);
	assert.equal(isDshCustomSettingsHiddenField("token", { role: "secret" }), true);
	assert.equal(isDshCustomSettingsHiddenField("baseURL"), false);
	assert.equal(isDshCustomSettingsHiddenField("api"), false);
});

test("schema form and provider cards use field names plus human labels", () => {
	const form = readFileSync("src/renderer/src/config/DshSchemaForm.tsx", "utf8");
	const cards = readFileSync("src/renderer/src/config/DshProviderCards.tsx", "utf8");
	assert.match(form, /dshFieldCopy/);
	assert.doesNotMatch(form, /"\(root\)"/);
	assert.match(cards, /path=\{\[field\.name\]\}/);
	assert.match(cards, /isDshCustomSettingsHiddenField/);
	assert.doesNotMatch(cards, /path=\{\[\]\}/);
});
