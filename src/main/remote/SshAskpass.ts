import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One-shot askpass bridge for OpenSSH password authentication.
 *
 * Why this shape: `ssh` only reads a password from a terminal or from `SSH_ASKPASS`, and PiDeck must never
 * put it on a command line, in an environment variable, in a log or in an ordinary temporary file. So the
 * bridge hands `ssh` a program that knows nothing:
 *
 *   ssh -> askpass.cmd/.sh -> <app executable in Node mode> askpass-client.cjs -> local socket
 *
 * The generated program only carries the socket path. The secret is written by this process to a socket in
 * a private directory (POSIX) or to a named pipe (Windows) after the helper reported the prompt, and it
 * never exists as a file, an argument or an environment value.
 *
 * The prompt is checked before the secret is released: `ssh`'s own password prompt always reads
 * `...'s password:`, while keyboard-interactive/MFA challenges arrive with arbitrary text. Answering those
 * with a password would burn authentication attempts and hand the secret to a server that asked for an OTP,
 * so anything that is not a password prompt gets no answer and the helper exits non-zero (fail closed).
 */

/**
 * Only credential-shaped prompts are answered: ssh's password prompt and the passphrase prompt for an
 * encrypted private key. Keyboard-interactive/MFA challenges ("Verification code:") are refused.
 */
const PASSWORD_PROMPT = /(?:password[:：]|passphrase for key .*?:)\s*$/i;

export function isPasswordPrompt(prompt: string): boolean {
	// The prompt arrives as one argv element and cannot contain a newline in practice; bound it anyway so a
	// hostile server cannot make us reason about a megabyte of text.
	return typeof prompt === "string" && prompt.length > 0 && prompt.length <= 1024 && !/[\r\n\0]/.test(prompt) && PASSWORD_PROMPT.test(prompt);
}

export type SshAskpassBridge = {
	/** Environment the `ssh` process must run with. Never contains the secret. */
	readonly env: Readonly<Record<string, string>>;
	/** Prompts the helper has answered (0 or 1 by design). */
	answered(): number;
	/** Prompts that were refused because they were not password prompts. */
	refused(): number;
	/** Stop listening and remove the generated program. Idempotent. */
	dispose(): Promise<void>;
};

export type SshAskpassOptions = {
	/** Secret held by this process only. Never written to disk. */
	secret: string;
	/** Absolute path of an executable that can run JavaScript (`process.execPath` in the app). */
	executable: string;
	platform?: NodeJS.Platform;
	/** Directory owner; defaults to a fresh private directory under the OS temp root. */
	root?: string;
};

/**
 * Helper run by `ssh`. It connects, reports the prompt it was given, and prints whatever the bridge sends
 * back. Any failure is a non-zero exit with no output, so `ssh` never receives a half answer.
 */
const CLIENT_SOURCE = [
	'"use strict";',
	'const net = require("node:net");',
	"const socket = net.connect(process.argv[2]);",
	"let received = false;",
	'socket.setEncoding("utf8");',
	'socket.on("connect", () => {',
	"  // argv[3] is the prompt ssh passed to the generated program; never print it (it can carry a host name).",
	'  socket.write(String(process.argv[3] ?? "") + String.fromCharCode(10));',
	"});",
	'socket.on("data", (chunk) => {',
	"  received = true;",
	"  // Flush before exiting: process.exit() can truncate a piped stdout on Windows.",
	'  process.stdout.write(chunk.replace(/\\r?\\n$/, "") + String.fromCharCode(10), () => process.exit(0));',
	"  socket.end();",
	"});",
	'socket.on("error", () => process.exit(2));',
	"// No answer (refused prompt, bridge gone) must fail so ssh aborts this method.",
	'socket.on("close", () => process.exit(received ? 0 : 2));',
	"setTimeout(() => process.exit(3), 30000).unref();",
	"",
].join("\n");

function windowsLauncher(executable: string, client: string, target: string): string {
	// ELECTRON_RUN_AS_NODE makes the app's own binary behave as Node, so no separate runtime is required.
	// %~1 forwards the prompt ssh passes as the first argument (quotes stripped, safe for `user@host's password:`).
	return ["@echo off", "set ELECTRON_RUN_AS_NODE=1", `"${executable}" "${client}" "${target}" "%~1"`, ""].join("\r\n");
}

function posixLauncher(executable: string, client: string, target: string): string {
	return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${executable}" "${client}" "${target}" "$1"\n`;
}

/**
 * Start the bridge. The caller must `dispose()` it once the `ssh` process it was created for has exited:
 * the directory and the listening socket live exactly as long as that attempt.
 */
export async function createSshAskpassBridge(options: SshAskpassOptions): Promise<SshAskpassBridge> {
	if (typeof options?.secret !== "string" || options.secret.length === 0 || options.secret.length > 4096) throw new Error("SSH_ASKPASS_SECRET_INVALID");
	if (typeof options.executable !== "string" || options.executable.length === 0 || /[\r\n\0"]/.test(options.executable)) throw new Error("SSH_ASKPASS_EXECUTABLE_INVALID");
	const platform = options.platform ?? process.platform;
	const directory = options.root ?? (await mkdtemp(join(tmpdir(), "pideck-askpass-")));
	const clientPath = join(directory, "askpass-client.cjs");
	await writeFile(clientPath, CLIENT_SOURCE, { mode: 0o600 });

	const token = randomBytes(16).toString("hex");
	const target = platform === "win32" ? `\\\\.\\pipe\\pideck-askpass-${token}` : join(directory, `askpass-${token}.sock`);
	const launcherPath = join(directory, platform === "win32" ? "askpass.cmd" : "askpass.sh");
	await writeFile(launcherPath, platform === "win32" ? windowsLauncher(options.executable, clientPath, target) : posixLauncher(options.executable, clientPath, target), { mode: 0o700 });
	if (platform !== "win32") await chmod(launcherPath, 0o700);

	let answered = 0;
	let refused = 0;
	let closed = false;
	const server: Server = createServer((socket) => {
		let prompt = "";
		let released = false;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			// The helper writes the prompt once and then waits; ignore anything beyond the first line.
			if (released) return;
			prompt += chunk;
			const newline = prompt.indexOf("\n");
			if (newline === -1) return;
			released = true;
			const line = prompt.slice(0, newline).replace(/\r$/, "");
			if (!isPasswordPrompt(line)) {
				refused += 1;
				// No bytes: the helper exits non-zero and ssh aborts this authentication method.
				socket.end();
				return;
			}
			answered += 1;
			socket.end(options.secret + "\n");
		});
		socket.on("error", () => {
			// A helper that dies before asking (missing runtime, blocked policy) must not crash main.
			if (!released) refused += 1;
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(target, () => {
			server.off("error", reject);
			resolve();
		});
	});

	return {
		env: Object.freeze({ SSH_ASKPASS: launcherPath, SSH_ASKPASS_REQUIRE: "force" }),
		answered: () => answered,
		refused: () => refused,
		async dispose() {
			if (closed) return;
			closed = true;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
		},
	};
}
