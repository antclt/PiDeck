import assert from "node:assert/strict";
import test from "node:test";
import { patchSharpIndexCjs } from "../scripts/patch-sharp-index.js";

// 回归测试：sharp 原生绑定在打包环境（asar 虚拟路径）加载失败问题。
// 见 scripts/patch-sharp-index.js 头注释（libvips DLL 不跟随 Electron 的 %TEMP% 解包）。

test("patchSharpIndexCjs 把相对 require 改为 resourcesPath 真实路径加载", () => {
	const input = "module.exports = require('./lib/sharp-win32-x64-0.35.3.node');";
	const patched = patchSharpIndexCjs(input);
	assert.match(patched, /process\.resourcesPath/);
	assert.match(patched, /'app\.asar\.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'sharp-win32-x64-0\.35\.3\.node'/);
	assert.ok(!patched.includes("require('./lib/"));
});

test("patchSharpIndexCjs 幂等：已打过补丁的内容不再变换", () => {
	const once = patchSharpIndexCjs("module.exports = require('./lib/sharp-win32-x64-0.35.3.node');");
	assert.equal(patchSharpIndexCjs(once), once);
});

test("patchSharpIndexCjs 对无法识别的格式抛错（防止 sharp 升级后补丁静默失效）", () => {
	assert.throws(() => patchSharpIndexCjs("module.exports = require('./lib/other.js');"), /格式不符/);
	assert.throws(() => patchSharpIndexCjs("module.exports = somethingElse;"), /格式不符/);
});
