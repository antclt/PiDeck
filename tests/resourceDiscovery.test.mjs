import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function put(path, content) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

function skillPackage(root, packageRoot, name) {
	put(
		join(packageRoot, "package.json"),
		JSON.stringify({ name, pi: { skills: ["skills/"] } }),
	);
	put(
		join(packageRoot, "skills", name, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`,
	);
}

test("discoverSkills covers packages, explicit settings paths, and ancestor .agents/skills", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-discovery-"));
	try {
		const home = join(root, "home");
		const agentDir = join(home, ".pi", "agent");
		const projectDir = join(root, "project");
		const packageRoot = join(root, "pkg");
		const explicitSkillDir = join(root, "explicit-skills");
		skillPackage(root, packageRoot, "pkg-skill");
		put(
			join(explicitSkillDir, "custom-skill", "SKILL.md"),
			"---\nname: custom-skill\ndescription: custom description\n---\n\n# custom-skill\n",
		);
		// Ancestor .agents/skills (parent of the project cwd).
		put(
			join(root, ".agents", "skills", "ancestor-skill", "SKILL.md"),
			"---\nname: ancestor-skill\ndescription: ancestor description\n---\n\n# ancestor-skill\n",
		);
		put(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [`${packageRoot}`],
				skills: [explicitSkillDir],
			}),
		);
		const { discoverSkills } = loadTsCommonJs("src/main/resourceDiscovery.ts");
		const skills = discoverSkills({
			agentHomeDir: home,
			cwd: projectDir,
			includeProjectResources: true,
			disabledSkillNames: [],
		});
		const names = Array.from(skills
			.filter((skill) => skill.path.startsWith(root))
			.map((skill) => skill.name)
			.sort());
		assert.deepEqual(names, ["ancestor-skill", "custom-skill", "pkg-skill"]);
		const byName = new Map(skills.map((skill) => [skill.name, skill]));
		assert.equal(byName.get("pkg-skill").sourceId, "package-user");
		assert.equal(byName.get("custom-skill").sourceId, "settings-user");
		assert.equal(byName.get("ancestor-skill").sourceId, "ancestor-agents");
		for (const skill of skills) {
			assert.equal(skill.managed, true);
			assert.equal(skill.enabled, true);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverPrompts and discoverExtensions list package and settings sources", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-discovery2-"));
	try {
		const home = join(root, "home");
		const agentDir = join(home, ".pi", "agent");
		const projectDir = join(root, "project");
		const packageRoot = join(root, "pkg");
		put(
			join(packageRoot, "package.json"),
			JSON.stringify({ name: "pkg", pi: { prompts: ["prompts/"], extensions: ["extensions/"] } }),
		);
		put(join(packageRoot, "prompts", "pkg-prompt.md"), "---\ndescription: pkg prompt\n---\n\nbody\n");
		put(join(packageRoot, "extensions", "pkg-ext.ts"), "export default () => {};\n");
		put(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [`${packageRoot}`],
				prompts: [],
				extensions: [],
			}),
		);
		const { discoverPrompts, discoverExtensions } = loadTsCommonJs("src/main/resourceDiscovery.ts");
		const prompts = discoverPrompts({ agentHomeDir: home, cwd: projectDir, includeProjectResources: true, disabledPromptNames: [] });
		assert.equal(Array.from(prompts).length, 1);
		assert.equal(prompts[0].name, "pkg-prompt");
		assert.equal(prompts[0].sourceId, "package-user");
		assert.equal(prompts[0].managed, true);
		const extensions = discoverExtensions({
			agentHomeDir: home,
			cwd: projectDir,
			includeProjectResources: true,
			disabledExtensions: [],
		});
		assert.equal(Array.from(extensions).length, 1);
		assert.equal(extensions[0].source, `${packageRoot}`);
		assert.equal(extensions[0].physicalScope, "user");
		assert.equal(extensions[0].managed, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discovery respects disabled lists and includeProjectResources=false", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-discovery3-"));
	try {
		const home = join(root, "home");
		const agentDir = join(home, ".pi", "agent");
		const projectDir = join(root, "project");
		const explicitSkillDir = join(root, "explicit-skills");
		put(
			join(explicitSkillDir, "custom-skill", "SKILL.md"),
			"---\nname: custom-skill\ndescription: custom description\n---\n\n# custom-skill\n",
		);
		put(join(agentDir, "settings.json"), JSON.stringify({ skills: [explicitSkillDir] }));
		const { discoverSkills } = loadTsCommonJs("src/main/resourceDiscovery.ts");
		const disabled = discoverSkills({
			agentHomeDir: home,
			cwd: projectDir,
			includeProjectResources: true,
			disabledSkillNames: ["custom-skill"],
		});
		assert.equal(Array.from(disabled).filter((skill) => skill.path.startsWith(root)).length, 1);
		assert.equal(Array.from(disabled).find((skill) => skill.path.startsWith(root)).enabled, false);
		const excludedProject = discoverSkills({
			agentHomeDir: home,
			cwd: projectDir,
			includeProjectResources: false,
			disabledSkillNames: [],
		});
		assert.equal(Array.from(excludedProject).filter((skill) => skill.path.startsWith(root)).length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
