import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import { expandHomeForFileAccess } from "../src/main/fs/homePathExpansion.ts";
import { resolveFileLinkPath } from "../src/renderer/src/utils/filePathLinks.ts";
import { expandHomePath, isHomeRelativePath } from "../src/shared/homePath.ts";

// `~` 家目录展开（issue #426）：`~` 此前在全链路被当成字面目录名，渲染层判「项目外」、
// 主进程 fs.stat 直接 ENOENT，用户看到「文件明明在，点了却提示不存在」。
// 这里锁两件事：共享展开口径的边界，以及渲染层「先展开、再判项目边界」的顺序。

test("recognizes only bare ~ forms, never ~user", () => {
	for (const path of ["~", "~/Desktop/a.md", "~\\Desktop\\a.md"]) assert.equal(isHomeRelativePath(path), true, path);
	// `~user` 是 shell 的用户名展开，语义不同；出现在邮箱/正则里时不能被当路径处理
	for (const path of ["~user/x.md", "src/~/a.md", "/home/u/a.md", "C:\\Users\\u\\a.md", "", "~a"]) assert.equal(isHomeRelativePath(path), false, path);
});

test("expands ~ against a POSIX home and unifies mixed separators", () => {
	assert.equal(expandHomePath("~/桌面/x.html", "/home/alice"), "/home/alice/桌面/x.html");
	// 混写分隔符（模型常写 `~\Documents/a.md`）必须收敛成家目录那一侧的语法
	assert.equal(expandHomePath("~\\Documents/a.md", "/home/alice"), "/home/alice/Documents/a.md");
	assert.equal(expandHomePath("~", "/home/alice"), "/home/alice");
	// 家目录自带尾分隔符时不能拼出 `//`
	assert.equal(expandHomePath("~/a.md", "/home/alice/"), "/home/alice/a.md");
});

test("expands ~ against a Windows home using backslashes", () => {
	assert.equal(expandHomePath("~/Desktop/a.md", "C:\\Users\\alice"), "C:\\Users\\alice\\Desktop\\a.md");
	assert.equal(expandHomePath("~\\Desktop\\a.md", "C:\\Users\\alice"), "C:\\Users\\alice\\Desktop\\a.md");
});

test("leaves the path untouched when home is unknown or the path is not home-relative", () => {
	// 渲染层在 appInfo 到达前拿不到家目录：必须原样返回（旧行为），不能展开成 "/undefined/…"
	assert.equal(expandHomePath("~/a.md", undefined), "~/a.md");
	assert.equal(expandHomePath("~/a.md", ""), "~/a.md");
	assert.equal(expandHomePath("/abs/a.md", "/home/alice"), "/abs/a.md");
	assert.equal(expandHomePath("~user/a.md", "/home/alice"), "~user/a.md");
});

test("renderer resolves ~ inside the project boundary (issue #426 regression)", () => {
	// 修复前：`~/proj/src/a.ts` 不是绝对路径，会拼成 <root>/~/proj/src/a.ts 且被词法规范化保留，
	// 落到 stat 上是 ENOENT。修复后先展开再判边界 → 命中项目内真实文件。
	assert.equal(resolveFileLinkPath("~/proj/src/a.ts", "/home/alice/proj", "/home/alice/proj", "/home/alice"), "/home/alice/proj/src/a.ts");
	// 项目根就是家目录时同样成立
	assert.equal(resolveFileLinkPath("~/notes.md", "/home/alice", "/home/alice", "/home/alice"), "/home/alice/notes.md");
});

test("renderer still rejects a ~ path that lands outside the project boundary", () => {
	// 展开的意义是「判得准」，不是「放行」：项目外的家目录文件仍返回 null（左键走项目外确认流程）
	assert.equal(resolveFileLinkPath("~/Desktop/secret.md", "/home/alice/proj", "/home/alice/proj", "/home/alice"), null);
});

test("renderer keeps the pre-fix outcome when home is unknown", () => {
	// appInfo 未就绪时不能凭空造路径：`~` 在词法上算绝对路径（isAbsoluteFilePath），
	// 带着字面 `~` 去比项目边界必然判「项目外」→ null。这正是 #426 的报障形态，
	// 家目录未知时会短暂回到这个状态，不能变成「猜一个家目录」。
	assert.equal(resolveFileLinkPath("~/a.md", "/home/alice/proj", "/home/alice/proj", undefined), null);
	assert.equal(resolveFileLinkPath("~/a.md", "/home/alice/proj", undefined, undefined), "~/a.md");
});

test("renderer expands ~ for Windows-style session paths", () => {
	// 项目根就是家目录：桌面文件解析成真绝对路径（修复前恒为 null）
	assert.equal(resolveFileLinkPath("~\\Desktop\\a.md", "C:\\Users\\alice", "C:\\Users\\alice", "C:\\Users\\alice"), "C:\\Users\\alice\\Desktop\\a.md");
	assert.equal(resolveFileLinkPath("~\\proj\\src\\a.ts", "C:\\Users\\alice\\proj", "C:\\Users\\alice\\proj", "C:\\Users\\alice"), "C:\\Users\\alice\\proj\\src\\a.ts");
});

test("main-process expansion uses the distro home inside a WSL session", () => {
	// WSL 会话里 `~` 是**发行版内**的 home：展开后仍是 Linux 路径，再由 toWindowsPath 转 UNC。
	// 若这里错用 Windows home，`~/x` 会指向另一个文件系统里的同名路径。
	const settings = { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "alice" };
	assert.equal(expandHomeForFileAccess("~/桌面/x.html", settings, "win32"), "/home/alice/桌面/x.html");
	assert.equal(expandHomeForFileAccess("~/x.html", { ...settings, wslUser: "root" }, "win32"), "/root/x.html");
	// 非 Win32 平台不套 WSL 口径，即便 settings 里残留了 WSL 配置
	assert.equal(expandHomeForFileAccess("~/x.html", settings, "linux"), expandHomePath("~/x.html", homedir()));
});

test("main-process expansion falls back to the host home, and refuses to guess for WSL", () => {
	// 普通会话：本机家目录
	assert.equal(expandHomeForFileAccess("~/notes.md", { wslEnabled: false }, "win32"), expandHomePath("~/notes.md", homedir()));
	assert.equal(expandHomeForFileAccess("~/notes.md", undefined, "linux"), expandHomePath("~/notes.md", homedir()));
	// WSL 会话但用户未知：/root 与 /home/<user> 都可能是对的，宁可不展开（= 修复前行为，不会打开错文件）
	assert.equal(expandHomeForFileAccess("~/notes.md", { wslEnabled: true, wslDistro: "Ubuntu-24.04" }, "win32"), "~/notes.md");
	assert.equal(expandHomeForFileAccess("~/notes.md", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "  " }, "win32"), "~/notes.md");
});

test("main-process expansion is a no-op for non-~ and unbounded inputs", () => {
	assert.equal(expandHomeForFileAccess("C:\\proj\\a.md", undefined, "win32"), "C:\\proj\\a.md");
	assert.equal(expandHomeForFileAccess("/home/alice/a.md", { wslEnabled: true, wslDistro: "Ubuntu" }, "win32"), "/home/alice/a.md");
	assert.equal(expandHomeForFileAccess("", undefined, "linux"), "");
	assert.equal(expandHomeForFileAccess("~user/a.md", undefined, "linux"), "~user/a.md");
});
