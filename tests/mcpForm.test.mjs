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
