import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { LocalTerminalSessionLauncher } = loadTsCommonJs("src/main/terminal/TerminalSessionLauncher.ts");
const manager = readFileSync("src/main/terminal/TerminalSessionManager.ts", "utf8");
const gitIpc = readFileSync("src/main/ipc/gitIpc.ts", "utf8");

test("project terminal candidate uses the explicit WSL profile", { skip: process.platform !== "win32" }, () => {
	const launcher = new LocalTerminalSessionLauncher(() => ({ wslEnabled: false }));
	const candidates = launcher.candidates({ wslEnabled: true, wslDistro: "Ubuntu-Test", wslUser: "tester" });
	const wsl = candidates.find((candidate) => candidate.shell === "wsl");
	assert.ok(wsl);
	assert.equal(JSON.stringify(wsl.args.slice(0, 4)), JSON.stringify(["-d", "Ubuntu-Test", "-u", "tester"]));
});

test("terminal manager passes the project profile into spawn", () => {
	assert.match(manager, /private wslSettingsFor\(target: TerminalTarget\): TerminalWslSettings \| undefined/);
	assert.match(manager, /const distro = project\.wslDistro \?\? fallback\.wslDistro;/);
	assert.match(manager, /const spawned = this\.launcher\.spawn\(\{ cwd: resolvedCwd, preferredShell: shell \}, wslSettings\);/);
});

test("git host paths prefer the project's distro", () => {
	assert.match(gitIpc, /const distro = project\?\.environment === "wsl" \? \(project\.wslDistro \?\? settings\.wslDistro\) : settings\.wslDistro;/);
	assert.match(gitIpc, /const projectHostPath = \(project: LocalProject\) => hostPath\(project\.path, project\);/);
	assert.match(gitIpc, /const distro = project\.wslDistro \?\? settings\.wslDistro;/);
});
