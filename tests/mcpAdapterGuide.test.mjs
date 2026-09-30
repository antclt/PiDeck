/**
 * MCP 配置页与 pi-mcp-adapter 的关系测试。
 * 背景变化：pi 0.99 起 MCP 是内置能力（读同一份 mcp.json），adapter 从「硬前置」
 * 降级为「可选组件」。因此引导卡不再整页接管配置页，只作为折叠里的可选安装入口；
 * 但「探测扩展 → 一键安装 → 装完重新探测」这条链路保持不变。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

test("McpTab 用扩展列表探测 pi-mcp-adapter（id 或 source 匹配）", () => {
	const source = read("src/renderer/src/config/McpTab.tsx");
	assert.match(source, /const ADAPTER_EXTENSION_ID = "pi-mcp-adapter";/);
	assert.match(source, /source\.includes\(ADAPTER_EXTENSION_ID\)/);
	assert.match(source, /id === ADAPTER_EXTENSION_ID/);
	// 探测异常返回 null，调用方保持可浏览的降级路径。
	assert.match(source, /catch \{[\s\S]*return null;/);
});

test("可选 adapter 一键安装指向 npm:pi-mcp-adapter，装完自动重新探测", () => {
	const source = read("src/renderer/src/config/McpResourceViews.tsx");
	assert.match(source, /const ADAPTER_INSTALL_SOURCE = "npm:pi-mcp-adapter";/);
	assert.match(source, /extensions\.install\(ADAPTER_INSTALL_SOURCE\)/);
	assert.match(source, /installCmd = `pi install \$\{ADAPTER_INSTALL_SOURCE\}`/);
	// 安装成功后回调 load（重新探测并切回编辑器）
	assert.match(source, /props\.onInstalled\(\);/);
});

test("adapter 缺失不再整页接管：内置提示 + 折叠安装入口，配置区始终可用", () => {
	const source = read("src/renderer/src/config/McpTab.tsx");
	// pi 0.99 内置 MCP：不再因缺 adapter 隐藏新建按钮或隐藏编辑器
	assert.doesNotMatch(source, /adapterInstalled !== false \? \(/);
	assert.doesNotMatch(source, /showAdapterGuide \? null : \(/);
	assert.doesNotMatch(source, /showAdapterGuide \? \(\s*<McpAdapterGuide onInstalled=\{load\} \/>\s*\) : \(/);
	// 提示条带 built-in 说明，安装入口收进 <details>
	assert.match(source, /t\("config\.mcp\.builtInNotice"\)/);
	assert.match(source, /t\("config\.mcp\.optionalAdapter"\)/);
	assert.match(source, /<details className="mt-1">/);
	assert.match(source, /<McpAdapterGuide onInstalled=\{load\} \/>/);
});

test("i18n 双语文案齐全（notInstalled 系列 + 内置提示）", () => {
	const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const en = read("src/renderer/src/i18n/rendererCopy.en-US.ts");
	for (const key of [
		"config.mcp.notInstalled.desc",
		"config.mcp.notInstalled.install",
		"config.mcp.notInstalled.installing",
		"config.mcp.notInstalled.installFailed",
		"config.mcp.notInstalled.copyCmd",
		"config.mcp.notInstalled.copied",
		"config.mcp.notInstalled.restartHint",
		"config.mcp.builtInNotice",
		"config.mcp.optionalAdapter",
	]) {
		assert.ok(zh.includes(`"${key}"`), `zh-CN missing ${key}`);
		assert.ok(en.includes(`"${key}"`), `en-US missing ${key}`);
	}
	// 安装命令写死准确，防止拼错扩展名
	assert.match(zh, /npm:pi-mcp-adapter/);
	assert.match(en, /npm:pi-mcp-adapter/);
});
