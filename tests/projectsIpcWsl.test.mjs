import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");

test("projects:add only creates native projects; WSL goes through the profile entry", () => {
	// 第 14 步：普通「添加项目」不再读取旧全局 WSL 模式；WSL 项目必须显式选择连接档案。
	assert.match(source, /projectStore\.chooseAndAdd\("windows"\)/);
	assert.doesNotMatch(source, /chooseAndAdd\(env, wslEnvironment\)/);
});
