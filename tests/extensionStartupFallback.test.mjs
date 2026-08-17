import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	shouldRetryWithoutExtensions,
	extractExtensionLoadHints,
	formatExtensionFallbackDebug,
} = loadTsCommonJs("src/main/pi/extensionStartupFallback.ts");

const SAMPLE_STDERR = [
	'Error: Failed to load extension "D:\\\\app\\\\resources\\\\extensions\\\\pi-deck-ask-question.ts":',
	"Cannot find module '@earendil-works/pi-ai'",
	'Error: Failed to load extension "D:\\\\app\\\\resources\\\\extensions\\\\pi-deck-todo.ts":',
	"Cannot find module '@earendil-works/pi-ai'",
].join("\n");

test("retries when extension load kills the RPC process", () => {
	assert.equal(
		shouldRetryWithoutExtensions({
			alreadyNoExtensions: false,
			stderr: SAMPLE_STDERR,
			errorMessage: "pi exited: code=1, signal=null",
			exitCode: 1,
		}),
		true,
	);
});

test("does not retry when user already disabled extensions", () => {
	assert.equal(
		shouldRetryWithoutExtensions({
			alreadyNoExtensions: true,
			stderr: SAMPLE_STDERR,
			errorMessage: "pi exited: code=1, signal=null",
			exitCode: 1,
		}),
		false,
	);
});

test("does not retry while the process is still running (timeout / slow start)", () => {
	assert.equal(
		shouldRetryWithoutExtensions({
			alreadyNoExtensions: false,
			errorMessage: "RPC request timed out",
			processStillRunning: true,
		}),
		false,
	);
});

test("does not retry spawn ENOENT or missing WSL", () => {
	assert.equal(
		shouldRetryWithoutExtensions({
			alreadyNoExtensions: false,
			errorMessage: "spawn ENOENT",
			exitCode: -1,
		}),
		false,
	);
	assert.equal(
		shouldRetryWithoutExtensions({
			alreadyNoExtensions: false,
			errorMessage: "WSL distribution is unavailable for pi startup.",
		}),
		false,
	);
});

test("retries a non-zero exit even without explicit extension wording", () => {
	// 日志里常见的失败形态：stderr 还没刷完，只看到 pi exited / exit 1。
	assert.equal(
		shouldRetryWithoutExtensions({
			alreadyNoExtensions: false,
			errorMessage: "pi exited: code=1, signal=null",
			exitCode: 1,
		}),
		true,
	);
});

test("extracts unique extension load hints for the chat diagnostic card", () => {
	const hints = extractExtensionLoadHints(SAMPLE_STDERR);
	assert.ok(hints.some((line) => /Failed to load extension/.test(line)));
	assert.ok(hints.some((line) => /Cannot find module '@earendil-works\/pi-ai'/.test(line)));
	assert.equal(new Set(hints).size, hints.length);
});

test("formats fallback debug that users can paste to the AI", () => {
	const debug = formatExtensionFallbackDebug({
		rawMessage: "pi exited: code=1, signal=null",
		stderr: SAMPLE_STDERR,
		exitCode: 1,
	});
	assert.match(debug, /First start exit code: 1/);
	assert.match(debug, /Failed to load extension/);
	assert.match(debug, /@earendil-works\/pi-ai/);
});

test("AgentManager wires handshake fallback and persists disable only after success", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(source, /private async handshakePiProcess\(/);
	assert.match(source, /retrying without extensions/);
	assert.match(source, /piRpcNoExtensions: true/);
	assert.match(source, /notifyExtensionFallback\(/);
	assert.match(source, /diagnostic\.extensionsDisabledFallback/);
	assert.match(source, /startupHandshakeAgents/);
	// 先二次 spawn 成功，再写设置：避免回退也失败时误关扩展。
	const persistAt = source.indexOf('this.settingsStore.update({ piRpcNoExtensions: true })');
	const secondAt = source.indexOf("const second = await this.spawnAndGetState");
	assert.ok(secondAt >= 0 && persistAt > secondAt, "persist disable only after successful retry");
});
