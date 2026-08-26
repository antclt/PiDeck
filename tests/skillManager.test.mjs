import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	mkdtemp,
	mkdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

class SymlinkUnavailableError extends Error {}

function loadSkillManagerModule() {
	const source = readFileSync("src/main/skills/SkillManager.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "electron")
				return {
					shell: { openPath: async () => "" },
					// installUsageProbeTemplate 需要 app：dev 模式读 <appPath>/resources/skills/usage-probe/SKILL.md。
					// 测试跑在项目根，该模板真实存在，用 cwd 作为 appPath 即可测通「读模板→写目标」链路。
					app: { isPackaged: false, getAppPath: () => process.cwd() },
				};
			// 删除统一入口：测试环境无回收站，noop stub（本测试不触达删除路径）
			if (id === "../fs/trash") return { trashPath: async () => {} };
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			return require(id);
		},
	};
	sandbox.global = sandbox;
	vm.runInNewContext(outputText, sandbox, {
		filename: "SkillManager.ts",
	});
	return sandbox.exports;
}

async function createSkillFile(path, name, description = `${name} description`) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
		"utf8",
	);
}

async function createSkillRoot(home) {
	const globalSkills = join(home, ".pi", "agent", "skills");
	await mkdir(globalSkills, { recursive: true });
	return globalSkills;
}

async function createDirectoryLink(target, linkPath) {
	try {
		await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if (["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) {
			throw new SymlinkUnavailableError(error.message);
		}
		throw error;
	}
}

async function createFileLink(target, linkPath) {
	try {
		await symlink(target, linkPath, "file");
	} catch (error) {
		if (["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) {
			throw new SymlinkUnavailableError(error.message);
		}
		throw error;
	}
}

async function withTemporaryHome(run) {
	const home = await mkdtemp(join(tmpdir(), "pideck-skill-manager-"));
	try {
		await run(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

function skipUnavailable(t, error) {
	if (error instanceof SymlinkUnavailableError) {
		t.skip(`软连接不可用：${error.message}`);
		return true;
	}
	return false;
}

test("discovers a directory skill through a root-level symlink", async (t) => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const target = join(home, "linked", "directory-skill");
		const link = join(globalSkills, "directory-skill");
		await createSkillFile(join(target, "SKILL.md"), "directory-skill");

		try {
			await createDirectoryLink(target, link);
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const { SkillManager } = loadSkillManagerModule();
		const result = await new SkillManager(home).list();
		const skill = result.skills.find((item) => item.path === join(link, "SKILL.md"));
		assert.ok(skill);
		assert.equal(skill.type, "directory");
		assert.equal(skill.name, "directory-skill");
	});
});

test("discovers a root markdown skill through a file symlink", async (t) => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const target = join(home, "linked", "root-skill.md");
		const link = join(globalSkills, "root-skill.md");
		await createSkillFile(target, "root-skill");

		try {
			await createFileLink(target, link);
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const { SkillManager } = loadSkillManagerModule();
		const result = await new SkillManager(home).list();
		const skill = result.skills.find((item) => item.path === link);
		assert.ok(skill);
		assert.equal(skill.type, "markdown");
		assert.equal(skill.name, "root-skill");
	});
});

test("discovers a nested skill through a directory symlink", async (t) => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const parent = join(globalSkills, "collection");
		const target = join(home, "linked", "nested-skill");
		const link = join(parent, "nested-skill");
		await mkdir(parent, { recursive: true });
		await createSkillFile(join(target, "SKILL.md"), "nested-skill");

		try {
			await createDirectoryLink(target, link);
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const { SkillManager } = loadSkillManagerModule();
		const result = await new SkillManager(home).list();
		const skill = result.skills.find((item) => item.path === join(link, "SKILL.md"));
		assert.ok(skill);
		assert.equal(skill.name, "nested-skill");
	});
});

test("does not recurse forever through a directory symlink cycle", async () => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const cycleRoot = join(globalSkills, "cycle");
		await createSkillFile(join(cycleRoot, "visible", "SKILL.md"), "visible-skill");
		try {
			await createDirectoryLink(cycleRoot, join(cycleRoot, "loop"));
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const { SkillManager } = loadSkillManagerModule();
		const result = await Promise.race([
			new SkillManager(home).list(),
			new Promise((_, reject) => setTimeout(() => reject(new Error("scan timed out")), 1000)),
		]);
		assert.ok(result.skills.some((item) => item.name === "visible-skill"));
	});
});

test("installUsageProbeTemplate copies the bundled template into the global skills dir", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		const result = await manager.installUsageProbeTemplate();
		assert.equal(result.success, true);
		const target = join(home, ".pi", "agent", "skills", "usage-probe", "SKILL.md");
		const written = readFileSync(target, "utf8");
		assert.match(written, /name: usage-probe/);
		assert.match(written, /usage-probes\.json/);
		// 幂等覆盖：重复安装不报错、内容一致（用户自定义配置在 usage-probes.json，不在此模板文件）
		const again = await manager.installUsageProbeTemplate();
		assert.equal(again.success, true);
		assert.equal(readFileSync(target, "utf8"), written);
	});
});
