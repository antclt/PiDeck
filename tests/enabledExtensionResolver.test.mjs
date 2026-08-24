import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

/**
 * 加载 enabledExtensionResolver.ts（白名单路径解析，纯 fs 逻辑）。
 * 内置扩展模块走真实实现：listActiveBuiltInExtensionPaths 读真实文件系统，
 * 因此 builtInRoots 必须指向临时资源目录并写入 pi-deck-* 文件。
 */
function loadResolverModule() {
	const source = readFileSync("src/main/extensions/enabledExtensionResolver.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const module = { exports: {} };
	vm.runInNewContext(outputText, {
		module,
		exports: module.exports,
		require: (specifier) => {
			if (specifier === "./builtInExtensions") {
				return nodeRequire("../src/main/extensions/builtInExtensions.ts");
			}
			return nodeRequire(specifier);
		},
	}, { filename: "enabledExtensionResolver.ts" });
	return module.exports;
}

/** 在临时根下构造 ~/.pi/agent + <cwd>/.pi 项目目录骨架。返回各关键路径与写文件助手。 */
function setupFixtures() {
	const root = mkdtempSync(join(tmpdir(), "pideck-ext-resolver-"));
	const home = root; // 模拟 HOME：~/.pi/agent 落在 root/.pi/agent
	const agentDir = join(home, ".pi", "agent");
	const cwd = join(root, "project");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
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
	// vm 沙箱数组与主 realm deepStrictEqual 可能因原型不同失败
	assert.deepEqual([...actual].sort(), [...expected].sort());
}

test("disabled 为空时关闭白名单（返回 null）", () => {
	const { resolveEnabledExtensionPaths } = loadResolverModule();
	const { root, home, cwd } = setupFixtures();
	try {
		const result = resolveEnabledExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		assert.equal(result, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("有禁用项时：npm 包按安装目录注入，禁用的剔除、未安装的跳过", () => {
	const { resolveEnabledExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put, mkdir } = setupFixtures();
	try {
		put(".pi/agent/settings.json", JSON.stringify({
			packages: ["npm:pi-web-access", "npm:pi-mcp-adapter", "npm:pi-missing"],
		}));
		mkdir(".pi/agent/npm/node_modules/pi-web-access");
		mkdir(".pi/agent/npm/node_modules/pi-mcp-adapter");

		const result = resolveEnabledExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "npm:pi-mcp-adapter" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		assert.notEqual(result, null);
		same(result, [join(home, ".pi", "agent", "npm", "node_modules", "pi-web-access")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("project packages 从项目 .pi/npm 注入，且 user/project 同名禁用相互独立", () => {
	const { resolveEnabledExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put, mkdir } = setupFixtures();
	try {
		put(".pi/agent/settings.json", JSON.stringify({ packages: ["npm:pi-web-access"] }));
		mkdir(".pi/agent/npm/node_modules/pi-web-access");
		put("project/.pi/settings.json", JSON.stringify({ packages: ["npm:pi-project-tool"] }));
		mkdir("project/.pi/npm/node_modules/pi-project-tool");

		// 只禁用 user 级 pi-web-access：project 条目不受牵连
		const result = resolveEnabledExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "npm:pi-web-access" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		same(result, [join(cwd, ".pi", "npm", "node_modules", "pi-project-tool")]);

		// 禁用 project 同名 → project 条目剔除，user 条目保留
		const result2 = resolveEnabledExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "project", source: "npm:pi-project-tool" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		same(result2, [join(home, ".pi", "agent", "npm", "node_modules", "pi-web-access")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("本地 .ts 文件扩展：user/project 目录都扫，禁用按文件名剔除", () => {
	const { resolveEnabledExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		put(".pi/agent/extensions/local-tool.ts", "// x");
		put(".pi/agent/extensions/orca.ts", "// x");
		put("project/.pi/extensions/proj-ext.ts", "// x");

		const result = resolveEnabledExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "local-tool.ts" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		same(result, [
			join(home, ".pi", "agent", "extensions", "orca.ts"),
			join(cwd, ".pi", "extensions", "proj-ext.ts"),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("目录扩展（index.ts / pi manifest）解析为入口文件路径", () => {
	const { resolveEnabledExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		put(".pi/agent/extensions/my-dir/index.ts", "// entry");
		put(".pi/agent/extensions/pi-manifest-dir/package.json", JSON.stringify({
			pi: { extensions: ["src/main.ts"] },
		}));
		put(".pi/agent/extensions/pi-manifest-dir/src/main.ts", "// entry");

		const result = resolveEnabledExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "my-dir" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		same(result, [join(home, ".pi", "agent", "extensions", "pi-manifest-dir", "src", "main.ts")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("内置扩展注入：removedBuiltInExtensions 剔除 + 资源缺失跳过", () => {
	const { resolveEnabledExtensionPaths } = loadResolverModule();
	const { root, home, cwd, mkdir } = setupFixtures();
	try {
		const extDir = mkdir("resources/extensions");
		writeFileSync(join(extDir, "pi-deck-todo.ts"), "// todo");
		writeFileSync(join(extDir, "pi-deck-plan-mode.ts"), "// plan");
		// pi-deck-vision.ts 故意不写 → 缺失跳过（listActiveBuiltInExtensionPaths 已过滤）

		const result = resolveEnabledExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "npm:whatever" }],
			removedBuiltInExtensions: ["pi-deck-todo.ts"],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		const builtIns = (result ?? []).filter((p) => p.includes("pi-deck-"));
		same(builtIns, [join(extDir, "pi-deck-plan-mode.ts")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("全部禁用时返回空数组（≠ null）：调用方须仍加 --no-extensions", () => {
	const { resolveEnabledExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		put(".pi/agent/extensions/solo.ts", "// x");
		const result = resolveEnabledExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "solo.ts" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		assert.deepEqual([...result], []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("特殊字符扩展名（空格/中文/&）按字面匹配：spawn 数组传参无需转义，禁用按 source 精确命中", () => {
	const { resolveEnabledExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		const special = "custom tools & more.ts";
		const chinese = "中文扩展.ts";
		put(`.pi/agent/extensions/${special}`, "// a");
		put(`.pi/agent/extensions/${chinese}`, "// b");
		put(".pi/agent/extensions/plain.ts", "// c");

		const result = resolveEnabledExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: special }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		// 含特殊字符的禁用源被精确剔除，其余字面注入（pi 侧 resolvePath 只做 Unicode 空格规范化，
		// 普通空格/中文/& 均按字面处理）
		same(result, [
			join(home, ".pi", "agent", "extensions", chinese),
			join(home, ".pi", "agent", "extensions", "plain.ts"),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
