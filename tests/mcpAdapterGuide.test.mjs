/**
 * MCP 配置页「未安装 pi-mcp-adapter 扩展」引导的接线测试。
 * 背景：mcp.json 只有被 pi 进程内 adapter 扩展加载才有意义；用户要求参考用量查询页
 * 的 NotInstalledCard 模式，在扩展缺失时引导安装（一键安装 / 终端命令 + 复制）。
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
	// 未安装时不阻塞编辑的降级路径：探测异常置 null
	assert.match(source, /setAdapterInstalled\(null\)/);
});

test("引导卡一键安装指向 npm:pi-mcp-adapter，装完自动重新探测", () => {
	const source = read("src/renderer/src/config/McpTab.tsx");
	assert.match(source, /const ADAPTER_INSTALL_SOURCE = "npm:pi-mcp-adapter";/);
	assert.match(source, /extensions\.install\(ADAPTER_INSTALL_SOURCE\)/);
	assert.match(source, /installCmd = `pi install \$\{ADAPTER_INSTALL_SOURCE\}`/);
	// 安装成功后回调 load（重新探测并切回编辑器）
	assert.match(source, /props\.onInstalled\(\);/);
});

test("未安装时整页切为引导卡，隐藏新增按钮", () => {
	const source = read("src/renderer/src/config/McpTab.tsx");
	// 引导卡替换编辑区
	assert.match(source, /adapterInstalled === false \? \(\s*<McpAdapterGuide onInstalled=\{load\} \/>/);
	// 未安装时隐藏「添加服务」按钮
	assert.match(source, /adapterInstalled !== false \? \(\s*<Button size="sm" onClick=\{startCreate\}/);
});

test("i18n 双语文案齐全（desc/install/installing/failed/cmd/copied/restartHint）", () => {
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
	]) {
		assert.ok(zh.includes(`"${key}"`), `zh-CN missing ${key}`);
		assert.ok(en.includes(`"${key}"`), `en-US missing ${key}`);
	}
	// 安装命令写死准确，防止拼错扩展名
	assert.match(zh, /npm:pi-mcp-adapter/);
	assert.match(en, /npm:pi-mcp-adapter/);
});