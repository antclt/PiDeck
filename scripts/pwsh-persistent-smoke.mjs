#!/usr/bin/env node
/**
 * pwsh_persistent 人工冒烟测试（不并入 node --test 单测：依赖真实 pwsh/PTY/git）。
 *
 * 与 packages/dsh-tool-pwsh-persistent/src/index.ts 的 createPtySession 保持同步，
 * 验证新版 initCommand 注入（GIT_PAGER/GIT_TERMINAL_PROMPT/npm_config_yes/GIT_EDITOR）
 * 在真实 conpty 下的运行时行为：
 *   1. env 注入是否生效（4 个变量值）
 *   2. git diff / git log 是否不再进分页器挂死（旧版挂 5 分钟，新版应秒回）
 *   3. Set-Location 状态跨调用保持（持久会话语义）
 *
 * 测量要点：marker 用字符串拼接生成（'__SMOKE_' + '<token>__'），PTY 回显里
 * 不会出现完整 marker，避免"回显误匹配导致提前判定"；判定只取发送后新增输出。
 *
 * 用法：node scripts/pwsh-persistent-smoke.mjs
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const SHELL_PROMPT = "__DSH_PERSISTENT_PWSH_PROMPT__ ";
const TIMEOUT_MS = 30000;
const PWSH_PATH = process.env.PWSH_PATH || "pwsh";

// 与 src/index.ts createPtySession 的 initCommand 逐条同步（改动时需两边一致）
const initCommand = [
	"Remove-Module PSReadLine -ErrorAction SilentlyContinue",
	"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
	"$env:GIT_PAGER = 'cat'",
	"$env:GIT_TERMINAL_PROMPT = '0'",
	"$env:npm_config_yes = 'true'",
	"$env:GIT_EDITOR = 'true'",
	`function prompt { '${SHELL_PROMPT} ' }`,
].join("; ");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run() {
	let buffer = "";
	const handle = pty.spawn(PWSH_PATH, ["-NoLogo", "-NoProfile", "-NoExit", "-Command", initCommand], {
		name: "xterm-256color",
		cols: 1000,
		rows: 30,
		cwd: "F:\\PiDeck",
		env: { ...process.env },
	});
	handle.onData((d) => {
		buffer += d;
		if (buffer.length > 1024 * 1024) buffer = buffer.slice(-512 * 1024);
	});
	handle.onExit(() => { buffer += "\n__PTY_EXITED__\n"; });

	async function waitFor(pattern, timeoutMs = TIMEOUT_MS) {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (buffer.includes(pattern)) return { ok: true, took: Date.now() - start };
			await sleep(20);
		}
		return { ok: false, took: Date.now() - start };
	}

	const send = (cmd) => handle.write(cmd + "\r");
	const tail = (n = 600) =>
		buffer.slice(-n).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

	return { handle, waitFor, send, tail, raw: () => buffer };
}

async function step(runCtx, name, cmd, expectFn) {
	const token = Math.random().toString(36).slice(2, 8);
	const marker = `__SMOKE_${token}__`; // 完整 marker 只出现在真实输出；回显里是拼接形态
	const startIdx = runCtx.raw().length;
	const start = Date.now();
	runCtx.send(`${cmd}; Write-Output ('__SMOKE_' + '${token}__')`);
	const res = await runCtx.waitFor(marker);
	const chunk = runCtx.raw().slice(startIdx);
	const pass = res.ok && expectFn(chunk);
	console.log(`[${pass ? "PASS" : "FAIL"}] ${name} (${res.took}ms${res.ok ? "" : " — TIMEOUT!"})`);
	if (!pass) console.log("  --- 输出尾 ---\n" + chunk.slice(-1200).split("\n").slice(-12).join("\n") + "\n  -----------");
	return pass;
}

const results = [];
const s = run();

console.log(`spawn: ${PWSH_PATH}（等待提示符，最长 15s）...`);
const boot = await s.waitFor("__DSH_PERSISTENT_PWSH_PROMPT__", 15000);
console.log(`[${boot.ok ? "PASS" : "FAIL"}] 会话启动与提示符检测 (${boot.took}ms)`);
results.push(boot.ok);
if (!boot.ok) {
	console.log(s.tail(2000));
	s.handle.kill();
	process.exit(1);
}

// 1) env 注入值
results.push(await step(s, "env 注入生效（GIT_PAGER=cat / TERMINAL_PROMPT=0 / yes=true / EDITOR=true）",
	"$env:GIT_PAGER; $env:GIT_TERMINAL_PROMPT; $env:npm_config_yes; $env:GIT_EDITOR",
	(c) => c.includes("cat") && c.includes("true") && c.includes("0")));

// 2) git diff 不再进分页器挂死（旧版会挂到 5 分钟超时）
results.push(await step(s, "git diff --stat HEAD~1 秒回（不分页）", "git diff --stat HEAD~1",
	(c) => c.includes("changed")));

// 3) git log 同样不分页
results.push(await step(s, "git log --oneline -3 秒回（不分页）", "git log --oneline -3",
	(c) => /[0-9a-f]{7,}/.test(c)));

// 4) Set-Location 状态跨调用保持
await step(s, "Set-Location 生效", "Set-Location 'F:\\PiDeck\\src\\main\\dsh'; Get-Location", () => true);
results.push(await step(s, "状态保持：下一条 Get-Location 仍在 src\\main\\dsh", "Get-Location",
	(c) => c.includes("src\\main\\dsh")));

s.handle.kill();
const passed = results.filter(Boolean).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
