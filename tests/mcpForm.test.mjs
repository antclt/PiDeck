import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { argsToText, buildMcpDisplayServers, isMcpServerName, omitUndefined, parseSmartAddInput, recordToText, suggestNameFromCommand, suggestNameFromDefinition, suggestNameFromUrl, textToArgs, textToRecord, uniqueServerName } = loadTsCommonJs("src/renderer/src/config/mcpForm.ts");

test("MCP form args round-trip splits on whitespace", () => {
	assert.equal(argsToText(["-y", "chrome-devtools-mcp@1.6.0"]), "-y chrome-devtools-mcp@1.6.0");
	assert.deepEqual([...textToArgs(" -y   chrome-devtools-mcp@1.6.0 ")], ["-y", "chrome-devtools-mcp@1.6.0"]);
	assert.equal(textToArgs("   "), undefined);
});

test("MCP form KEY=value records keep equals inside values", () => {
	assert.equal(recordToText({ API_KEY: "sk=abc", EMPTY: "" }), "API_KEY=sk=abc\nEMPTY=");
	assert.deepEqual(
		{ ...textToRecord("API_KEY=sk=abc\n\nEMPTY=\nFLAG") },
		{
			API_KEY: "sk=abc",
			EMPTY: "",
			FLAG: "",
		},
	);
	assert.equal(textToRecord("\n\n"), undefined);
});

test("omitUndefined keeps defined overlay fields without wiping command", () => {
	const merged = { command: "npx", ...omitUndefined({ enabled: false, command: undefined }) };
	assert.equal(merged.command, "npx");
	assert.equal(merged.enabled, false);
});

test("display servers replace the whole entry from the local writable draft (native semantics)", () => {
	const snapshot = {
		writablePath: "/home/me/.pi/agent/mcp.json",
		writableFile: { mcpServers: { docs: { command: "global" } } },
		writableRaw: "",
		layers: [{ kind: "pi-agent", path: "/home/me/.pi/agent/mcp.json", exists: true, writable: true }],
		servers: [
			{
				name: "docs",
				definition: { command: "npx", enabled: false },
				originPath: "/home/me/.pi/agent/mcp.json",
				originScope: "pi-agent",
				ownedByWritable: true,
			},
		],
		invalidServers: [],
	};
	const items = buildMcpDisplayServers(snapshot, { mcpServers: { docs: { url: "https://draft.example/mcp", enabled: true }, extra: { url: "https://example.com/mcp" } } });
	const docs = items.find((item) => item.name === "docs");
	assert.equal(docs.definition.enabled, true);
	// 同名条目整体替换：草稿里没有 command，显示层也不能保留旧 command（pi 实际就是这样加载的）
	assert.equal(docs.definition.command, undefined);
	assert.equal(docs.definition.url, "https://draft.example/mcp");
	assert.equal(docs.ownedByWritable, true);
	assert.equal(docs.originPath, snapshot.writablePath);
	assert.equal(docs.originScope, "pi-agent");
	const extra = items.find((item) => item.name === "extra");
	assert.equal(extra.ownedByWritable, true);
	assert.equal(extra.originPath, snapshot.writablePath);
	assert.deepEqual(
		items.map((item) => item.name),
		["docs", "extra"],
	);
});

test("MCP form server names match the main-process rule", () => {
	assert.equal(isMcpServerName("chrome-devtools"), true);
	assert.equal(isMcpServerName("has space"), false);
	assert.equal(isMcpServerName("../evil"), false);
});

test("display servers 标记草稿已删的本层条目：待删除 vs 回退继承", () => {
	// 用 plain object 构造快照；类型经 TS 校验，测试里只断言关键字段
	const snapshot = {
		writablePath: "/home/me/.pi/agent/mcp.json",
		// writableFile = 磁盘上的可写层（有 gone/inherited 两条）；第二参 writable = 草稿（已全删）
		writableFile: { mcpServers: { gone: { command: "gone" }, inherited: { command: "g" } } },
		writableRaw: "",
		revision: "r1",
		lowerLayerNames: ["inherited"],
		layers: [],
		servers: [
			{ name: "gone", definition: { command: "gone" }, originPath: "/home/me/.pi/agent/mcp.json", originScope: "pi-agent", ownedByWritable: true },
			{ name: "inherited", definition: { command: "g" }, originPath: "/home/me/.pi/agent/mcp.json", originScope: "pi-agent", ownedByWritable: true },
			{ name: "pure-global", definition: { command: "g2" }, originPath: "/g/mcp.json", originScope: "pi-agent", ownedByWritable: false },
		],
		invalidServers: [],
	};
	const items = buildMcpDisplayServers(snapshot, { mcpServers: {} });
	const gone = items.find((item) => item.name === "gone");
	const inherited = items.find((item) => item.name === "inherited");
	const pureGlobal = items.find((item) => item.name === "pure-global");
	// 仅本层有 → 待删除；下层还有同名 → 保存后回退为继承（不是消失）
	assert.equal(gone.pendingDelete, true);
	assert.equal(gone.revertsToInherited, false);
	assert.equal(inherited.pendingDelete, true);
	assert.equal(inherited.revertsToInherited, true);
	// 纯继承条目（从未在本层）不受影响
	assert.equal(pureGlobal.pendingDelete, undefined);
	// 草稿还在的条目无标记
	const withDraft = buildMcpDisplayServers(snapshot, { mcpServers: { gone: { command: "gone" } } });
	assert.equal(withDraft.find((item) => item.name === "gone").pendingDelete, undefined);
});

test("parseSmartAddInput：URL / 无协议域名 / 命令行 / JSON 三形态 / 非法输入", () => {
	// vm 加载的模块对象与测试领域原型不同：一律展开成测试领域的普通对象再比较
	assert.deepEqual({ ...parseSmartAddInput("https://mcp.linear.app/mcp") }, { kind: "url", url: "https://mcp.linear.app/mcp" });
	assert.deepEqual({ ...parseSmartAddInput("mcp.example.com/mcp") }, { kind: "url", url: "https://mcp.example.com/mcp" });
	assert.deepEqual({ ...parseSmartAddInput("example.com") }, { kind: "url", url: "https://example.com" });
	// 命令行：普通与带引号参数
	const quoted = parseSmartAddInput('node server.js --port "8080 x"');
	assert.deepEqual({ kind: quoted.kind, command: quoted.command, args: [...quoted.args] }, { kind: "command", command: "node", args: ["server.js", "--port", "8080 x"] });
	// JSON 三形态：整块 / 命名映射 / 单条裸定义
	const jsonParsed = parseSmartAddInput('{"mcpServers":{"a":{"url":"https://a/mcp"},"b":{"command":"npx"}}}');
	assert.deepEqual(
		{ kind: jsonParsed.kind, servers: [...jsonParsed.servers].map((server) => ({ name: server.name, definition: JSON.parse(JSON.stringify(server.definition)) })) },
		{
			kind: "json",
			servers: [
				{ name: "a", definition: { url: "https://a/mcp" } },
				{ name: "b", definition: { command: "npx" } },
			],
		},
	);
	assert.equal(parseSmartAddInput('{"linear":{"url":"https://mcp.linear.app/mcp"}}').servers[0].name, "linear");
	assert.equal(parseSmartAddInput('{"command":"npx"}').servers[0].definition.command, "npx");
	// 非法/空输入
	assert.equal(parseSmartAddInput(""), null);
	assert.equal(parseSmartAddInput("   "), null);
	const broken = parseSmartAddInput("{ broken");
	assert.deepEqual({ kind: broken.kind, command: broken.command, args: [...broken.args] }, { kind: "command", command: "{", args: ["broken"] }); // 非 JSON 落命令行分支
});

test("suggestNameFromUrl：去常见前缀、取主干、非法字符清洗", () => {
	assert.equal(suggestNameFromUrl("https://mcp.linear.app/mcp"), "linear");
	assert.equal(suggestNameFromUrl("https://mcp.beui.dev/mcp"), "beui");
	assert.equal(suggestNameFromUrl("https://api.example.com/mcp"), "example");
	assert.equal(suggestNameFromUrl("https://example.com/mcp"), "example");
	assert.equal(suggestNameFromUrl("not a url"), ""); // 无法推断时返回空串，由调用方兜底
});

test("suggestNameFromCommand：运行器取包名，非运行器取基名", () => {
	assert.equal(suggestNameFromCommand("npx", ["-y", "@scope/mcp-github"]), "github");
	assert.equal(suggestNameFromCommand("uvx", ["mcp-server-fetch"]), "server-fetch");
	assert.equal(suggestNameFromCommand("/usr/local/bin/my-mcp", []), "my-mcp");
	assert.equal(suggestNameFromCommand("node", ["server.js"]), "node");
});

test("uniqueServerName：冲突追加序号，非法字符清洗并小写", () => {
	const existing = new Set(["linear", "linear-2"]);
	assert.equal(uniqueServerName("Linear", existing), "linear-3");
	assert.equal(uniqueServerName("Fresh Name!", existing), "fresh-name");
	assert.equal(uniqueServerName("", existing), "server");
});
