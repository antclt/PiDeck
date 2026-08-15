import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);
const { agentPresetsRow, shippedPresetRoot } = loadTsCommonJs("src/main/dsh/dshPresetComposition.ts");

/** 真实安装的 dsh 包目录（与 hostEntry 运行时解析同一来源）。 */
const dshPackageDir = dirname(nodeRequire.resolve("@deepseek-ai/dsh/package.json"));

test("agentPresetsRow: 默认 standard + 随包 system 根（对齐 dsh-web 部署形态）", () => {
	const row = agentPresetsRow(dshPackageDir);
	assert.equal(row.id, "agent-presets");
	assert.equal(row.name, "@deepseek-ai/dsh-agent-presets");
	assert.equal(row.config.default, "standard");
	assert.equal(row.config.roots.length, 1);
	assert.equal(row.config.roots[0].path, shippedPresetRoot(dshPackageDir));
	assert.equal(row.config.roots[0].trust, "system");
});

test("shippedPresetRoot: 指向 <dsh 包>/config/agent-presets", () => {
	assert.equal(shippedPresetRoot(dshPackageDir), join(dshPackageDir, "config", "agent-presets"));
});

test("随包预设根真实存在且含 dsh-web 的 4 种模式", () => {
	const root = shippedPresetRoot(dshPackageDir);
	assert.ok(existsSync(root), `随包预设根缺失: ${root}`);
	const dirs = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	assert.deepEqual(dirs, ["code", "cordis", "minimal", "standard"]);
	// 每个模式目录必须带组合文件与显示元数据（缺一就不是可用的预设槽位）
	for (const id of dirs) {
		const composition = join(root, id, "agent.cordis.yml");
		const metadata = join(root, id, "preset.yml");
		assert.ok(statSync(composition).isFile(), `${id} 缺 agent.cordis.yml`);
		assert.ok(statSync(metadata).isFile(), `${id} 缺 preset.yml`);
	}
});
