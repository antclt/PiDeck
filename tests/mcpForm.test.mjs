import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { argsToText, buildMcpDisplayServers, isMcpServerName, omitUndefined, recordToText, textToArgs, textToRecord } = loadTsCommonJs("src/renderer/src/config/mcpForm.ts");

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
