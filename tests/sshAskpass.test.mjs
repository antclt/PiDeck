import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createSshAskpassBridge, isPasswordPrompt } = loadTsCommonJs("src/main/remote/SshAskpass.ts");

const isWindows = process.platform === "win32";

/** Run the generated program the way ssh would: one argv element carrying the prompt. */
function runLauncher(launcher, prompt) {
	return new Promise((resolve) => {
		const child = isWindows ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", launcher, prompt], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) : spawn(launcher, [prompt], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill(), 30_000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

test("only ssh's own password prompt is answered", () => {
	for (const prompt of ["alice@host's password: ", "Password:", "password：", "alice@10.0.0.1's password:  ", "(alice@host) Password: "]) assert.equal(isPasswordPrompt(prompt), true, prompt);
	// Keyboard-interactive/MFA challenges must never receive the password.
	for (const prompt of ["Verification code: ", "Enter passcode: ", "password", "", "a".repeat(2048), "pass\nword: "]) assert.equal(isPasswordPrompt(prompt), false, JSON.stringify(prompt));
});

test("the bridge releases the secret for a password prompt and the secret never reaches disk", { skip: !isWindows }, async (t) => {
	const secret = "probe-secret-9f3a";
	const bridge = await createSshAskpassBridge({ secret, executable: process.execPath });
	t.after(() => bridge.dispose());
	const launcher = bridge.env.SSH_ASKPASS;
	assert.equal(bridge.env.SSH_ASKPASS_REQUIRE, "force");
	// The generated program carries only the socket path; the secret is not in it.
	const { readFileSync } = await import("node:fs");
	assert.equal(readFileSync(launcher, "utf8").includes(secret), false);

	const answered = await runLauncher(launcher, "alice@example.invalid's password: ");
	assert.equal(answered.code, 0, answered.stderr);
	assert.equal(answered.stdout.trim(), secret);
	assert.equal(bridge.answered(), 1);
});

test("a challenge that is not a password prompt gets no answer", { skip: !isWindows }, async (t) => {
	const bridge = await createSshAskpassBridge({ secret: "probe-secret-9f3a", executable: process.execPath });
	t.after(() => bridge.dispose());
	const refused = await runLauncher(bridge.env.SSH_ASKPASS, "Verification code: ");
	assert.notEqual(refused.code, 0, "the helper must fail so ssh aborts the method");
	assert.equal(refused.stdout, "");
	assert.equal(bridge.refused(), 1);
	assert.equal(bridge.answered(), 0);
});

test("dispose removes the generated program and stops listening", { skip: !isWindows }, async () => {
	const bridge = await createSshAskpassBridge({ secret: "probe-secret-9f3a", executable: process.execPath });
	const launcher = bridge.env.SSH_ASKPASS;
	assert.equal(existsSync(launcher), true);
	await bridge.dispose();
	assert.equal(existsSync(launcher), false);
	assert.equal(existsSync(dirname(launcher)), false);
	// A second dispose is a no-op rather than an error.
	await bridge.dispose();
});
