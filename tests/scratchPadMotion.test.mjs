import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const styles = readRendererStyles();
const panel = readFileSync("src/renderer/src/components/scratchPad/ScratchPadPanel.tsx", "utf8");
const picker = readFileSync("src/renderer/src/components/scratchPad/ScratchPadDraftPicker.tsx", "utf8");
const drawerHost = readFileSync("src/renderer/src/components/workspace/WorkspaceDrawerHost.tsx", "utf8");

test("scratch pad uses shared drawer motion without a floating compositor layer", () => {
	assert.doesNotMatch(styles, /\.scratch-pad-(?:overlay|panel)\b/);
	assert.doesNotMatch(styles, /@keyframes\s+scratch-pad-(?:enter|exit)/);
	assert.doesNotMatch(panel, /scratch-pad-overlay|scratch-pad-panel\.closing/);
	assert.match(drawerHost, /getVisibleDrawerPanel\(open,\s*props\.panel,\s*renderedDrawer\)/);
	assert.match(drawerHost, /setRenderedDrawer\(null\)/);
	assert.match(drawerHost, /DRAWER_ANIMATION_MS/);
});

test("scratch pad leaves narrow drawer width to its editor and uses shared accessible controls", () => {
	assert.doesNotMatch(panel, /<aside\b|w-40\b/);
	// 草稿选择已从 Select 换成可搜索 combobox（草稿多时需要搜索），可访问名必须保留。
	assert.match(panel, /<ScratchPadDraftPicker\s/);
	assert.match(picker, /role="combobox"/);
	assert.match(picker, /aria-label=\{t\("scratchPad\.showFileList"\)\}/);
	assert.match(panel, /<TabsTrigger\s+value="edit"/);
	assert.match(panel, /<TabsContent\s+value="preview"/);
	assert.match(panel, /className="flex\s+h-full\s+min-h-0\s+w-full\s+min-w-0\s+flex-1/);
	assert.match(panel, /\[field-sizing:fixed\]/);
});
