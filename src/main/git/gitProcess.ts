import { spawn } from "node:child_process";

/**
 * git 子进程执行器（可单测的独立模块）。
 *
 * 只依赖 node 内置模块，不 import 项目内其他 TS 文件，因此可以被 Node 24 的
 * type stripping 直接加载（tests/*.test.mjs 里 `import ... from "./gitProcess.ts"`）。
 */

/** 默认 mutation 超时（30s），与 GitService.GIT_MUTATION_TIMEOUT_MS 同语义。 */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/**
 * 递归终止以 pid 为根的子进程树。
 *
 * - Windows：`taskkill /T /F` 递归杀整棵树（含 SSH / credential-helper / git hooks 孙进程）。
 * - Unix：依赖 spawn 的 `detached: true` 使子进程成为新进程组组长，用负 pid 杀整个进程组。
 */
export function killProcessTree(
	childPid: number,
	platform: NodeJS.Platform = process.platform,
): void {
	if (platform === "win32") {
		// /T 递归杀树，/F 强制；忽略 taskkill 自身退出码（目标进程可能已退出）。
		spawn("taskkill", ["/pid", String(childPid), "/T", "/F"], {
			windowsHide: true,
			stdio: "ignore",
		});
	} else {
		try {
			process.kill(-childPid, "SIGKILL");
		} catch {
			// 进程组已不存在，忽略。
		}
	}
}

export interface RunGitOptions {
	cwd: string;
	timeoutMs?: number;
	maxBuffer?: number;
}

/**
 * 执行一个 git 命令并返回 stdout/stderr。`command` 可注入（测试用 node 脚本模拟 git）。
 *
 * 为什么不用 promisify(execFile)：execFile 的 timeout 超时后只 kill 直接子进程（git 自身），
 * 但 push/pull/fetch/带 hook 的 commit/cherry-pick/rebase 会 spawn 孙进程（SSH、credential-helper、
 * git hooks），孙进程继承 stdout/stderr 管道。git 被杀后孙进程仍持有管道 → close 事件不触发 →
 * promise 永不 settle → 渲染层 mutationRunningRef 永远卡死、后续操作全部被拒绝（转圈无法操作）。
 *
 * 这里用 spawn + 进程树 kill + 兜底超时，保证任何情况下 promise 都会 settle。
 */
export function runGit(
	args: string[],
	options: RunGitOptions,
	command = "git",
): Promise<{ stdout: string; stderr: string }> {
	const {
		cwd,
		timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
		maxBuffer = 16 * 1024 * 1024,
	} = options;
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			// Unix：detached 让子进程成为新进程组组长，超时时可用负 pid kill 整个进程树。
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let overflowed = false;
		let settled = false;
		let treeKilled = false;
		let mainTimer: NodeJS.Timeout | null = null;
		let fallbackTimer: NodeJS.Timeout | null = null;

		const append = (target: "stdout" | "stderr", chunk: Buffer) => {
			const next = (target === "stdout" ? stdoutBytes : stderrBytes) + chunk.length;
			if (target === "stdout") stdoutBytes = next;
			else stderrBytes = next;
			// 超过 maxBuffer 后丢弃多余内容（防内存膨胀），保留溢出标志供 close 时拒绝。
			if (next > maxBuffer) {
				overflowed = true;
				return;
			}
			if (target === "stdout") stdout += chunk.toString("utf8");
			else stderr += chunk.toString("utf8");
		};

		child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};

		const clearTimers = () => {
			if (mainTimer) {
				clearTimeout(mainTimer);
				mainTimer = null;
			}
			if (fallbackTimer) {
				clearTimeout(fallbackTimer);
				fallbackTimer = null;
			}
		};

		mainTimer = setTimeout(() => {
			if (child.pid !== undefined && !treeKilled) {
				treeKilled = true;
				killProcessTree(child.pid);
			}
			// 兜底：进程树被 kill 后最多再等 2s，若孙进程仍持有管道导致 close 不触发，则强制拒绝。
			fallbackTimer = setTimeout(() => {
				settle(() => reject(new Error(`Command timed out: ${command} ${args.join(" ")}`)));
			}, 2000);
			fallbackTimer.unref?.();
		}, timeoutMs);

		child.on("error", (err) => {
			clearTimers();
			settle(() => reject(err));
		});

		child.on("close", (code) => {
			clearTimers();
			if (overflowed) {
				settle(() =>
					reject(new Error(`Command output exceeded ${maxBuffer} bytes: ${command} ${args.join(" ")}`)),
				);
			} else if (code === 0) {
				settle(() => resolve({ stdout, stderr }));
			} else {
				// 对齐 execFile 的报错格式（"Command failed: git <cmd>\n<stderr>"），
				// 渲染层 gitOperationErrorText 依赖该格式剥离首行并展示 stderr 内容。
				settle(() => reject(new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr}`)));
			}
		});
	});
}
