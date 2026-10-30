/**
 * 发布流水线的「构建来源」标记守卫（2026-10 build-origin）。
 *
 * 背景：`__PIDECK_RELEASE_BUILD__` 是编译期 define（electron.vite.config.ts），只有 CI 发布
 * 步骤注入 `PIDECK_RELEASE_BUILD=1` 时构建来源才是 release（见 src/main/buildIdentity.ts）。
 * 漏标不会报错，只会让发布出来的包在设置页显示「本地构建」，属于「只有用户能看见」的回归。
 *
 * 这里断言的是 CI 接线（workflow 的 env）而不是运行时行为——这类配置无法在单测里真跑一遍
 * 打包流水线，只能按「会往 GitHub Release 追加资产的 workflow 必须带标记」这个语义判据守住：
 * 判据按内容（是否用 softprops/action-gh-release 发布）而不是文件名，新增发布 workflow 也覆盖。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const WORKFLOW_DIR = fileURLToPath(new URL("../.github/workflows", import.meta.url));
const PUBLISH_MARKER = "softprops/action-gh-release";
/** 标记必须写成 env 行（行首非 #），注释里提到不算。 */
const RELEASE_ENV_LINE = /^[\t ]*PIDECK_RELEASE_BUILD:[\t ]*["']1["'][\t ]*$/m;

const workflowFiles = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name));

test("所有会发布 Release 的 workflow 都注入 PIDECK_RELEASE_BUILD=1", () => {
	const publishing = workflowFiles.filter((name) => readFileSync(join(WORKFLOW_DIR, name), "utf8").includes(PUBLISH_MARKER));
	// 扫描本身要有效：至少得认出 release.yml（发布主入口），否则下面的循环会空转成假绿。
	assert.ok(publishing.includes("release.yml"), `未识别到 release.yml，实际扫描：${publishing.join(", ") || "（空）"}`);
	for (const name of publishing) {
		const source = readFileSync(join(WORKFLOW_DIR, name), "utf8");
		assert.match(source, RELEASE_ENV_LINE, `${name} 是发布 workflow，其构建步骤必须注入 PIDECK_RELEASE_BUILD: "1"，否则产物会显示「本地构建」`);
	}
});

test("本地打包脚本不注入发布标记（本地构建不得自称发布版）", () => {
	for (const file of ["scripts/pack-dev.js", "scripts/dist-dev.js", "scripts/dist-fast.js", "scripts/dist-win.js"]) {
		const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
		assert.doesNotMatch(source, /PIDECK_RELEASE_BUILD/, `${file} 不是发布流水线，不得注入该标记（缺省 local 才是安全方向）`);
	}
});
