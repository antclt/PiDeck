import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { startDshHostInBackground } = loadTsCommonJs("src/main/dsh/startDshHostInBackground.ts");
const main = readFileSync("src/main/index.ts", "utf8");
const configTab = readFileSync("src/renderer/src/config/DshConfigTab.tsx", "utf8");

test("startDshHostInBackground starts immediately without awaiting host readiness", async () => {
	let resolveStart;
	let started = false;
	const startup = new Promise((resolve) => {
		resolveStart = resolve;
	});
	const warnings = [];

	const result = startDshHostInBackground(
		{
			ensureStarted() {
				started = true;
				return startup;
			},
		},
		{ warn: (...args) => warnings.push(args) },
	);

	assert.equal(result, undefined, "启动入口不能等待 host boot");
	assert.equal(started, true, "调用后应立即开始 boot");
	assert.equal(warnings.length, 0);
	resolveStart();
	await startup;
});

test("startup integration warms DSH after the main window and Overview exposes host restart", () => {
	assert.match(main, /await createWindow\(\);[\s\S]{0,120}startDshHostInBackground\(dshHost, appLogger\)/);
	assert.match(configTab, /const restartHost = async \(\) =>/);
	assert.match(configTab, /desktopApi\.sessions\.restartDshHost\(\)/);
	assert.match(configTab, /t\("config\.dsh\.restartHost"\)/);
});

test("startDshHostInBackground logs failures without surfacing an unhandled rejection", async () => {
	const warnings = [];
	startDshHostInBackground(
		{ ensureStarted: async () => { throw new Error("host boot failed"); } },
		{ warn: (...args) => warnings.push(args) },
	);

	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0]?.[0], "dsh-host");
	assert.equal(warnings[0]?.[1], "Background DSH host startup failed");
	assert.equal(warnings[0]?.[2]?.error, "Error: host boot failed");
});
