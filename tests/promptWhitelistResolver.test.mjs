import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 加载 promptWhitelistResolver.ts（提示词模板白名单路径解析）。 */
function loadResolverModule() {
	return loadTsCommonJs("src/main/prompts/promptWhitelistResolver.ts");
}

/** 在临时根下构造 ~/.pi/agent + <cwd>/.pi 项目目录骨架（建 .git 截断祖先链）。 */
function setupFixtures() {
	const root = mkdtempSync(join(tmpdir(), "pideck-prompt-resolver-"));
	const home = root;
	const agentDir = join(home, ".pi", "agent");
	const cwd = join(root, "project");
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(agentDir, "prompts"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
	const put = (rel, content = "{}") => {
		const full = join(root, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content, "utf8");
		return full;
	};
	const mkdir = (rel) => {
		const full = join(root, rel);
		mkdirSync(full, { recursive: true });
		return full;
	};
	return { root, home, agentDir, cwd, put, mkdir };
}

function same(actual, expected) {
	assert.deepEqual([...actual].sort(), [...expected].sort());
}

function promptMd(dir, name) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, name),
		`---\ndescription: ${name} prompt\n---\n\n# ${name}\n`,
		"utf8",
	);
}

test("无禁用项时关闭白名单（返回 null）", () => {
	const { resolveEnabledPromptPaths } = loadResolverModule();
	const { root, home, cwd } = setupFixtures();
	try {
		const result = resolveEnabledPromptPaths({ agentHomeDir: home, cwd, disabledNames: [] });
		assert.equal(result, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("有禁用项时仅枚举全局/项目 prompts 目录的顶层 .md（无 agents 目录）", () => {
	const { resolveEnabledPromptPaths } = loadResolverModule();
	const { root, home, agentDir, cwd } = setupFixtures();
	try {
		promptMd(join(agentDir, "prompts"), "review.md");
		promptMd(join(agentDir, "prompts"), "disabled.md");
		// Nested prompts are not auto-discovered in pi 0.85; they require an explicit settings path.
		promptMd(join(agentDir, "prompts", "nested", "sub"), "deep.md");
		// .d.md 也被 pi 加载（collectFiles /\.md$/），白名单枚举必须包含
		promptMd(join(agentDir, "prompts"), "hidden.d.md");
		promptMd(join(cwd, ".pi", "prompts"), "project-prompt.md");
		// 项目级 .agents/prompts 不存在于 pi 的发现规则，不应枚举（无此目录时自然跳过）

		const result = resolveEnabledPromptPaths({
			agentHomeDir: home,
			cwd,
			disabledNames: ["disabled"],
		});
		assert.ok(result, "有禁用项时必须启用白名单");
		same(result, [
			join(agentDir, "prompts", "review.md"),
			join(agentDir, "prompts", "hidden.d.md"),
			join(cwd, ".pi", "prompts", "project-prompt.md"),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目 .pi/settings.json 的 disabledPrompts 生效且名称大小写不敏感", () => {
	const { resolveEnabledPromptPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put } = setupFixtures();
	try {
		promptMd(join(agentDir, "prompts"), "global-a.md");
		promptMd(join(cwd, ".pi", "prompts"), "Project-Disabled.md");
		put("project/.pi/settings.json", JSON.stringify({ disabledPrompts: ["project-disabled"] }));

		const result = resolveEnabledPromptPaths({ agentHomeDir: home, cwd, disabledNames: ["global-a"] });
		assert.ok(result);
		same(result, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ignore 规则（.gitignore）排除自动发现模板", () => {
	const { resolveEnabledPromptPaths } = loadResolverModule();
	const { root, home, agentDir, cwd } = setupFixtures();
	try {
		promptMd(join(agentDir, "prompts"), "ignored.md");
		promptMd(join(agentDir, "prompts"), "kept.md");
		writeFileSync(join(agentDir, "prompts", ".gitignore"), "ignored.md\n", "utf8");

		const result = resolveEnabledPromptPaths({ agentHomeDir: home, cwd, disabledNames: ["nonexistent"] });
		assert.ok(result);
		same(result, [join(agentDir, "prompts", "kept.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("settings.prompts 数组：显式路径 + override patterns 过滤", () => {
	const { resolveEnabledPromptPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put } = setupFixtures();
	try {
		promptMd(join(agentDir, "prompts"), "beta.md");
		promptMd(join(agentDir, "prompts"), "kept.md");
		put(".pi/agent/settings.json", JSON.stringify({ prompts: ["!beta.md", "kept.md"] }));
		promptMd(join(root, "explicit"), "external.md");
		put(".pi/agent/settings.json", JSON.stringify({ prompts: ["!beta.md", join(root, "explicit")] }));

		const result = resolveEnabledPromptPaths({ agentHomeDir: home, cwd, disabledNames: ["nonexistent"] });
		assert.ok(result);
		// beta.md 被 ! 排除；显式目录 external 递归枚举
		same(result, [
			join(agentDir, "prompts", "kept.md"),
			join(root, "explicit", "external.md"),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("packages 对象条目 prompts 空数组 = 该包全部模板禁用；非空只注入匹配项", () => {
	const { resolveEnabledPromptPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put, mkdir } = setupFixtures();
	try {
		const pkgDir = mkdir(".pi/agent/npm/node_modules/prompt-pack");
		promptMd(join(pkgDir, "prompts"), "alpha.md");
		promptMd(join(pkgDir, "prompts"), "beta.md");
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "prompt-pack" }), "utf8");
		put(
			".pi/agent/settings.json",
			JSON.stringify({ packages: [{ source: "npm:prompt-pack", prompts: ["alpha*"] }] }),
		);

		const result = resolveEnabledPromptPaths({ agentHomeDir: home, cwd, disabledNames: ["nonexistent"] });
		assert.ok(result);
		same(result, [join(pkgDir, "prompts", "alpha.md")]);

		// 空数组 = 全禁
		put(
			".pi/agent/settings.json",
			JSON.stringify({ packages: [{ source: "npm:prompt-pack", prompts: [] }] }),
		);
		const disabledAll = resolveEnabledPromptPaths({ agentHomeDir: home, cwd, disabledNames: ["nonexistent"] });
		assert.ok(disabledAll);
		same(disabledAll, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("manifest pi.prompts 声明的 patterns 过滤生效（! 排除）", () => {
	const { resolveEnabledPromptPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put, mkdir } = setupFixtures();
	try {
		const pkgDir = mkdir(".pi/agent/npm/node_modules/prompt-pack");
		promptMd(join(pkgDir, "custom"), "alpha.md");
		promptMd(join(pkgDir, "custom"), "beta.md");
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "prompt-pack", pi: { prompts: ["custom/alpha.md", "!custom/beta.md"] } }),
			"utf8",
		);
		put(".pi/agent/settings.json", JSON.stringify({ packages: ["npm:prompt-pack"] }));

		const result = resolveEnabledPromptPaths({ agentHomeDir: home, cwd, disabledNames: ["nonexistent"] });
		assert.ok(result);
		same(result, [join(pkgDir, "custom", "alpha.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("全局禁用与项目同名模板相互隔离", () => {
	const { resolveEnabledPromptPaths } = loadResolverModule();
	const { root, home, agentDir, cwd } = setupFixtures();
	try {
		promptMd(join(agentDir, "prompts"), "shared.md");
		promptMd(join(cwd, ".pi", "prompts"), "shared.md");
		const result = resolveEnabledPromptPaths({ agentHomeDir: home, cwd, disabledNames: ["shared"] });
		assert.ok(result);
		same(result, [join(cwd, ".pi", "prompts", "shared.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目继承覆盖只禁用全局模板，保留项目同名模板", () => {
	const { resolveEnabledPromptPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put } = setupFixtures();
	try {
		promptMd(join(agentDir, "prompts"), "shared.md");
		const projectPrompt = join(cwd, ".pi", "prompts", "shared.md");
		promptMd(join(cwd, ".pi", "prompts"), "shared.md");
		put("project/.pi/settings.json", JSON.stringify({
			pideckDisabledGlobalPrompts: ["shared"],
		}));
		const result = resolveEnabledPromptPaths({ agentHomeDir: home, cwd, disabledNames: [] });
		assert.ok(result);
		same(result, [projectPrompt]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目 settings 的相对 prompt 路径以 <cwd>/.pi 为基准", () => {
	const { resolveEnabledPromptPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		promptMd(join(cwd, ".pi", "extra", "nested"), "project-explicit.md");
		put("project/.pi/settings.json", JSON.stringify({ prompts: ["extra"] }));
		const result = resolveEnabledPromptPaths({ agentHomeDir: home, cwd, disabledNames: ["missing"] });
		assert.ok(result);
		same(result, [join(cwd, ".pi", "extra", "nested", "project-explicit.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("拒绝项目 trust 时强制全局白名单且忽略项目模板", () => {
	const { resolveEnabledPromptPaths } = loadResolverModule();
	const { root, home, agentDir, cwd } = setupFixtures();
	try {
		promptMd(join(agentDir, "prompts"), "global.md");
		promptMd(join(cwd, ".pi", "prompts"), "project.md");
		const result = resolveEnabledPromptPaths({
			agentHomeDir: home,
			cwd,
			disabledNames: [],
			includeProjectResources: false,
		});
		assert.ok(result);
		same(result, [join(agentDir, "prompts", "global.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
