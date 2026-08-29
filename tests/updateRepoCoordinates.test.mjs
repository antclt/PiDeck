import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, requireOverride) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = requireOverride
		? (specifier) => requireOverride(specifier) ?? nodeRequire(specifier)
		: nodeRequire;
	vm.runInNewContext(output, { module, exports: module.exports, require: localRequire, console, URL: globalThis.URL, process: globalThis.process }, { filename: filePath });
	return module.exports;
}

const appUpdateCheck = compileModule("src/main/update/appUpdateCheck.ts", (specifier) => {
	if (specifier === "./githubFeed") return compileModule("src/main/update/githubFeed.ts");
	return null;
});

// 仓库已由 pi-desktop 更名为 PiDeck：旧坐标目前全靠 GitHub 改名重定向工作，
// 一旦重定向失效（旧名被他人注册/回收），更新检查/资产下载/issue 链接都会 404。
test("update repo coordinates point at the renamed PiDeck repo", () => {
	assert.equal(appUpdateCheck.UPDATE_REPO_OWNER, "ayuayue");
	assert.equal(appUpdateCheck.UPDATE_REPO, "PiDeck");
});

test("update/release URLs must not hardcode the legacy pi-desktop repo", () => {
	// 唯一事实来源是 UPDATE_REPO 常量；装配层与渲染层展示兜底不得再写旧仓库地址
	//（User-Agent 里的 pi-desktop 是应用标识，不是仓库坐标，不在断言范围）。
	const files = [
		"src/main/index.ts",
		"src/main/ipc/systemIpc.ts",
		"src/main/update/UpdateService.ts",
		"src/renderer/src/App.tsx",
		"src/renderer/src/previewApi.ts",
		"src/renderer/src/components/overlays/SessionActionOverlays.tsx",
	];
	for (const file of files) {
		assert.doesNotMatch(
			readFileSync(file, "utf8"),
			/github\.com\/ayuayue\/pi-desktop/,
			`${file} 仍引用旧仓库地址 pi-desktop`,
		);
	}
});
