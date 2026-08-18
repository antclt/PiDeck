import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const afterPack = require("../scripts/after-pack-cleanup.js");
const afterPackCleanup = afterPack.default;

function isUnpackedInHeader(archive, relativePath) {
	const parts = relativePath.replaceAll("\\", "/").replace(/^\//, "").split("/");
	let node = asar.getRawHeader(archive).header;
	for (const part of parts) {
		node = node?.files?.[part];
		if (!node) return false;
	}
	return node.unpacked === true;
}

async function put(path, content) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

function normalizedEntries(archive) {
	return asar.listPackage(archive).map((entry) => entry.replaceAll("\\", "/").replace(/^\//, ""));
}

test("afterPack cleanup preserves the Lark SDK package main entry", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "pideck-after-pack-"));
	try {
		const sourceDir = join(appOutDir, "fixture");
		const archive = join(appOutDir, "resources", "app.asar");
		const packageDir = join(sourceDir, "node_modules", "@larksuiteoapi", "node-sdk");

		await put(join(packageDir, "package.json"), JSON.stringify({ main: "./lib/index.js" }));
		await put(join(packageDir, "lib", "index.js"), "module.exports = {};\n");
		await put(join(packageDir, "es", "index.js"), "export {};\n");
		await put(join(packageDir, "README.md"), "fixture documentation\n");
		await mkdir(dirname(archive), { recursive: true });
		await asar.createPackage(sourceDir, archive);

		await afterPackCleanup({ appOutDir });

		const entries = normalizedEntries(archive);
		assert.ok(
			entries.includes("node_modules/@larksuiteoapi/node-sdk/lib/index.js"),
			"the package.json main entry must remain in the final asar",
		);
		assert.equal(
			entries.includes("node_modules/@larksuiteoapi/node-sdk/README.md"),
			false,
			"the fixture must exercise an asar repack through normal documentation cleanup",
		);
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

test("package.json unpacks node-pty so packaged terminal can load pty.node", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const unpack = pkg.build?.asarUnpack ?? [];
	assert.ok(
		unpack.includes("node_modules/node-pty/**"),
		"asarUnpack must list node-pty; otherwise terminal:ensure fails in the installed app (#154)",
	);
	assert.ok(
		unpack.includes("node_modules/@deepseek-ai/dsh-subprocess-local/node_modules/node-pty/**"),
		"asarUnpack must list the nested DSH node-pty 1.2 prebuild used by dsh-subprocess-local",
	);
});

test("afterPack cleanup keeps node-pty unpacked after asar repack", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "pideck-after-pack-pty-"));
	try {
		const sourceDir = join(appOutDir, "fixture");
		const archive = join(appOutDir, "resources", "app.asar");
		const ptyDir = join(sourceDir, "node_modules", "node-pty");
		await put(join(ptyDir, "lib", "utils.js"), "module.exports = {};\n");
		await put(join(ptyDir, "prebuilds", "win32-x64", "pty.node"), "NATIVE");
		await put(join(ptyDir, "README.md"), "fixture documentation that forces a repack\n");
		await mkdir(dirname(archive), { recursive: true });
		await asar.createPackageWithOptions(sourceDir, archive, { unpack: "**/*.node" });

		assert.equal(
			isUnpackedInHeader(archive, "node_modules/node-pty/prebuilds/win32-x64/pty.node"),
			true,
			"fixture must start with an unpacked pty.node so the test exercises the regression",
		);

		await afterPackCleanup({ appOutDir });

		assert.equal(
			isUnpackedInHeader(archive, "node_modules/node-pty/prebuilds/win32-x64/pty.node"),
			true,
			"repacking asar must keep pty.node unpacked so Electron maps require() to app.asar.unpacked",
		);
		assert.equal(
			normalizedEntries(archive).includes("node_modules/node-pty/README.md"),
			false,
			"the fixture must still exercise an asar repack through documentation cleanup",
		);
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});
