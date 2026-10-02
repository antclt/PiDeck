import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 会话 Tab 栏字号可配置契约：shared 类型 → SettingsStore 默认+归一化 →
// App data-tab-font-size → foundation.css token 四档 → Tailwind text-tab →
// SessionTabsBar 应用 → AppearanceTab 行 → i18n 文案。
const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");
const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const tailwind = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
const tabsBar = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
const appearance = readFileSync("src/renderer/src/components/app/settings/AppearanceTab.tsx", "utf8");
const modal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const unsaved = readFileSync("src/renderer/src/components/app/settings/unsavedChangesSummary.ts", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

const MODES = ["compact", "medium", "large", "xlarge"];

/** 从 foundation.css 取某个 data 属性各档位块里某 token 的值（正则空白容忍，不锁缩进）。 */
function tokenByMode(css, attribute, token) {
	const blocks = new RegExp(`:root\\[${attribute}\\s*=\\s*"([\\w-]+)"\\]\\s*\\{([\\s\\S]*?)\\}`, "g");
	const found = new Map();
	for (const match of css.matchAll(blocks)) {
		const value = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(match[2])?.[1]?.trim();
		if (value) found.set(match[1], value);
	}
	return found;
}

test("settings 类型声明 tabBarFontSize（可空覆盖，与其他区域轨同构）", () => {
	assert.match(settingsType, /tabBarFontSize:\s*AppFontSizeMode\s*\|\s*null/);
});

test("SettingsStore：默认 null + load 归一化（null 必须保持 null）", () => {
	assert.match(store, /tabBarFontSize:\s*null/);
	assert.match(store, /this\.settings\.tabBarFontSize\s*=\s*normalizeOptionalFontSizeMode\(this\.settings\.tabBarFontSize\)/);
});

test("App 装配层写 data-tab-font-size，未单独设置时回落界面字号", () => {
	assert.match(app, /root\.dataset\.tabFontSize\s*=\s*settings\.tabBarFontSize\s*\?\?\s*uiFontSize/);
	// 依赖数组必须登记，否则改了设置不重算（视觉要到下次渲染才生效）
	assert.match(app, /\[[^\]]*settings\.tabBarFontSize[^\]]*\]/);
	// 首拉 settings 前的兜底默认值已抽到 shared/types/settings.ts 的 createDefaultAppSettings
	assert.match(settingsType, /tabBarFontSize:\s*null/);
});

test("foundation.css：四档齐备，且逐档与界面轨 micro 同值（保证默认视觉不变）", () => {
	const tab = tokenByMode(foundation, "data-tab-font-size", "--font-size-tab");
	const micro = tokenByMode(foundation, "data-ui-font-size", "--font-size-micro");
	for (const mode of MODES) {
		assert.ok(tab.get(mode), `缺少 :root[data-tab-font-size="${mode}"] 的 --font-size-tab`);
		assert.equal(tab.get(mode), micro.get(mode), `${mode} 档 Tab 字号应与界面 micro 同值`);
	}
	// 基线值（无 data 属性时）也必须与 micro 基线一致
	const baselineTab = /--font-size-tab:\s*([^;]+);/.exec(foundation)?.[1]?.trim();
	const baselineMicro = /--font-size-micro:\s*([^;]+);/.exec(foundation)?.[1]?.trim();
	assert.equal(baselineTab, baselineMicro);
});

test("Tailwind 暴露 text-tab 工具类并接上 token", () => {
	assert.match(tailwind, /--text-tab:\s*var\(--font-size-tab\)/);
	assert.match(tailwind, /--text-tab--line-height:\s*var\(--line-height-tab\)/);
});

test("SessionTabsBar：会话 Tab 与文件 Tab 都用 text-tab，不再沿用 text-micro", () => {
	const pills = tabsBar.match(/"session-tab group[^"]*"/g) ?? [];
	assert.equal(pills.length, 2, "应有会话 Tab 与工作台文件 Tab 两处胶囊");
	for (const pill of pills) {
		assert.match(pill, /text-tab/);
		assert.doesNotMatch(pill, /text-micro/);
	}
});

test("AppearanceTab：自定义各区域字号里有 Tab 栏行，关闭开关时一并置 null", () => {
	assert.match(appearance, /t\("settings\.tabBarFontSize"\)/);
	assert.match(appearance, /draft\.tabBarFontSize\s*\?\?\s*draft\.uiFontSize\s*\?\?\s*draft\.fontSize/);
	assert.match(appearance, /updateDraft\(\{\s*tabBarFontSize:\s*value as AppSettings\["tabBarFontSize"\]/);
	assert.match(appearance, /updateDraft\(\{[^}]*tabBarFontSize:\s*null[^}]*\}\)/);
});

test("SettingsModal：展开态判定把 tabBarFontSize 计入（任一覆盖非 null 即展开）", () => {
	const derivations = modal.match(/[Pp]erAreaFontSize[^\n]*tabBarFontSize/g) ?? [];
	assert.ok(derivations.length >= 2, "useState 初始值与 cancelAll 还原处都要计入 tabBarFontSize");
});

test("未保存变更摘要登记 tabBarFontSize", () => {
	assert.match(unsaved, /\{\s*field:\s*"tabBarFontSize",\s*tab:\s*"appearance",\s*itemKey:\s*"settings\.tabBarFontSize"\s*\}/);
});

test("i18n 中英文案同步提供", () => {
	assert.match(zh, /"settings\.tabBarFontSize":\s*"会话 Tab 栏字号"/);
	assert.match(en, /"settings\.tabBarFontSize":\s*"Session Tab Font Size"/);
	// 开关说明要把 Tab 栏列进区域清单，否则用户不知道这一行从哪来
	assert.match(zh, /"settings\.fontSizePerAreaDesc":\s*"为侧边栏、会话 Tab 栏、会话正文和输入框分别设置字号"/);
	assert.match(en, /Set font sizes for sidebar, session tabs, chat content, and input box separately/);
});
