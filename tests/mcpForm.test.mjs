import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	argsToText,
	buildMcpDisplayServers,
	isMcpServerName,
	omitUndefined,
	recordToText,
	textToArgs,
	textToRecord,
} = loadTsCommonJs(
	"src/renderer/src/config/mcpForm.ts",
);

test("MCP form args round-trip splits on whitespace", () => {
	assert.equal(argsToText(["-y", "chrome-devtools-mcp@1.6.0"]), "-y chrome-devtools-mcp@1.6.0");
	assert.deepEqual([...textToArgs(" -y   chrome-devtools-mcp@1.6.0 ")], ["-y", "chrome-devtools-mcp@1.6.0"]);
	assert.equal(textToArgs("   "), undefined);
});

test("MCP form KEY=value records keep equals inside values", () => {
	assert.equal(recordToText({ API_KEY: "sk=abc", EMPTY: "" }), "API_KEY=sk=abc\nEMPTY=");
	assert.deepEqual({ ...textToRecord("API_KEY=sk=abc\n\nEMPTY=\nFLAG") }, {
		API_KEY: "sk=abc",
		EMPTY: "",
		FLAG: "",
	});
	assert.equal(textToRecord("\n\n"), undefined);
});

test("omitUndefined keeps defined overlay fields without wiping command", () => {
	const merged = { command: "npx", ...omitUndefined({ disabled: true, command: undefined }) };
	assert.equal(merged.command, "npx");
	assert.equal(merged.disabled, true);
});

test("project MCP display preserves the main-process merged precedence", () => {
	const snapshot = {
		writablePath: "/home/me/.pi/agent/mcp.json",
		writableFile: { mcpServers: { docs: { command: "global" } } },
		writableRaw: "",
		layers: [],
		servers: [{
			name: "docs",
			definition: { command: "project" },
			originPath: "/repo/.mcp.json",
			overridePath: "/repo/.mcp.json",
			ownedByWritable: false,
		}],
	};
	const projectItems = buildMcpDisplayServers(snapshot, snapshot.writableFile, "project");
	assert.equal(projectItems[0].definition.command, "project");
	const globalItems = buildMcpDisplayServers(snapshot, snapshot.writableFile, "global");
	assert.equal(globalItems[0].definition.command, "global");
});

test("MCP form server names match the main-process rule", () => {
	assert.equal(isMcpServerName("chrome-devtools"), true);
	assert.equal(isMcpServerName("has space"), false);
	assert.equal(isMcpServerName("../evil"), false);
});
