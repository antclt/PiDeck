import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DshHost } = loadTsCommonJs("src/main/dsh/DshHost.ts");
const { workspaceDirFor } = loadTsCommonJs("src/main/dsh/dshSessionPath.ts");

/** 构造归档测试宿主：DSH_HOME 指向临时目录（覆盖 getter 优先，不碰真实 ~/.dsh）。 */
function makeHost() {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-archive-"));
	const host = new DshHost(
		() => join(home, "userData"),
		() => home,
		() => undefined,
		() => home,
	);
	return { host, home };
}

/** 在 sessions 树里造一个假 host 会话目录（session.jsonl.zstd 占位）。 */
function makeSessionDir(home, cwd, sessionId) {
	const dir = join(home, "sessions", workspaceDirFor(cwd), sessionId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "session.jsonl.zstd"), "fake-log");
	return dir;
}

test("DshHost.archiveSession：目录移入 .pideck-archive 并写 manifest", async () => {
	const { host, home } = makeHost();
	try {
		const cwd = "C:/work/project";
		const sessionId = "session-abc-123";
		const sourceDir = makeSessionDir(home, cwd, sessionId);
		const archived = await host.archiveSession(sessionId, cwd);
		assert.ok(archived.endsWith(join(".pideck-archive", sessionId)), `归档路径: ${archived}`);
		assert.ok(!existsSync(sourceDir), "原 sessions 树目录应已移走");
		const manifest = JSON.parse(readFileSync(join(archived, "pideck-manifest.json"), "utf8"));
		assert.equal(manifest.dshSessionId, sessionId);
		assert.equal(manifest.cwd, cwd);
		assert.equal(typeof manifest.archivedAt, "number");
		// 会话日志随目录一起保留（不销毁数据）
		assert.ok(existsSync(join(archived, "session.jsonl.zstd")));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.archiveSession：会话不存在返回 undefined（不产生归档目录）", async () => {
	const { host, home } = makeHost();
	try {
		const archived = await host.archiveSession("session-missing", "C:/work/project");
		assert.equal(archived, undefined);
		assert.ok(!existsSync(join(home, ".pideck-archive")), "不应创建归档根目录");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.unarchiveSession：按 manifest 的 cwd 移回原 workspace 目录", async () => {
	const { host, home } = makeHost();
	try {
		const cwd = "C:/work/project";
		const sessionId = "session-abc-123";
		makeSessionDir(home, cwd, sessionId);
		await host.archiveSession(sessionId, cwd);
		const restored = await host.unarchiveSession(sessionId);
		const expected = join(home, "sessions", workspaceDirFor(cwd), sessionId);
		assert.equal(restored.restoredPath, expected);
		assert.equal(restored.cwd, cwd, "应返回 manifest 中的原 workspace cwd（重建 catalog 记录用）");
		assert.ok(existsSync(join(expected, "session.jsonl.zstd")), "会话日志应回到 sessions 树");
		assert.ok(!existsSync(join(home, ".pideck-archive", sessionId)), "归档目录应已移走");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.unarchiveSession：manifest 损坏时不移动目录并返回 undefined", async () => {
	const { host, home } = makeHost();
	try {
		const sessionId = "session-bad-manifest";
		const archiveDir = join(home, ".pideck-archive", sessionId);
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(join(archiveDir, "pideck-manifest.json"), "{ not json");
		const restored = await host.unarchiveSession(sessionId);
		assert.equal(restored, undefined);
		assert.ok(existsSync(archiveDir), "损坏 manifest 的归档目录不应被移动");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.listArchivedSessions：返回归档清单（id/cwd/archivedAt），跳过无 manifest 目录", async () => {
	const { host, home } = makeHost();
	try {
		const cwd = "C:/work/带空格 项目";
		// 两个真实归档
		makeSessionDir(home, cwd, "session-a");
		makeSessionDir(home, "D:/other", "session-b");
		await host.archiveSession("session-a", cwd);
		await host.archiveSession("session-b", "D:/other");
		// 一个无 manifest 的目录（不属于 PiDeck 归档，应被跳过）
		mkdirSync(join(home, ".pideck-archive", "not-a-pideck-archive"), { recursive: true });

		const listed = host.listArchivedSessions();
		assert.equal(listed.length, 2);
		const byId = new Map(listed.map((item) => [item.dshSessionId, item]));
		assert.equal(byId.get("session-a").cwd, cwd);
		assert.equal(byId.get("session-b").cwd, "D:/other");
		assert.ok(typeof byId.get("session-a").archivedAt === "number" && byId.get("session-a").archivedAt > 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.listArchivedSessions：无归档区时返回空数组", () => {
	const { host, home } = makeHost();
	try {
		// 注意：vm realm 数组原型不同，不能用 deepEqual 直接比较空数组，按 length 断言
		assert.equal(host.listArchivedSessions().length, 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost 归档往返：编码含不安全字符的 cwd 也能恢复", async () => {
	const { host, home } = makeHost();
	try {
		const cwd = "C:\\work\\项目 dir~1";
		const sessionId = "session-unicode-1";
		makeSessionDir(home, cwd, sessionId);
		await host.archiveSession(sessionId, cwd);
		// 模拟外部改写 manifest（换机迁移等），恢复仍以 manifest 的 cwd 为准
		const manifestPath = join(home, ".pideck-archive", sessionId, "pideck-manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest.cwd = "C:\\work\\项目 dir~1";
		writeFileSync(manifestPath, JSON.stringify(manifest));
		const restored = await host.unarchiveSession(sessionId);
		assert.ok(existsSync(join(restored.restoredPath, "session.jsonl.zstd")), "会话日志应完整恢复");
		assert.equal(readdirSync(join(home, "sessions")).length, 1, "sessions 树应只剩恢复后的 workspace 目录");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
