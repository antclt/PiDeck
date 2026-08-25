import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	inferMcpTransport,
	isMcpServerName,
	mergeMcpServers,
	mcpLayerPaths,
	parseMcpConfigFile,
	probeHttpUrl,
	probeStdioCommand,
	validateMcpServer,
	loadMcpConfigSnapshot,
} = loadTsCommonJs("src/main/config/mcpConfig.ts");

test("mcp server names reject empty and path-like values", () => {
	assert.equal(isMcpServerName("chrome-devtools"), true);
	assert.equal(isMcpServerName("docs_v2"), true);
	assert.equal(isMcpServerName(""), false);
	assert.equal(isMcpServerName("../evil"), false);
	assert.equal(isMcpServerName("has space"), false);
});

test("transport inference requires exactly one of command/url/socket", () => {
	assert.equal(inferMcpTransport({ command: "npx" }), "stdio");
	assert.equal(inferMcpTransport({ url: "https://mcp.example/mcp" }), "http");
	assert.equal(inferMcpTransport({ socket: "/tmp/mcp.sock" }), "socket");
	assert.equal(inferMcpTransport({ command: "npx", url: "https://x" }), null);
	assert.equal(inferMcpTransport({}), null);
});

test("disabled overlay without transport is valid; mixed transports are not", () => {
	assert.equal(validateMcpServer("docs", { disabled: true }), null);
	assert.match(validateMcpServer("docs", { command: "npx", url: "https://x" }), /exactly one/);
	assert.match(validateMcpServer("bad name", { command: "npx" }), /Invalid/);
});

test("later layers shallow-merge same-name servers without dropping command", () => {
	const merged = mergeMcpServers(
		[
			{
				path: "/home/user/.config/mcp/mcp.json",
				file: { mcpServers: { docs: { command: "npx", args: ["-y", "docs"] } } },
			},
			{
				path: "/home/user/.pi/agent/mcp.json",
				file: { mcpServers: { docs: { disabled: true } } },
			},
		],
		"/home/user/.pi/agent/mcp.json",
	);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].definition.command, "npx");
	assert.equal(merged[0].definition.disabled, true);
	assert.equal(merged[0].originPath, "/home/user/.config/mcp/mcp.json");
	assert.equal(merged[0].overridePath, "/home/user/.pi/agent/mcp.json");
	assert.equal(merged[0].ownedByWritable, false);
});

test("ownedByWritable is true only when the transport definition lives in the Pi file", () => {
	const merged = mergeMcpServers(
		[
			{
				path: "/home/user/.pi/agent/mcp.json",
				file: { mcpServers: { local: { command: "npx" } } },
			},
		],
		"/home/user/.pi/agent/mcp.json",
	);
	assert.equal(merged[0].ownedByWritable, true);
});

test("mcp layer paths include project files only when a project root is given", () => {
	const globalOnly = mcpLayerPaths("/home/me", "/home/me/.pi/agent");
	assert.equal(globalOnly.some((layer) => layer.kind === "project"), false);
	assert.equal(globalOnly.find((layer) => layer.kind === "pi-agent")?.writable, true);
	const withProject = mcpLayerPaths("/home/me", "/home/me/.pi/agent", "/repo");
	assert.ok(withProject.some((layer) => layer.path.endsWith(".mcp.json")));
	assert.ok(withProject.some((layer) => layer.path.replace(/\\/g, "/").endsWith(".pi/mcp.json")));
});

test("stdio probe resolves an existing absolute command and rejects missing ones", () => {
	const ok = probeStdioCommand(process.execPath);
	assert.equal(ok.ok, true);
	const missing = probeStdioCommand("definitely-not-a-pideck-mcp-bin-xyz");
	assert.equal(missing.ok, false);
	assert.match(missing.error, /not found/i);
});

test("HTTP probe treats 4xx as reachable config and 5xx as failure", async () => {
	const reachable = await probeHttpUrl("https://mcp.example/mcp", async () => ({ status: 405 }), 1000);
	assert.equal(reachable.ok, true);
	const down = await probeHttpUrl("https://mcp.example/mcp", async () => ({ status: 502 }), 1000);
	assert.equal(down.ok, false);
	const invalid = await probeHttpUrl("not-a-url");
	assert.equal(invalid.ok, false);
});

test("loadMcpConfigSnapshot merges layers and exposes writable raw", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-mcp-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	await mkdir(join(home, ".config", "mcp"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(home, ".config", "mcp", "mcp.json"),
		JSON.stringify({ mcpServers: { shared: { command: "npx", args: ["-y", "shared"] } } }),
		"utf8",
	);
	await writeFile(
		join(agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { local: { url: "https://mcp.local/mcp" } } }, null, 2),
		"utf8",
	);
	const snapshot = await loadMcpConfigSnapshot(agentDir, undefined, home);
	assert.equal(snapshot.servers.length, 2);
	assert.ok(snapshot.servers.some((item) => item.name === "shared"));
	assert.ok(snapshot.servers.some((item) => item.name === "local" && item.ownedByWritable));
	assert.match(snapshot.writableRaw, /local/);
	assert.equal(snapshot.layers.find((layer) => layer.kind === "user-config")?.exists, true);
});

test("broken writable mcp.json keeps raw, reports error, and does not wipe other layers", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-mcp-broken-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	await mkdir(join(home, ".config", "mcp"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(home, ".config", "mcp", "mcp.json"),
		JSON.stringify({ mcpServers: { shared: { command: "npx" } } }),
		"utf8",
	);
	await writeFile(join(agentDir, "mcp.json"), "{ not json", "utf8");
	const snapshot = await loadMcpConfigSnapshot(agentDir, undefined, home);
	assert.ok(snapshot.writableError);
	assert.match(snapshot.writableRaw, /not json/);
	assert.equal(snapshot.servers.length, 1);
	assert.equal(snapshot.servers[0].name, "shared");
	assert.deepEqual({ ...snapshot.writableFile, mcpServers: { ...snapshot.writableFile.mcpServers } }, { mcpServers: {} });
});

test("parseMcpConfigFile rejects non-object mcpServers", () => {
	const bad = parseMcpConfigFile(JSON.stringify({ mcpServers: [] }));
	assert.ok(bad.error);
	const ok = parseMcpConfigFile(JSON.stringify({ mcpServers: { a: { command: "npx" } } }));
	assert.equal(ok.error, undefined);
	assert.equal(ok.file.mcpServers.a.command, "npx");
});
