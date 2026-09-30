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

test("MCP 表单切到 pi 0.99 内置 MCP schema：exposure/timeout/enabled 替代 adapter lifecycle", () => {
	const tab = readFileSync("src/renderer/src/config/McpTab.tsx", "utf8");
	const resourceViews = readFileSync("src/renderer/src/config/McpResourceViews.tsx", "utf8");
	const shared = readFileSync("src/shared/types/mcp.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	// pi 0.99 不再识别 lifecycle/directTools：表单停止写入这些死字段
	assert.doesNotMatch(tab, /LIFECYCLE_OPTIONS/);
	assert.doesNotMatch(tab, /config\.mcp\.field\.lifecycle/);
	// 停用语义切到 enabled（保留 disabled 成对写以兼容旧版 pi + adapter）
	assert.match(tab, /patchEditing\(\{ enabled: checked, disabled: !checked \}\)/);
	assert.match(tab, /upsert\(item\.name, \{ \.\.\.existing, enabled: !disabled, disabled: disabled \? true : false \}\)/);
	assert.match(resourceViews, /definition\.enabled === false \|\| definition\.disabled === true/);
	// exposure / timeout 编辑入口
	assert.match(tab, /EXPOSURE_OPTIONS/);
	assert.match(tab, /patchEditing\(\{ exposure: value as McpExposure \}\)/);
	assert.match(tab, /patchEditing\(\{ timeout: parsed \}\)/);
	assert.match(tab, /placeholder="60"/);
	// 共享类型与主进程校验容纳 0.99 schema
	assert.match(shared, /export type McpExposure =/);
	assert.match(shared, /exposure\?: McpExposure;/);
	assert.match(shared, /toolExposure\?: Record<string, McpExposure>;/);
	assert.match(systemIpc, /MCP_EXPOSURE_VALUES/);
	assert.match(systemIpc, /optionalExposure\("exposure"\)/);
	assert.match(systemIpc, /Number\.isFinite\(value\.timeout\) && value\.timeout > 0/);
});

test("pi 0.99 起 MCP 内置：adapter 引导降级为可选提示，配置页不再被整页接管", () => {
	const tab = readFileSync("src/renderer/src/config/McpTab.tsx", "utf8");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	// 不再存在「缺 adapter 就隐藏新建按钮 / 隐藏整个编辑器」的分支
	assert.doesNotMatch(tab, /adapterInstalled !== false \? \(/);
	assert.doesNotMatch(tab, /showAdapterGuide \? null : \(/);
	// 内置提示 + 折叠的可选安装入口
	assert.match(tab, /t\("config\.mcp\.builtInNotice"\)/);
	assert.match(tab, /t\("config\.mcp\.optionalAdapter"\)/);
	assert.match(tab, /<details className="mt-1">/);
	// 文档指向 pi 官方 MCP 文档而非 adapter mintlify
	assert.match(tab, /const MCP_DOCS = "https:\/\/earendil-works\.github\.io\/pi\/docs\/mcp"/);
	for (const key of ["config.mcp.builtInNotice", "config.mcp.optionalAdapter"]) {
		assert.ok(zh.includes(`"${key}"`), `zh-CN missing ${key}`);
		assert.ok(en.includes(`"${key}"`), `en-US missing ${key}`);
	}
});
