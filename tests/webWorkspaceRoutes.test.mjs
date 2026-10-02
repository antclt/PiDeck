/**
 * Web 工作区只读路由单测（P3）：git status/diff/log、files 列表、file-content
 * 沙箱与有界读取、prompts 列表/详情。直接实例化 WebWorkspaceRoutes，
 * 用假 ServerResponse 断言协议形状；file-content 用真实临时目录验证沙箱。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// 注：期望值里的项目内路径用 join 构造，避免 Windows 分隔符差异
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebWorkspaceRoutes } = loadTsCommonJs("src/main/web/WebWorkspaceRoutes.ts");

function fakeResponse() {
	const res = {
		status: 0,
		headers: {},
		body: "",
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(payload) {
			if (payload !== undefined) this.body = String(payload);
		},
	};
	return res;
}

async function call(routes, path) {
	const res = fakeResponse();
	const handled = await routes.handle(new URL(`http://localhost${path}`), {}, res);
	return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

/** git/files/prompts 三组 stub：记录调用并回放固定数据。 */
function stubDeps(root, overrides = {}) {
	const calls = { diff: [], log: [], tree: [], prompts: [], detail: [] };
	return {
		calls,
		deps: {
			listProjects: () => [{ id: "p1", name: "P", path: root }],
			git: {
				isGitRepo: async () => true,
				getBranches: async () => ({ current: "main", locals: ["main"], remotes: [] }),
				getStatus: async () => ({ staged: [], unstaged: [], untracked: [] }),
				getWorkspaceFileDiff: async (cwd, group, filePath, maxBytes) => {
					calls.diff.push({ cwd, group, filePath, maxBytes });
					return { path: filePath, patch: "@@ -1 +1 @@", binary: false };
				},
				getCommitLog: async (_cwd, options) => {
					calls.log.push(options);
					return [{ hash: "abc123", subject: "init", author: "a", timestamp: 1 }];
				},
			},
			files: {
				listTree: async (rootDir, maxDepth, directory) => {
					calls.tree.push({ rootDir, maxDepth, directory });
					return [
						{ name: "src", relativePath: "src", type: "directory", path: join(rootDir, "src"), hasChildren: true },
						{ name: "a.txt", relativePath: "a.txt", type: "file", path: join(rootDir, "a.txt"), hasChildren: false },
					];
				},
			},
			prompts: {
				list: async (opts) => {
					calls.prompts.push(opts);
					return {
						categories: ["编程提示词"],
						prompts: [{ slug: "s1", title: "T", path: "C:/secret/absolute/path.md", category: "编程提示词" }],
						total: 1,
					};
				},
				detail: async (slug, category) => {
					calls.detail.push({ slug, category });
					return slug === "missing" ? null : { title: `T:${slug}`, description: "d", promptContent: "c", path: "C:/secret.md" };
				},
			},
			...overrides,
		},
	};
}

test("workspace routes return 503 when git/files/prompts services are absent", async () => {
	const routes = new WebWorkspaceRoutes({ listProjects: () => [] });
	for (const [path, code] of [
		["/api/git/status?projectId=p1", "webError.gitUnavailable"],
		["/api/files?projectId=p1", "webError.filesUnavailable"],
		["/api/prompts", "webError.promptsUnavailable"],
	]) {
		const result = await call(routes, path);
		assert.equal(result.status, 503);
		assert.equal(result.body.code, code);
	}
});

test("git status reports repo:false, forwards branch+groups, and 404s unknown projects", async () => {
	const { deps } = stubDeps("C:/project");
	const noRepo = new WebWorkspaceRoutes({ listProjects: deps.listProjects, git: { ...deps.git, isGitRepo: async () => false } });
	assert.equal((await call(noRepo, "/api/git/status?projectId=p1")).body.repo, false);

	const routes = new WebWorkspaceRoutes(deps);
	const ok = await call(routes, "/api/git/status?projectId=p1");
	assert.equal(ok.status, 200);
	assert.equal(ok.body.repo, true);
	assert.equal(ok.body.branch.current, "main");
	assert.deepEqual(ok.body.groups, { staged: [], unstaged: [], untracked: [] });

	assert.equal((await call(routes, "/api/git/status?projectId=nope")).status, 404);
});

test("git diff validates group/path, rejects traversal, and caps diff bytes", async () => {
	const { deps, calls } = stubDeps("C:/project");
	const routes = new WebWorkspaceRoutes(deps);
	assert.equal((await call(routes, "/api/git/diff?projectId=p1&group=bogus&path=a.txt")).status, 400);
	assert.equal((await call(routes, "/api/git/diff?projectId=p1&group=index&path=../escape.txt")).status, 400);
	assert.equal((await call(routes, "/api/git/diff?projectId=p1&group=index&path=/etc/passwd")).status, 400);
	assert.equal((await call(routes, "/api/git/diff?projectId=p1&group=index")).status, 400);

	const ok = await call(routes, "/api/git/diff?projectId=p1&group=workingTree&path=src/a.ts");
	assert.equal(ok.status, 200);
	assert.equal(ok.body.diff.patch, "@@ -1 +1 @@");
	assert.equal(calls.diff[0].group, "workingTree");
	assert.equal(calls.diff[0].filePath, "src/a.ts");
	// 有界 diff：与桌面 Git 面板同量级的 256KB 上限必须在调用层生效
	assert.equal(calls.diff[0].maxBytes, 256 * 1024);
});

test("git log clamps limit into [1,50] with default 20", async () => {
	const { deps, calls } = stubDeps("C:/project");
	const routes = new WebWorkspaceRoutes(deps);
	await call(routes, "/api/git/log?projectId=p1");
	await call(routes, "/api/git/log?projectId=p1&limit=999");
	await call(routes, "/api/git/log?projectId=p1&limit=0");
	assert.deepEqual(
		calls.log.map((options) => options.maxEntries),
		[20, 50, 1],
	);
});

test("files listing strips absolute paths and rejects dir traversal", async () => {
	const { deps, calls } = stubDeps("C:/project");
	const routes = new WebWorkspaceRoutes(deps);
	const ok = await call(routes, "/api/files?projectId=p1");
	assert.equal(ok.status, 200);
	for (const node of ok.body.nodes) {
		// FileTreeNode.path 是宿主机绝对路径，对外必须剥离
		assert.equal("path" in node, false);
	}
	assert.equal(ok.body.nodes[0].hasChildren, true);
	assert.equal(calls.tree[0].maxDepth, 0);

	assert.equal((await call(routes, "/api/files?projectId=p1&dir=../escape")).status, 400);
	const sub = await call(routes, "/api/files?projectId=p1&dir=src");
	assert.equal(calls.tree[1].directory, join("C:/project", "src"));
	assert.equal(sub.status, 200);
});

test("file-content enforces sandbox, size bound, and binary refusal on a real directory", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "web-workspace-")));
	await writeFile(join(root, "a.txt"), "hello web", "utf8");
	await writeFile(join(root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
	await writeFile(join(root, "nul.log"), Buffer.from("a\0b", "utf8"));
	await writeFile(join(root, "big.txt"), "x".repeat(512 * 1024 + 1), "utf8");
	await mkdir(join(root, "sub"));
	await writeFile(join(dirname(root), "escape.txt"), "outside", "utf8");

	const { deps } = stubDeps(root);
	const routes = new WebWorkspaceRoutes({ ...deps, files: undefined, git: undefined, prompts: undefined });

	const text = await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("a.txt")}`);
	assert.equal(text.status, 200);
	assert.equal(text.body.content, "hello web");
	assert.equal(text.body.binary, undefined);

	// 扩展名白名单外（png）→ 按二进制拒绝，不吐 UTF-8 乱码
	const png = await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("img.png")}`);
	assert.equal(png.body.binary, true);
	assert.equal(png.body.content, undefined);

	// 白名单内但含 NUL 字节 → 仍按二进制拒绝
	const nul = await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("nul.log")}`);
	assert.equal(nul.body.binary, true);

	// 超 512KB → tooLarge，不读内容
	const big = await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("big.txt")}`);
	assert.equal(big.body.tooLarge, true);
	assert.equal(big.body.size, 512 * 1024 + 1);

	// 沙箱：..逃逸 → 403；目录 → 404；缺失文件 → 404；空 path → 400
	assert.equal((await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("../escape.txt")}`)).status, 403);
	assert.equal((await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("sub")}`)).status, 404);
	assert.equal((await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("missing.txt")}`)).status, 404);
	assert.equal((await call(routes, "/api/file-content?projectId=p1&path=")).status, 400);
	assert.equal((await call(routes, "/api/file-content?projectId=nope&path=a.txt")).status, 404);
});

test("prompt listing strips host paths, clamps pageSize, and detail decodes slugs", async () => {
	const { deps, calls } = stubDeps("C:/project");
	const routes = new WebWorkspaceRoutes(deps);

	const list = await call(routes, "/api/prompts?search=%E4%BB%A3%E7%A0%81&category=%E7%BC%96%E7%A8%8B&pageSize=999");
	assert.equal(list.status, 200);
	assert.equal(calls.prompts[0].search, "代码");
	assert.equal(calls.prompts[0].category, "编程");
	assert.equal(calls.prompts[0].pageSize, 50);
	assert.equal(calls.prompts[0].page, 1);
	for (const prompt of list.body.prompts) {
		assert.equal("path" in prompt, false);
	}

	assert.equal((await call(routes, "/api/prompts/a%20b?category=x")).status, 200);
	assert.equal(calls.detail[0].slug, "a b");
	const detail = await call(routes, "/api/prompts/a%20b?category=x");
	assert.equal(detail.body.detail.title, "T:a b");
	assert.equal("path" in detail.body.detail, false);

	assert.equal((await call(routes, "/api/prompts/s1")).status, 400);
	assert.equal((await call(routes, "/api/prompts/missing?category=x")).status, 404);
});

test("unknown api paths fall through to the caller (returns false)", async () => {
	const routes = new WebWorkspaceRoutes({ listProjects: () => [] });
	const result = await call(routes, "/api/not-a-workspace-route");
	assert.equal(result.handled, false);
});
