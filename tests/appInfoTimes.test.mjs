/**
 * resolveAppTimes：打包/安装时间戳解析（「关于」面板数据源）。
 *
 * 覆盖：文件 mtime 读取、丢失文件容错、打包态（app.asar + exe）、开发态（仅 package.json）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveAppTimes } = loadTsCommonJs("src/main/utils/appInfoTimes.ts");

let tmp;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pideck-appinfo-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

test("打包态返回 app.asar 构建时间与 execPath 安装时间", () => {
	const resources = join(tmp, "resources");
	const exec = join(tmp, "pideck.exe");
	mkdirSync(resources, { recursive: true });
	writeFileSync(join(resources, "app.asar"), "asar", "utf8");
	writeFileSync(exec, "exe", "utf8");

	const result = resolveAppTimes({
		isPackaged: true,
		resourcesPath: resources,
		appPath: join(tmp, "app"),
		execPath: exec,
	});

	assert.ok(result.buildTime, "应有 buildTime");
	assert.ok(result.installedAt, "应有 installedAt");
	assert.doesNotThrow(() => new Date(result.buildTime).toISOString());
	assert.doesNotThrow(() => new Date(result.installedAt).toISOString());
});

test("打包态缺 app.asar / exe 时对应字段缺省，不抛异常", () => {
	const result = resolveAppTimes({
		isPackaged: true,
		resourcesPath: join(tmp, "no-such-resources"),
		appPath: join(tmp, "app"),
		execPath: join(tmp, "no-such.exe"),
	});
	assert.equal(result.buildTime, undefined);
	assert.equal(result.installedAt, undefined);
});

test("开发态只报 package.json 时间，不报安装时间（execPath 是 Electron 壳）", () => {
	const appDir = join(tmp, "dev-app");
	mkdirSync(appDir, { recursive: true });
	writeFileSync(join(appDir, "package.json"), "{}", "utf8");

	const result = resolveAppTimes({
		isPackaged: false,
		resourcesPath: join(tmp, "resources"),
		appPath: appDir,
		execPath: process.execPath,
	});

	assert.ok(result.buildTime, "开发态应有 buildTime");
	assert.equal(result.installedAt, undefined);
});