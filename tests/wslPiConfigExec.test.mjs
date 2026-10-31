/**
 * WSL 配置写盘端口（W3）：发行版内原子替换的可注入执行层。
 *
 * 这里是「命令行契约」的唯一可断言处：argv 顺序、/bin/sh -c 脚本参数化、stdin 完整 JSON 字节、
 * shell:false、超时与失败到稳定码的映射。单测不真跑 wsl.exe：execFile 是注入端口，
 * 只验证我们发出去的进程调用长什么样、失败如何收敛。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const storeModule = loadTsCommonJs("src/main/config/WslPiConfigStore.ts");
const shared = loadTsCommonJs("src/shared/piConfig.ts");

const DISTRO = "Ubuntu-26.04";
const USER = "dev";
const CONFIG_DIR = "/home/dev/.pi/agent";
const FILE_NAME = "models.json";
const CONTENT = '{\n  "providers": {\n    "openai": {}\n  }\n}\n';

async function rejectionCode(run) {
	try {
		await run();
	} catch (error) {
		return typeof error?.message === "string" ? error.message : String(error);
	}
	throw new Error("EXPECTED_REJECTION");
}

function createExec(options = {}) {
	const calls = [];
	return {
		calls,
		execFile: async (command, args, execOptions, stdin) => {
			calls.push({ command, args, execOptions, stdin });
			if (options.error !== undefined) throw options.error;
		},
	};
}

function createExecPort(options = {}) {
	const run = createExec(options);
	const port = storeModule.createNodeWslPiConfigExec({
		platform: options.platform ?? "win32",
		wslExe: options.wslExe ?? (() => ({ command: "C:\\Windows\\System32\\wsl.exe", shell: false })),
		exists: options.exists ?? (() => true),
		execFile: run.execFile,
	});
	return { port, calls: run.calls };
}

const INPUT = { distro: DISTRO, user: USER, configDir: CONFIG_DIR, fileName: FILE_NAME, content: CONTENT };

test("执行端口发出固定的 wsl.exe argv：shell:false、发行版/用户、/bin/sh -c 与位置参数", async () => {
	const { port, calls } = createExecPort();
	await port(INPUT);
	assert.equal(calls.length, 1);
	const call = calls[0];
	assert.equal(call.command, "C:\\Windows\\System32\\wsl.exe");
	assert.equal(call.execOptions.shell, false, "绝不能经 cmd/PowerShell 转一手");
	assert.equal(call.execOptions.timeoutMs, 15000);
	assert.deepEqual(JSON.parse(JSON.stringify(call.args.slice(0, 7))), ["-d", DISTRO, "-u", USER, "--exec", "/bin/sh", "-c"]);
	const script = call.args[7];
	// 脚本只从位置参数取目录和文件名：distro/user 是档案数据，不能拼进脚本文本。
	assert.equal(call.args[8], "pideck-config");
	assert.equal(call.args[9], CONFIG_DIR);
	assert.equal(call.args[10], FILE_NAME);
	assert.match(script, /umask 077/);
	assert.match(script, /dir="\$1"/);
	assert.match(script, /name="\$2"/);
	assert.match(script, /cat > /);
	assert.match(script, /mv -f /);
	// 同目录临时文件：\$name 前缀的点文件落在 \$dir 里，rename 才可能是原子的。
	assert.match(script, /tmp="\$dir\/\.\$name\.tmp\.\$\$"/);
});

test("stdin 是完整 JSON 字节（含换行、UTF-8 多字节内容一个不丢）", async () => {
	const { port, calls } = createExecPort();
	const content = '{\n  "providers": {\n    "openai": { "baseUrl": "https://api.example.com/v1?note=\u914d\u7f6e" }\n  }\n}\n';
	await port({ ...INPUT, content });
	assert.equal(calls[0].stdin, content);
	assert.equal(Buffer.byteLength(calls[0].stdin, "utf8"), Buffer.byteLength(content, "utf8"));
});

test("非零退出 → WSL_CONFIG_PATH_UNREADABLE，且不透出 stderr 原文", async () => {
	const error = Object.assign(new Error("Command failed: wsl.exe ... Permission denied for /etc/secret"), { code: 1 });
	const { port } = createExecPort({ error });
	assert.equal(await rejectionCode(() => port(INPUT)), shared.WSL_CONFIG_CODES.pathUnreadable);
});

test("执行超时（被 kill）→ WSL_CONFIG_PATH_UNREADABLE，不当作发行版不可用", async () => {
	const error = Object.assign(new Error("Command failed: wsl.exe ... killed"), { killed: true, signal: "SIGTERM" });
	const { port } = createExecPort({ error });
	assert.equal(await rejectionCode(() => port(INPUT)), shared.WSL_CONFIG_CODES.pathUnreadable);
});

test("wsl.exe 不存在（ENOENT）→ WSL_CONFIG_UNAVAILABLE，且失败不泄露命令细节", async () => {
	const error = Object.assign(new Error("spawn C:\\Windows\\System32\\wsl.exe ENOENT"), { code: "ENOENT" });
	const { port } = createExecPort({ error });
	assert.equal(await rejectionCode(() => port(INPUT)), shared.WSL_CONFIG_CODES.unavailable);

	// 绝对路径在发请求前就判存在性：缺失时连一次进程调用都不发。
	const missing = createExecPort({ exists: () => false });
	assert.equal(await rejectionCode(() => missing.port(INPUT)), shared.WSL_CONFIG_CODES.unavailable);
	assert.equal(missing.calls.length, 0);
});

test("非 Windows / shell 回退一律 WSL_CONFIG_UNAVAILABLE，且不执行任何命令", async () => {
	const nonWindows = createExecPort({ platform: "darwin" });
	assert.equal(await rejectionCode(() => nonWindows.port(INPUT)), shared.WSL_CONFIG_CODES.unavailable);
	assert.equal(nonWindows.calls.length, 0);

	const shellFallback = createExecPort({ wslExe: () => ({ command: "wsl", shell: true }) });
	assert.equal(await rejectionCode(() => shellFallback.port(INPUT)), shared.WSL_CONFIG_CODES.unavailable);
	assert.equal(shellFallback.calls.length, 0);
});
