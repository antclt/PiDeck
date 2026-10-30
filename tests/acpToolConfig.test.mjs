/**
 * ACP 工具登记表消毒/校验纯函数单测。
 * 覆盖:非法条目丢弃(不阻断整表)、字段归一(去空白/限长/控制字符)、
 * 重复 id/name 去重、args 只收非空字符串、上限截断、validateAcpTool 表单语义。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { sanitizeAcpTools, validateAcpTool, createAcpToolId, sanitizeAcpToolConfigDefaults, isRememberedAcpConfigOption, planAcpConfigReplay, withAcpConfigDefault, isAcpModeOption, findAcpModeOption, findAcpBypassModeValue } = loadTsCommonJs("src/main/acp/acpToolConfig.ts");

const validTool = { id: "t1", name: "Gemini CLI", command: "gemini", args: ["--acp"], enabled: true };

test("sanitizeAcpTools keeps valid entries and fills defaults", () => {
	const tools = sanitizeAcpTools([validTool, { name: "no-id tool", command: "kimi" }]);
	assert.equal(tools.length, 2);
	// VM 沙箱 realm 与主 realm 原型不同，deepStrictEqual 会失配：序列化后比对。
	assert.equal(JSON.stringify(tools[0]), JSON.stringify(validTool));
	// 无 id 条目自动生成 id,enabled 缺省 true
	assert.match(tools[1].id, /^acp-tool-/);
	assert.equal(tools[1].enabled, true);
	assert.equal(JSON.stringify(tools[1].args), "[]");
});

test("sanitizeAcpTools drops non-array / non-object / empty-field entries instead of rejecting the table", () => {
	assert.equal(sanitizeAcpTools(undefined).length, 0);
	assert.equal(sanitizeAcpTools("nope").length, 0);
	const tools = sanitizeAcpTools(["junk", null, { id: "ok", name: "ok", command: "ok" }, { id: "no-name", command: "x" }, { id: "no-command", name: "x" }, { id: "blank", name: "   ", command: "x" }]);
	assert.equal(tools.length, 1);
	assert.equal(tools[0].id, "ok");
});

test("sanitizeAcpTools trims fields and rejects control characters", () => {
	const tools = sanitizeAcpTools([{ id: "t", name: "  Gemini  ", command: " gemini " }]);
	assert.equal(tools[0].name, "Gemini");
	assert.equal(tools[0].command, "gemini");
	const evil = sanitizeAcpTools([{ id: "e", name: "bad\u0007name", command: "x" }]);
	assert.equal(evil.length, 0);
	const evilArgs = sanitizeAcpTools([{ id: "e", name: "n", command: "c", args: ["ok", "", 42, "  "] }]);
	assert.equal(JSON.stringify(evilArgs[0].args), JSON.stringify(["ok"]));
});

test("sanitizeAcpTools dedupes by id and by display name", () => {
	const tools = sanitizeAcpTools([
		{ id: "a", name: "Same", command: "one" },
		{ id: "a", name: "Same-id", command: "two" },
		{ id: "b", name: "Same", command: "three" },
	]);
	assert.equal(tools.length, 1);
	assert.equal(tools[0].command, "one");
});

test("sanitizeAcpTools caps list and args lengths", () => {
	const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, command: "c" }));
	assert.equal(sanitizeAcpTools(many).length, 32);
	const longArgs = Array.from({ length: 50 }, (_, i) => `arg${i}`);
	assert.equal(sanitizeAcpTools([{ id: "t", name: "n", command: "c", args: longArgs }])[0].args.length, 32);
});

test("validateAcpTool requires name and command with duplicate-name check", () => {
	assert.equal(validateAcpTool({ name: "", command: "c" }).ok, false);
	assert.equal(validateAcpTool({ name: "n", command: " " }).ok, false);
	const existing = [validTool];
	assert.equal(validateAcpTool({ name: "Gemini CLI", command: "other" }, existing).reasonKey, "acp.toolDuplicateName");
	// 编辑自身(id 相同)不判重
	const editing = validateAcpTool({ id: "t1", name: "Gemini CLI", command: "other" }, existing);
	assert.equal(editing.ok, true);
	assert.equal(editing.tool.id, "t1");
	// 新建合法条目分配新 id
	const fresh = validateAcpTool({ name: "New", command: "new-cli", args: ["acp"] }, existing);
	assert.equal(fresh.ok, true);
	assert.match(fresh.tool.id, /^acp-tool-/);
});

test("createAcpToolId is unique-ish across calls", () => {
	const ids = new Set(Array.from({ length: 50 }, () => createAcpToolId()));
	assert.equal(ids.size, 50);
});

test("sanitizeAcpTools keeps only well-formed env entries (valid key names, bounded values)", () => {
	const tools = sanitizeAcpTools([
		{
			id: "t",
			name: "n",
			command: "c",
			env: {
				ZAI_CODING_KEY: "sk-abc123",
				"bad-key": "dropped",
				"9START": "dropped",
				EMPTY: "",
				CTRL: "va\u0007lue",
				NOT_STRING: 42,
			},
		},
	]);
	assert.equal(tools.length, 1);
	// 合法键名 + 合法值才保留;空值/控制字符/非字符串/非法键名一律丢弃
	assert.equal(JSON.stringify(tools[0].env), JSON.stringify({ ZAI_CODING_KEY: "sk-abc123" }));
	// 无 env 字段或消毒后为空 → 不产出空对象
	assert.equal(sanitizeAcpTools([{ id: "t2", name: "n2", command: "c", env: { "1bad": "x" } }])[0].env, undefined);
});

test("sanitizeAcpToolConfigDefaults keeps well-formed entries and drops dirty ones", () => {
	const defaults = sanitizeAcpToolConfigDefaults({
		tool1: { effort: "high", mode: "accept_edits", flag: true },
		" tool2 ": { "bad\u0007id": "x", empty: "  ", long: "x".repeat(300) },
		tool3: "nope",
		tool4: { onlyEmpty: "" },
	});
	assert.equal(JSON.stringify(defaults), JSON.stringify({ tool1: { effort: "high", mode: "accept_edits", flag: true } }));
	assert.equal(JSON.stringify(sanitizeAcpToolConfigDefaults(null)), "{}");
	assert.equal(JSON.stringify(sanitizeAcpToolConfigDefaults([])), "{}");
	assert.equal(JSON.stringify(sanitizeAcpToolConfigDefaults("nope")), "{}");
});

test("sanitizeAcpToolConfigDefaults caps tool/option counts", () => {
	const manyTools = {};
	for (let i = 0; i < 40; i += 1) manyTools[`t${i}`] = { effort: "high" };
	assert.equal(Object.keys(sanitizeAcpToolConfigDefaults(manyTools)).length, 32);
	const manyOptions = {};
	for (let i = 0; i < 20; i += 1) manyOptions[`o${i}`] = "v";
	assert.equal(Object.keys(sanitizeAcpToolConfigDefaults({ t: manyOptions }).t).length, 16);
});

test("isRememberedAcpConfigOption excludes model/model_config but keeps thought/mode/custom", () => {
	assert.equal(isRememberedAcpConfigOption({ id: "model", category: "model" }), false);
	// category 缺失时 id 兜底排除 model
	assert.equal(isRememberedAcpConfigOption({ id: "model" }), false);
	assert.equal(isRememberedAcpConfigOption({ id: "temperature", category: "model_config" }), false);
	assert.equal(isRememberedAcpConfigOption({ id: "effort", category: "thought_level" }), true);
	assert.equal(isRememberedAcpConfigOption({ id: "mode", category: "mode" }), true);
	// CodeBuddy 的 PTC/权限模式可能是自定义 category,必须记住
	assert.equal(isRememberedAcpConfigOption({ id: "ptc", category: "tool_mode" }), true);
});

test("planAcpConfigReplay keeps only present, typed, changed and remembered options", () => {
	const options = [
		{ id: "model", category: "model", type: "select", currentValue: "gpt-5" },
		{ id: "effort", category: "thought_level", type: "select", currentValue: "medium" },
		{ id: "mode", category: "mode", type: "select", currentValue: "ask" },
		{ id: "flag", category: "mode", type: "boolean", currentValue: false },
		{ id: "auto", category: "mode", type: "boolean", currentValue: false },
	];
	const plan = planAcpConfigReplay(options, { model: "o3", effort: "high", mode: "ask", gone: "x", flag: "true", auto: true });
	assert.equal(
		JSON.stringify(plan),
		JSON.stringify([
			{ id: "effort", value: "high" },
			{ id: "auto", value: true },
		]),
	);
	assert.equal(JSON.stringify(planAcpConfigReplay(undefined, { effort: "high" })), "[]");
	assert.equal(JSON.stringify(planAcpConfigReplay(options, undefined)), "[]");
});

test("withAcpConfigDefault is immutable and skips no-op/invalid writes", () => {
	const base = { t1: { effort: "medium" } };
	const next = withAcpConfigDefault(base, "t1", "effort", "high");
	assert.equal(JSON.stringify(next), JSON.stringify({ t1: { effort: "high" } }));
	assert.equal(JSON.stringify(base), JSON.stringify({ t1: { effort: "medium" } }));
	assert.equal(withAcpConfigDefault(base, "t1", "effort", "medium"), undefined);
	assert.equal(withAcpConfigDefault(base, " ", "effort", "high"), undefined);
	assert.equal(withAcpConfigDefault(base, "t1", "x", "bad\u0007value"), undefined);
});

test("bypassPermissions:只认显式 true，保存与加载都保留（默认关）", () => {
	// 工具级「新会话默认 bypass 权限」：没写=关，写了 true 才开；脏值一律当关。
	const [kept] = sanitizeAcpTools([{ ...validTool, bypassPermissions: true }]);
	assert.equal(kept.bypassPermissions, true);
	const [dropped] = sanitizeAcpTools([{ ...validTool, bypassPermissions: "yes" }]);
	assert.equal("bypassPermissions" in dropped, false, "非布尔值不得落盘成开关");

	const validated = validateAcpTool({ name: "Claude Agent", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"], bypassPermissions: true });
	assert.equal(validated.ok, true);
	assert.equal(validated.tool.bypassPermissions, true);
	const off = validateAcpTool({ name: "Claude Agent", command: "npx", args: [] });
	assert.equal("bypassPermissions" in off.tool, false, "未勾选时不得凭空写字段");
});

test("validateAcpTool carries env into the normalized tool", () => {
	const result = validateAcpTool({ name: "Codex", command: "codex-acp", args: [], env: { ZAI_CODING_KEY: "sk-xyz" } });
	assert.equal(result.ok, true);
	assert.equal(JSON.stringify(result.tool.env), JSON.stringify({ ZAI_CODING_KEY: "sk-xyz" }));
});

test("模式档：按 id/category 定位 mode 项，bypass 值按各家叫法识别（含分组展开）", () => {
	const grouped = {
		id: "permissions",
		name: "Permissions",
		category: "mode",
		type: "select",
		currentValue: "yolo",
		options: [
			{ group: "Safe", name: "Safe", options: [{ value: "default", name: "Default" }] },
			{
				group: "Open",
				name: "Open",
				options: [
					{ value: "acceptEdits", name: "Accept Edits" },
					{ value: "yolo", name: "Bypass Permissions" },
				],
			},
		],
	};
	assert.equal(isAcpModeOption(grouped), true);
	assert.equal(isAcpModeOption({ id: "MODE" }), true, "id 大小写不敏感");
	assert.equal(isAcpModeOption({ id: "model", category: "model" }), false);
	assert.equal(findAcpModeOption([{ id: "model", name: "Model", category: "model", type: "select" }, grouped])?.id, "permissions");
	assert.equal(findAcpModeOption([{ id: "mode", name: "Mode", type: "boolean" }]), undefined, "boolean 型不是模式枚举");
	// Claude bypassPermissions / Qoder yolo / 其余 bypass_permissions 前缀都要认
	assert.equal(
		findAcpBypassModeValue({
			type: "select",
			options: [
				{ value: "default", name: "Default" },
				{ value: "bypassPermissions", name: "Bypass" },
			],
		}),
		"bypassPermissions",
	);
	assert.equal(findAcpBypassModeValue(grouped), "yolo");
	// CodeBuddy 2.178.1：fullAccess 连危险命令也不拦，语义强于 bypassPermissions，优先选它
	assert.equal(
		findAcpBypassModeValue({
			type: "select",
			options: [
				{ value: "bypassPermissions", name: "Bypass" },
				{ value: "fullAccess", name: "Full access" },
			],
		}),
		"fullAccess",
	);
	assert.equal(findAcpBypassModeValue({ type: "select", options: [{ value: "plan", name: "Plan" }] }), undefined);
	assert.equal(findAcpBypassModeValue(undefined), undefined);
});
