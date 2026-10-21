import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("system selection shortcut registration failures are visible and retried", () => {
	const main = read("src/main/index.ts");
	const service = read("src/main/selection/SelectionToolService.ts");
	const shared = read("src/shared/types/selectionTool.ts");
	const settings = read("src/renderer/src/components/app/settings/SelectionToolSettingsSection.tsx");
	const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const en = read("src/renderer/src/i18n/rendererCopy.en-US.ts");

	// 失败不再只写日志：登记冲突 -> emitAgentsNotice（同一 accelerator 去重），窗口 focus 重试补发。
	assert.match(main, /notifySelectionShortcutConflict\(\s*accelerator\s*\)/);
	assert.match(main, /i18nKey:\s*"selectionTool\.shortcutConflict"/);
	assert.match(main, /browser-window-focus/);
	assert.match(main, /flushSelectionShortcutConflictNotice/);
	assert.match(main, /clearSelectionShortcutConflict\(\s*\)/);

	// 状态查询带注册结果，设置页据此常驻警告（系统级开关打开但快捷键被占用）。
	assert.match(shared, /shortcutRegistered\?:\s*boolean/);
	assert.match(shared, /shortcut\?:\s*string\s*\|\s*null/);
	assert.match(service, /shortcutRegistered:\s*this\.accelerator !== null/);
	assert.match(settings, /shortcutRegistered\s*===\s*false/);
	assert.match(settings, /settings\.selectionTool\.shortcutConflict/);
	assert.match(settings, /desktopApi\.selectionTool\s*\.getState\(\)/);

	// 中英文案必须同时存在；zh-TW 由生成器负责。
	for (const source of [zh, en]) {
		assert.match(source, /"selectionTool\.shortcutConflict":/);
		assert.match(source, /"settings\.selectionTool\.shortcutConflict":/);
	}
});
