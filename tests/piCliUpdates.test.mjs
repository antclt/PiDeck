import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/** Exercise the real update/exec path without launching pi or accessing the network. */
function makeManager({ version = "0.80.0", installedVersion = "1.0.0", latestVersion = "1.0.0", executionError, stdout = "updated", stderr = "", checkError } = {}) {
	const commands = [];
	const probes = [];
	const logs = [];
	let invalidations = 0;
	let settings = { customPiPath: "/fixture/pi", wslEnabled: false };
	const originalSettings = settings;
	const load = createTsSandbox({
		stubs: {
			"node:child_process": {
				execFile: (command, args, options, callback) => {
					commands.push({ command, args: Array.from(args), options });
					queueMicrotask(() => callback(executionError ?? null, stdout, stderr));
				},
			},
			"../pi/PiProcess": { PiProcess: { invalidateVersionCache: () => invalidations++ } },
			"../fs/trash": { trashPath: async () => {} },
			"../logging/sharedLogger": { getAppLogger: () => ({ error: (...args) => logs.push(args) }) },
		},
		globals: {
			fetch: async () => {
				if (checkError) throw checkError;
				return { ok: true, json: async () => ({ version: latestVersion }) };
			},
		},
	});
	const { ExtensionManager } = load("src/main/extensions/ExtensionManager.ts");
	const locator = {
		check: async (...args) => {
			probes.push(args);
			return { installed: true, version: commands.length ? installedVersion : version };
		},
		resolveCommand: (path) => path,
		createInvocation: (command, args) => ({ command: "node", args: [command, ...args], shell: false }),
		createProcessEnv: (snapshot) => ({ PI_OFFLINE: "1", CUSTOM_PI_PATH: snapshot.customPiPath }),
		warmWslCommand: async () => {},
	};
	const translate = (key, params = {}) => `${key} ${Object.values(params).join(" ")}`.trim();
	const manager = new ExtensionManager(locator, () => settings, undefined, undefined, translate);
	return { manager, commands, probes, logs, originalSettings, changeSettings: (next) => (settings = next), invalidations: () => invalidations };
}

for (const version of ["0.70.3", "0.80.0", "1.0.0"]) {
	test(`pi ${version} self-update uses --self and verifies the selected installation`, async () => {
		const fixture = makeManager({ version, installedVersion: "1.0.1", latestVersion: "1.0.1", stderr: "package-manager notice" });
		fixture.manager.piVersion = "0.60.0";
		const result = await fixture.manager.updatePi();
		assert.equal(result.updated, true);
		assert.ok(fixture.commands[0].args.includes("--self"));
		assert.ok(!fixture.commands[0].args.includes("pi"), "pi is not an extension source or legacy self-update target");
		assert.equal(fixture.commands[0].args.includes("--no-approve"), version !== "0.70.3", "use the fresh probe, not a stale version cache");
		assert.equal(fixture.commands[0].options.env.PI_OFFLINE, undefined, "online updates must override an inherited offline flag");
		assert.equal(fixture.commands[0].options.shell, false);
		assert.match(result.output, /package-manager notice/);
		assert.equal(fixture.probes.length, 2, "probe again after the command exits");
		assert.equal(fixture.invalidations(), 1);
	});
}

for (const version of ["0.70.2", "0.70.3-beta.1", undefined]) {
	test(`unsupported pi version ${version ?? "unknown"} offers manual upgrade instead of guessing a package-manager command`, async () => {
		const fixture = makeManager({ version: version ?? "" });
		await assert.rejects(fixture.manager.updatePi(), /mainExtension\.piSelfUpdateUnsupported.*0\.70\.3/);
		assert.equal(fixture.commands.length, 0);
	});
}

test("a failed release check is an error, not a successful no-update result", async () => {
	const fixture = makeManager({ checkError: new Error("connection unavailable") });
	await assert.rejects(fixture.manager.updatePi(), /mainExtension\.updateCheckFailed/);
	assert.equal(fixture.commands.length, 0);
});

test("zero exit status does not count as a self-update when the selected pi remains outdated", async () => {
	const fixture = makeManager({ installedVersion: "0.80.0" });
	await assert.rejects(fixture.manager.updatePi(), /mainExtension\.piUpdateNotApplied.*0\.80\.0.*1\.0\.0/);
	assert.equal(fixture.invalidations(), 1, "invalidate stale caches even when verification fails");
});

test("self-update uses one settings snapshot for checking, execution and verification", async () => {
	const fixture = makeManager();
	const fetchVersion = fixture.manager.fetchPiLatestVersion.bind(fixture.manager);
	fixture.manager.fetchPiLatestVersion = async (...args) => {
		fixture.changeSettings({ customPiPath: "/other/pi", wslEnabled: false });
		return fetchVersion(...args);
	};
	await fixture.manager.updatePi();
	assert.equal(fixture.commands[0].args[0], "/fixture/pi");
	assert.equal(fixture.commands[0].options.env.CUSTOM_PI_PATH, "/fixture/pi");
	assert.ok(fixture.probes.every((args) => args[0] === "/fixture/pi"));
});

for (const [version, expected] of [
	["0.70.2", ["update"]],
	["0.70.3", ["update", "--extensions"]],
	["1.0.0", ["update", "--extensions", "--no-approve"]],
]) {
	test(`pi ${version} updates extensions without unsupported flags or updating pi itself`, async () => {
		const fixture = makeManager({ version });
		await fixture.manager.updateExtensions();
		assert.deepEqual(fixture.commands[0].args.slice(1), expected);
	});
}

test("extension update failures preserve bounded, credential-free diagnostics in the UI and app log", async () => {
	const fixture = makeManager({
		executionError: Object.assign(new Error("process terminated"), { killed: true, signal: "SIGTERM" }),
		stdout: "Update with the package manager that owns this installation.",
		stderr: "\u001b[31mEACCES /home/fixture-user/npm token=fixture-sensitive-token https://fixture:fixture-password@example.invalid/pkg\u001b[0m",
	});
	await assert.rejects(fixture.manager.updateExtension("npm:fixture-extension"), (error) => {
		assert.match(error.message, /mainExtension\.commandTimedOut/);
		assert.match(error.message, /EACCES/);
		assert.match(error.message, /package manager/);
		assert.ok(error.message.length < 4500);
		for (const secret of ["fixture-sensitive-token", "fixture-password", "fixture-user", "\u001b["]) assert.ok(!error.message.includes(secret));
		return true;
	});
	assert.equal(fixture.logs.length, 1);
	const logged = JSON.stringify(fixture.logs);
	assert.match(logged, /EACCES/);
	assert.ok(!logged.includes("fixture-sensitive-token"));
	assert.ok(!logged.includes("fixture-password"));
});
