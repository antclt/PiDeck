import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 资源管理器池（W1）：按 PiResourceTarget 隔离 + 档案变更/移除失效 + 本机行为不变。
 *
 * 断言按行为：同一目标的四类管理器实例稳定复用；两个档案拿到的实例不同；档案改 distro/user 后
 * 旧实例被丢弃重建；档案移除后回稳定码且缓存清空；本机目标永远返回装配注入的单例，且绝不
 * 对这些单例调用 configureWsl（旧全局切换路径）。
 */

const shared = loadTsCommonJs("src/shared/piConfig.ts");
const poolModule = loadTsCommonJs("src/main/config/PiResourceManagerPool.ts");
const wslPaths = loadTsCommonJs("src/main/wsl/WslPaths.ts");
const { PromptManager } = loadTsCommonJs("src/main/prompts/PromptManager.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function environment(distro = "Ubuntu-26.04", user = "dev") {
	return wslPaths.createWslEnvironment(distro, user, "/home/" + user);
}

function resolution(hostId, { distro = "Ubuntu-26.04", user = "dev" } = {}) {
	const env = environment(distro, user);
	return { kind: "wsl", cacheKey: "wsl:" + hostId + ":" + distro + ":" + user, home: env.windowsHome, hostId, label: "profile " + hostId, distro, user, environment: env };
}

function fakeManager(name, locale) {
	return {
		name,
		locale,
		configureWsl() {
			throw new Error("shared/local manager must never be reconfigured: " + name);
		},
	};
}

function createHarness(options = {}) {
	const created = [];
	const local = {
		skills: fakeManager("local-skills", options.local),
		prompts: fakeManager("local-prompts", options.local),
		extensions: fakeManager("local-extensions", options.local),
		xuePrompts: fakeManager("local-xue", options.local),
	};
	const resolverCalls = [];
	const resolver = {
		resolve: async (target) => {
			resolverCalls.push(target);
			if (options.resolve) return await options.resolve(target, resolverCalls.length);
			throw new Error("unexpected wsl target " + JSON.stringify(target));
		},
	};
	const factories = {
		skills: (input) => {
			created.push({ kind: "skills", ...input });
			return fakeManager("skills:" + input.home, input.home);
		},
		prompts: (input) => {
			created.push({ kind: "prompts", ...input });
			return fakeManager("prompts:" + input.home, input.home);
		},
		extensions: (input) => {
			created.push({ kind: "extensions", ...input });
			return fakeManager("extensions:" + input.home, input.home);
		},
		xuePrompts: (input) => {
			created.push({ kind: "xuePrompts", ...input });
			return fakeManager("xue:" + input.home, input.home);
		},
	};
	const pool = poolModule.createPiResourceManagerPool({ resolver, local: { skills: () => local.skills, prompts: () => local.prompts, extensions: () => local.extensions, xuePrompts: () => local.xuePrompts }, create: factories, maxScopes: options.maxScopes });
	return { pool, local, created, resolverCalls };
}

const targetOf = (hostId) => ({ target: { kind: "wsl", hostId } });

test("本机目标返回装配单例：不调用解析器、不创建实例、不 configureWsl", async () => {
	const { pool, local, created, resolverCalls } = createHarness();
	const strip = (value) => JSON.parse(JSON.stringify(value));
	assert.equal(await pool.skills(undefined), local.skills);
	assert.equal(await pool.prompts({}), local.prompts);
	assert.equal(await pool.prompts({ target: { kind: "local" } }), local.prompts);
	assert.equal(await pool.extensions(null), local.extensions);
	assert.equal(await pool.xuePrompts(strip({ target: { kind: "local" } })), local.xuePrompts);
	assert.equal(resolverCalls.length, 0);
	assert.equal(created.length, 0);
	assert.equal(pool.scopeCount(), 0);
});

test("两个 WSL 档案互相隔离：同一目标复用实例，不同目标实例不同且都只属于自己 HOME", async () => {
	const byHost = { [HOST]: resolution(HOST), [OTHER]: resolution(OTHER, { distro: "Ubuntu-24.04", user: "root" }) };
	const { pool, created, local } = createHarness({ resolve: async (target) => byHost[target.hostId] });

	const a1 = await pool.skills(targetOf(HOST));
	const a2 = await pool.skills(targetOf(HOST));
	const b1 = await pool.skills(targetOf(OTHER));
	assert.equal(a1, a2);
	assert.notEqual(a1, b1);
	assert.equal(a1.locale, byHost[HOST].home);
	assert.equal(b1.locale, byHost[OTHER].home);

	for (const kind of ["prompts", "extensions", "xuePrompts"]) {
		const first = await pool[kind](targetOf(HOST));
		const second = await pool[kind](targetOf(HOST));
		const other = await pool[kind](targetOf(OTHER));
		assert.equal(first, second, kind + " should be cached per target");
		assert.notEqual(first, other, kind + " must not leak between profiles");
	}
	assert.equal(pool.scopeCount(), 2);
	// 扩展与提示词库工厂拿到的是该档案解析出的 environment（构造期绑定发行版）。
	const extensionCreate = created.filter((entry) => entry.kind === "extensions");
	assert.deepEqual(JSON.parse(JSON.stringify(extensionCreate.map((entry) => entry.environment.distro).sort())), ["Ubuntu-24.04", "Ubuntu-26.04"]);
	// 本机单例没有被任何 WSL 目标重配置（旧全局 configureWsl 路径已不存在）。
	assert.equal(typeof local.skills.configureWsl, "function");
});

test("档案改 distro/user 后旧实例失效重建，旧实例不再被返回", async () => {
	let current = resolution(HOST);
	const { pool, created } = createHarness({ resolve: async () => current });
	const first = await pool.skills(targetOf(HOST));
	assert.equal(pool.scopeCount(), 1);

	current = resolution(HOST, { distro: "Ubuntu-24.04", user: "root" });
	const second = await pool.skills(targetOf(HOST));
	assert.notEqual(first, second);
	assert.equal(second.locale, current.home);
	assert.equal(pool.scopeCount(), 1);
	assert.deepEqual(JSON.parse(JSON.stringify(created.map((entry) => entry.home))), [first.locale, current.home]);
});

test("档案移除后回稳定码并清掉该档案的缓存（不静默复用旧实例）", async () => {
	let removed = false;
	const { pool } = createHarness({
		resolve: async () => {
			if (removed) throw new Error(shared.PI_RESOURCE_CODES.hostNotFound);
			return resolution(HOST);
		},
	});
	const manager = await pool.skills(targetOf(HOST));
	assert.equal(pool.scopeCount(), 1);
	removed = true;
	await assert.rejects(pool.skills(targetOf(HOST)), { message: shared.PI_RESOURCE_CODES.hostNotFound });
	assert.equal(pool.scopeCount(), 0);
	assert.ok(manager, "old instance must not be reused after removal");
});

test("非法目标与 ssh 目标在解析器之前失败，回闭集稳定码", async () => {
	const { pool, resolverCalls, created } = createHarness();
	const strip = (value) => JSON.parse(JSON.stringify(value));
	await assert.rejects(pool.skills({ target: { kind: "ssh", hostId: HOST } }), { message: shared.PI_RESOURCE_CODES.sshUnsupported });
	await assert.rejects(pool.prompts(strip({ target: { kind: "wsl", hostId: "nope" } })), { message: shared.PI_RESOURCE_CODES.targetInvalid });
	await assert.rejects(pool.extensions({ target: { kind: "local" }, force: true }), { message: shared.PI_RESOURCE_CODES.targetInvalid });
	assert.equal(resolverCalls.length, 0);
	assert.equal(created.length, 0);
});

test("作用域缓存有上限：超过 maxScopes 先淘汰最旧的档案", async () => {
	const hosts = [HOST, OTHER, "33333333-3333-4333-8333-333333333333"];
	const byHost = Object.fromEntries(hosts.map((hostId, index) => [hostId, resolution(hostId, { user: "u" + index })]));
	const { pool, created } = createHarness({ maxScopes: 2, resolve: async (target) => byHost[target.hostId] });
	await pool.skills(targetOf(hosts[0]));
	await pool.skills(targetOf(hosts[1]));
	assert.equal(pool.scopeCount(), 2);
	await pool.skills(targetOf(hosts[2]));
	assert.equal(pool.scopeCount(), 2);
	// 第一个档案被淘汰：再访问必须是新实例。
	const readded = await pool.skills(targetOf(hosts[0]));
	assert.equal(pool.scopeCount(), 2);
	assert.equal(created.filter((entry) => entry.home === byHost[hosts[0]].home).length, 2);
	assert.ok(readded);
});

test("真实 PromptManager 实例被限制在解析出的 HOME 下（两档案写读互不可见）", async () => {
	const homeA = await mkdtemp(join(tmpdir(), "pideck-w1-a-"));
	const homeB = await mkdtemp(join(tmpdir(), "pideck-w1-b-"));
	try {
		await mkdir(join(homeA, ".pi", "agent", "prompts"), { recursive: true });
		await mkdir(join(homeB, ".pi", "agent", "prompts"), { recursive: true });
		await writeFile(join(homeA, ".pi", "agent", "prompts", "alpha.md"), "---\ndescription: only in A\n---\n", "utf8");

		const profiles = {
			[HOST]: { ...resolution(HOST), home: homeA },
			[OTHER]: { ...resolution(OTHER), home: homeB },
		};
		const pool = poolModule.createPiResourceManagerPool({
			resolver: { resolve: async (target) => profiles[target.hostId] },
			local: { skills: () => null, prompts: () => null, extensions: () => null, xuePrompts: () => null },
			create: {
				skills: () => null,
				prompts: ({ home }) => new PromptManager(home),
				extensions: () => null,
				xuePrompts: () => null,
			},
		});

		const managerA = await pool.prompts(targetOf(HOST));
		const managerB = await pool.prompts(targetOf(OTHER));
		const listA = await managerA.list();
		const listB = await managerB.list();
		assert.equal(listA.templates.map((template) => template.name).join(","), "alpha");
		assert.equal(listA.globalDir, join(homeA, ".pi", "agent", "prompts"));
		assert.equal(listB.templates.length, 0);
		assert.equal(listB.globalDir, join(homeB, ".pi", "agent", "prompts"));

		// 在 B 里新建只落在 B 的 HOME；A 看不到、A 的文件未被改动。
		await managerB.create({ name: "beta", description: "only in B" });
		assert.match(await readFile(join(homeB, ".pi", "agent", "prompts", "beta.md"), "utf8"), /description: only in B/);
		assert.equal((await managerA.list()).templates.map((template) => template.name).join(","), "alpha");
	} finally {
		await rm(homeA, { recursive: true, force: true });
		await rm(homeB, { recursive: true, force: true });
	}
});