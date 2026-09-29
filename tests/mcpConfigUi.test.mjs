import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("ConfigModal wires an MCP tab without bloating loadConfig into MCP CRUD", () => {
	const modal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	assert.match(modal, /id: "mcp"/);
	assert.match(modal, /CONFIG_TABS: readonly ConfigTab\[] = \["models", "auth", "settings", "trust", "mcp", "raw"\]/);
	// MCP 页固定全局作用域：父层只传导入扫描的项目来源 + 脏回调，不再下发项目列表/作用域
	assert.match(modal, /<McpTab[\s\S]{0,160}?activeProjectId=\{projectId\}[\s\S]{0,160}?onDirtyChange=\{handleMcpDirtyChange\}/);
	assert.match(modal, /case "config:mcp":/);
	assert.match(modal, /api\.config\.getMcp/);
	assert.match(modal, /rawFileName === "mcp\.json"/);
});

test("dirty-mark helpers include config:mcp", () => {
	const { dirtyKeysClearedByReload, ALL_CONFIG_DIRTY_KEYS } = loadTsCommonJs("src/renderer/src/config/configDirtyMarks.ts");
	assert.deepEqual(new Set(dirtyKeysClearedByReload("mcp")), new Set(["config:mcp", "config:raw"]));
	assert.ok(Array.from(ALL_CONFIG_DIRTY_KEYS).includes("config:mcp"));
});

test("IPC, preload, and ConfigManager expose get/save/probe MCP channels", () => {
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	const manager = readFileSync("src/main/config/ConfigManager.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	assert.match(ipc, /configGetMcp: "config:get-mcp"/);
	assert.match(ipc, /configSaveMcp: "config:save-mcp"/);
	assert.match(ipc, /configProbeMcp: "config:probe-mcp"/);
	assert.match(preload, /getMcp:/);
	assert.match(preload, /saveMcp:/);
	assert.match(preload, /probeMcp:/);
	assert.match(manager, /getMcpConfig/);
	assert.match(manager, /saveMcpConfig/);
	assert.match(systemIpc, /ipcChannels\.configGetMcp/);
	assert.match(systemIpc, /function isMcpConfigFile\(value: unknown\): value is McpConfigFile/);
	assert.match(systemIpc, /function isMcpServerDefinition\(value: unknown\): value is McpServerDefinition/);
	assert.match(systemIpc, /projectId\.length > 256/);
	assert.doesNotMatch(systemIpc, /data as McpConfigFile|definition as McpServerDefinition/);
	assert.match(manager, /"mcp\.json"/);
	assert.match(manager, /readJsonFile<McpConfigFile>\("mcp\.json"/);
	assert.match(manager, /files\["mcp\.json"\]/);
});

test("McpTab stays proxy-config only and is global-scope only", () => {
	const tab = readFileSync("src/renderer/src/config/McpTab.tsx", "utf8");
	const resourceViews = readFileSync("src/renderer/src/config/McpResourceViews.tsx", "utf8");
	const main = readFileSync("src/main/config/mcpConfig.ts", "utf8");
	assert.match(tab, /probeMcp/);
	assert.match(tab, /item\?\.ownedByWritable/);
	assert.match(tab, /writableBroken/);
	// 固定全局作用域：getMcp 不带 projectId，项目层读写与作用域下拉均已从本页移除
	assert.match(tab, /getMcp\(\)/);
	assert.doesNotMatch(tab, /effectiveScope|ResourceScopeSelector|projects=\{projects\}/);
	assert.match(tab, /generation !== loadGenerationRef\.current/);
	assert.doesNotMatch(tab, /<fieldset/);
	// 列表不再分项目/全局两组，也没有项目层路径参数
	assert.match(resourceViews, /McpServerListPane/);
	assert.doesNotMatch(resourceViews, /config\.resourceGroup\.|projectLayerPaths/);
	assert.doesNotMatch(tab, /Client|StdioClientTransport|@modelcontextprotocol/);
	assert.doesNotMatch(main, /spawn\(|fork\(/);
	assert.match(main, /Command not found/);
});
