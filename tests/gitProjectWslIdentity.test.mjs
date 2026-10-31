import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { win32 } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const ROOT = "\\\\wsl.localhost\\Debian\\home\\shared\\repo";
const EXE = "C:\\Windows\\System32\\wsl.exe";
const HOST_GIT = "C:\\Git\\git.exe";

/** Exercise the production IPC, repository boundary, Git services, and spawn planner with simulated Windows paths. */
function fixture({ canonicalize = (path) => path } = {}) {
	const handlers = new Map();
	const calls = [];
	const projects = new Map([
		["alice", { id: "alice", path: ROOT, environment: "wsl", wslDistro: "Debian", wslUser: "alice" }],
		["bob", { id: "bob", path: ROOT, environment: "wsl", wslDistro: "Debian", wslUser: "bob" }],
		["legacy", { id: "legacy", path: ROOT, environment: "wsl", wslDistro: "Debian" }],
		["native-unc", { id: "native-unc", path: ROOT, environment: "windows" }],
		["drive", { id: "drive", path: "C:\\repo", environment: "wsl", wslDistro: "Debian", wslUser: "bob" }],
	]);
	const simulatedProcess = Object.create(process, { platform: { value: "win32" } });
	const fs = {
		realpath: async (path) => {
			await new Promise((resolve) => setImmediate(resolve));
			return canonicalize(path);
		},
		stat: async () => ({ isDirectory: () => true }),
	};
	const spawn = (command, args, options) => {
		calls.push({ command, args: Array.from(args), cwd: options.cwd });
		const child = new EventEmitter();
		child.pid = 999;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = new EventEmitter();
		child.stdin.write = () => {};
		child.stdin.end = () => {};
		let stdout = "";
		if (args.includes("--show-toplevel")) stdout = "/home/shared/repo\n";
		else if (args.includes("--git-common-dir")) stdout = "/home/shared/repo/.git\n";
		else if (args.includes("--porcelain") && args.includes("worktree")) stdout = "worktree /home/shared/repo\nbranch refs/heads/main\n\n";
		else if (args.includes("--show-current") || args.includes("--format=%(refname:short)")) stdout = "main\n";
		else if (args.includes("show")) stdout = "original\n";
		process.nextTick(() => {
			if (stdout) child.stdout.emit("data", Buffer.from(stdout));
			child.emit("close", 0);
		});
		return child;
	};
	const { registerGitIpc, registerProjectsIpc, GitService, WorktreeService } = loadTsCommonJs("tests/helpers/gitIpcWslHarness.ts", {
		globals: { process: simulatedProcess },
		stubs: {
			"node:path": win32,
			"node:fs/promises": fs,
			"node:child_process": {
				spawn,
				execFile: () => {
					throw new Error("unexpected execFile");
				},
			},
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, dialog: {}, app: { getPath: () => "C:\\temp" } },
			"./gitExecutable.ts": { currentGitExecutable: () => HOST_GIT },
			"../wsl/wslExe.ts": { getWslExe: () => ({ command: EXE }), decodeWslOutput: (raw) => raw.toString("utf8") },
		},
	});
	const projectStore = {
		get: (id) => projects.get(id),
		toggleWorktreeEnabled: async (id) => {
			const project = projects.get(id);
			project.worktreeEnabled = !project.worktreeEnabled;
			return project;
		},
	};
	const settingsStore = { get: () => ({ wslDistro: "Debian", wslUser: "legacy-user", maxEditorFileSizeMB: 5 }) };
	const gitService = new GitService();
	const worktreeService = new WorktreeService();
	registerGitIpc({
		appLogger: { warn: async () => {}, info: async () => {}, error: async () => {} },
		mainCopy: (key) => key,
		gitService,
		gitRefsWatcher: { on: () => {} },
		getMainWindow: () => null,
		piLocator: {},
		projectStore,
		settingsStore,
		worktreeService,
	});
	registerProjectsIpc({ projectStore, settingsStore, gitService, worktreeService });
	return { calls, projects, invoke: (name, ...args) => handlers.get(ipcChannels[name])({}, ...args) };
}

function assertWslUser(call, user) {
	assert.equal(call.command, EXE);
	assert.deepEqual(call.args.slice(0, 4), ["-d", "Debian", "-u", user]);
}

test("parallel Git commits use each WSL project's user even for the same repository", async () => {
	const f = fixture();
	await Promise.all([f.invoke("gitCommit", "alice", "alice commit"), f.invoke("gitCommit", "bob", "bob commit")]);
	assert.equal(f.calls.length, 2);
	assertWslUser(
		f.calls.find((call) => call.args.includes("alice commit")),
		"alice",
	);
	assertWslUser(
		f.calls.find((call) => call.args.includes("bob commit")),
		"bob",
	);
});

test("parallel projects from different distributions keep their own distribution and user", async () => {
	const f = fixture();
	f.projects.set("carol", { id: "carol", path: "\\\\wsl.localhost\\Ubuntu\\home\\shared\\repo", environment: "wsl", wslDistro: "Ubuntu", wslUser: "carol" });
	await Promise.all([f.invoke("gitCommit", "bob", "bob commit"), f.invoke("gitCommit", "carol", "carol commit")]);
	const bob = f.calls.find((call) => call.args.includes("bob commit"));
	const carol = f.calls.find((call) => call.args.includes("carol commit"));
	assertWslUser(bob, "bob");
	assert.equal(carol.command, EXE);
	assert.deepEqual(carol.args.slice(0, 4), ["-d", "Ubuntu", "-u", "carol"]);
});

test("Git reads, original content, and worktree listing use the WSL project user", async () => {
	const f = fixture();
	await f.invoke("gitBranches", "bob");
	await f.invoke("gitStatus", "bob");
	await f.invoke("gitPush", "bob");
	assert.equal(await f.invoke("gitOriginalContent", { projectId: "bob", relativePath: "file.txt" }), "original\n");
	await f.invoke("gitWorktreeList", "bob");
	assert.ok(f.calls.length >= 6);
	for (const call of f.calls) assertWslUser(call, "bob");
});

test("enabling worktree mode checks and lists repositories as the project user", async () => {
	const f = fixture();
	await f.invoke("projectsToggleWorktreeEnabled", "bob");
	assert.ok(f.calls.length >= 3);
	for (const call of f.calls) assertWslUser(call, "bob");
});

test("legacy WSL projects inherit the configured global user", async () => {
	const f = fixture();
	await f.invoke("gitCommit", "legacy", "legacy commit");
	assertWslUser(f.calls[0], "legacy-user");
});

test("an invalid or missing project user never launches Git as the default WSL user", async () => {
	const f = fixture();
	for (const user of ["", "-e", "bad user"]) {
		f.projects.get("bob").wslUser = user;
		await assert.rejects(f.invoke("gitCommit", "bob", "message"), /INVALID_WSL_GIT_IDENTITY/);
	}
	assert.equal(f.calls.length, 0);
});

test("a WSL Git plan rejects a different distro before spawning", () => {
	const { planGitSpawn } = loadTsCommonJs("src/main/git/gitWsl.ts");
	assert.throws(() => planGitSpawn(["status"], { cwd: ROOT, platform: "win32", wslIdentity: { distro: "Ubuntu", user: "bob" } }), /WSL_DISTRO_MISMATCH/);
});

test("a canonicalized repository in a different distribution is rejected before spawning", async () => {
	const f = fixture({ canonicalize: (path) => path.replace("\\\\wsl.localhost\\Debian\\", "\\\\wsl.localhost\\Ubuntu\\") });
	await assert.rejects(f.invoke("gitCommit", "bob", "message"), /WSL_DISTRO_MISMATCH/);
	assert.equal(f.calls.length, 0);
});

test("drive-backed WSL projects keep host Git, and native WSL UNC projects keep the default WSL user", async () => {
	const f = fixture();
	await Promise.all([f.invoke("gitCommit", "drive", "drive commit"), f.invoke("gitCommit", "native-unc", "native commit")]);
	const drive = f.calls.find((call) => call.args.includes("drive commit"));
	const native = f.calls.find((call) => call.args.includes("native commit"));
	assert.equal(drive.command, HOST_GIT);
	assert.deepEqual(drive.args, ["commit", "-m", "drive commit"]);
	assert.equal(native.command, EXE);
	assert.deepEqual(native.args.slice(0, 3), ["-d", "Debian", "-e"]);
});
