/**
 * PiModelProber.parsePiProbeOutput 单测。
 *
 * 背景：模型「测试连接」改为用真实 pi --mode json --print 做一次最小调用，
 * 解析 pi 的 JSON 事件流判断成败，替代旧 net.fetch 模拟请求。
 *
 * 断言 parsePiProbeOutput 对四种输出形态的行为：
 *  1. stopReason="stop" → 成功，携带 model/usage/文本片段；
 *  2. stopReason="error" → 失败，携带 errorMessage；
 *  3. 无 agent_end 事件 → 失败（pi 进程异常/无输出）；
 *  4. content 分段数组正确拼接为文本片段。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const syncRequire = createRequire(import.meta.url);

const MODULE_PATH = "src/main/pi/PiModelProber.ts";

function compile(execFileImpl = () => {}) {
	const source = readFileSync(MODULE_PATH, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: MODULE_PATH,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => {
		// execFile 可注入：parsePiProbeOutput 用不到，probePiModel 靠它捕获实参/模拟成败。
		// type-only import（PiLocator/SettingsStore/shared）经 transpile 擦除。
		if (specifier === "node:child_process") return { execFile: execFileImpl };
		return {};
	};
	vm.runInNewContext(
		output,
		{ module, exports: module.exports, require: localRequire, console },
		{ filename: MODULE_PATH },
	);
	return module.exports;
}

const { parsePiProbeOutput } = compile();

function agentEndLine(assistant) {
	const messages = [{ role: "user", content: [{ type: "text", text: "Hi" }] }, assistant];
	return JSON.stringify({ type: "agent_end", messages });
}

test("stopReason=stop 判定为成功并携带 model/usage/片段", () => {
	const stdout = [
		JSON.stringify({ type: "session", version: 3, id: "x" }),
		JSON.stringify({ type: "agent_start" }),
		agentEndLine({
			role: "assistant",
			content: [{ type: "text", text: "Hello!" }],
			model: "gpt-4o",
			stopReason: "stop",
			usage: { input: 10, output: 3 },
		}),
	].join("\n");

	const result = parsePiProbeOutput(stdout);
	assert.equal(result.success, true);
	assert.equal(result.model, "gpt-4o");
	assert.equal(result.snippet, "Hello!");
	// vm 跨上下文对象原型不同，逐字段断言避免 deepStrictEqual 误报。
	assert.equal(result.tokens.input, 10);
	assert.equal(result.tokens.output, 3);
});

test("stopReason=error 判定为失败并携带 errorMessage", () => {
	const stdout = [
		agentEndLine({
			role: "assistant",
			content: [],
			model: "o3-mini",
			stopReason: "error",
			errorMessage: "401 status code (no body)",
		}),
	].join("\n");

	const result = parsePiProbeOutput(stdout);
	assert.equal(result.success, false);
	assert.equal(result.error, "401 status code (no body)");
	assert.equal(result.model, "o3-mini");
});

test("无 agent_end 事件时判定为失败", () => {
	const stdout = [
		JSON.stringify({ type: "session", version: 3, id: "x" }),
		JSON.stringify({ type: "agent_start" }),
	].join("\n");

	const result = parsePiProbeOutput(stdout);
	assert.equal(result.success, false);
	assert.ok(result.error, "应给出失败原因");
});

test("content 分段数组正确拼接为文本片段（跳过 reasoning 等非 text 分段）", () => {
	const stdout = [
		agentEndLine({
			role: "assistant",
			content: [
				{ type: "reasoning", text: "思考过程" },
				{ type: "text", text: "第一段" },
				{ type: "text", text: "第二段" },
			],
			model: "claude-sonnet-4",
			stopReason: "stop",
		}),
	].join("\n");

	const result = parsePiProbeOutput(stdout);
	assert.equal(result.success, true);
	assert.equal(result.snippet, "第一段第二段");
});

// ── probePiModel：超时与错误判定 ─────────────────────────────────
// 背景 issue #173：deepseek-v4-flash 等 reasoning 模型 thinking 阶段首包慢，
// 原 45s 探针超时会在模型实际可用时误报（用户会话内调用同一模型正常）。

/** 构造 probePiModel 的依赖替身；execFile 由调用方注入以捕获实参或模拟成败。 */
function setupProbe(execFileImpl) {
	const loaded = compile(execFileImpl);
	const settings = {
		wslEnabled: false,
		wslDistro: "",
		wslUser: "",
		customPiPath: undefined,
	};
	const piLocator = {
		resolveCommand: () => "/usr/bin/pi",
		createInvocation: (command, args) => ({
			command,
			args,
			pathPrefix: "",
			wsl: false,
			shell: false,
			windowsVerbatimArguments: false,
		}),
		createProcessEnv: () => ({}),
		warmWslCommand: async () => undefined,
	};
	return { ...loaded, piLocator, settingsStore: { get: () => settings } };
}

test("probePiModel 以放宽后的 120s 作为 execFile 超时", async () => {
	let captured;
	const { probePiModel, piLocator, settingsStore } = setupProbe((_cmd, _args, opts, cb) => {
		captured = opts;
		cb(
			null,
			agentEndLine({
				role: "assistant",
				content: [{ type: "text", text: "Hi" }],
				model: "deepseek-v4-flash",
				stopReason: "stop",
			}),
			"",
		);
	});

	await probePiModel(piLocator, settingsStore, "deepseek", "deepseek-v4-flash");

	assert.equal(captured.timeout, 120_000);
	// 回归护栏：防止超时被改回 issue #173 里误报的 45s
	assert.ok(captured.timeout > 45_000, "探针超时不得回退到 45s");
});

test("pi 进程被 kill 时判定为超时失败，错误信息带上超时秒数", async () => {
	const { probePiModel, piLocator, settingsStore } = setupProbe((_cmd, _args, _opts, cb) => {
		const err = new Error("killed");
		err.killed = true;
		cb(err, "", "");
	});

	const result = await probePiModel(piLocator, settingsStore, "deepseek", "deepseek-v4-flash");

	assert.equal(result.success, false);
	assert.equal(result.error, "pi model probe timed out after 120s");
	assert.equal(typeof result.latencyMs, "number");
});

test("ETIMEDOUT 错误码同样判定为超时", async () => {
	const { probePiModel, piLocator, settingsStore } = setupProbe((_cmd, _args, _opts, cb) => {
		const err = new Error("spawn timeout");
		err.code = "ETIMEDOUT";
		cb(err, "", "");
	});

	const result = await probePiModel(piLocator, settingsStore, "p", "m");

	assert.equal(result.success, false);
	assert.match(result.error, /timed out/);
});

test("非超时失败优先透传 pi 的 stderr", async () => {
	const { probePiModel, piLocator, settingsStore } = setupProbe((_cmd, _args, _opts, cb) => {
		cb(new Error("unknown option"), "", "error: unknown option --foo");
	});

	const result = await probePiModel(piLocator, settingsStore, "p", "m");

	assert.equal(result.success, false);
	assert.equal(result.error, "error: unknown option --foo");
});
