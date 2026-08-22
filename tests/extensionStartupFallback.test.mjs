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

test("AgentManager wires handshake fallback but never persists --no-extensions globally", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(source, /private async handshakePiProcess\(/);
	assert.match(source, /retrying without extensions/);
	assert.match(source, /piRpcNoExtensions: true/);
	assert.match(source, /queueStartupDiagnostic\(/);
	assert.match(source, /flushStartupDiagnostics\(/);
	assert.match(source, /diagnostic\.extensionsDisabledFallback/);
	assert.match(source, /startupHandshakeAgents/);
	assert.match(source, /agent_start/);
	// 回退只针对本次运行时：--no-extensions 只以 settingsOverride 传本次 spawn
	// （spawnAndGetState 第三参），绝不写进全局设置。否则用户修复扩展后，
	// 后续所有新 agent 仍无扩展启动，必须手动改回设置才能恢复。
	assert.doesNotMatch(source, /settingsStore\.update\(\(\{ piRpcNoExtensions: true \}\)\)/);
	const overrideCall = source.indexOf("spawnAndGetState(agentId, options, { piRpcNoExtensions: true })");
	assert.ok(overrideCall >= 0, "second spawn carries the per-runtime --no-extensions override");
	// 回退说明卡不立即写时间线：等首个 agent_start（用户消息已落盘）再 flush。
	const queueCall = source.indexOf("this.queueStartupDiagnostic(agentId, diagnostic)");
	const firstRunMark = source.indexOf("this.agentStartedFirstRun.add(agentId)");
	const flushAt = source.indexOf("this.flushStartupDiagnostics(agentId)");
	assert.ok(queueCall >= 0 && firstRunMark >= 0 && flushAt >= 0, "startup diagnostic queued and flushed on first run");
});
