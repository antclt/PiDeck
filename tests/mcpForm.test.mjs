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
	const merged = { command: "npx", ...omitUndefined({ disabled: true, command: undefined }) };
	assert.equal(merged.command, "npx");
	assert.equal(merged.disabled, true);
});

test("display servers overlay the local writable draft without losing lower-layer fields", () => {
	const snapshot = {
		writablePath: "/home/me/.pi/agent/mcp.json",
		writableFile: { mcpServers: { docs: { command: "global" } } },
		writableRaw: "",
		layers: [],
		servers: [
			{
				name: "docs",
				definition: { command: "npx", disabled: true },
				originPath: "/home/me/.claude.json",
				overridePath: "/home/me/.claude.json",
				ownedByWritable: false,
			},
		],
	};
	const items = buildMcpDisplayServers(snapshot, { mcpServers: { docs: { disabled: false }, extra: { url: "https://example.com/mcp" } } });
	const docs = items.find((item) => item.name === "docs");
	assert.equal(docs.definition.disabled, false);
	// 只读层的 command 不能被可写草稿冲掉
	assert.equal(docs.definition.command, "npx");
	assert.equal(docs.ownedByWritable, false);
	assert.equal(docs.overridePath, snapshot.writablePath);
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
