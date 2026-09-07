/**
 * ConfigBackupManager 单测：备份创建/列表/保留策略/脱敏/恢复保护/删除/启动检测/防抖。
 * 用真实临时目录驱动（依赖注入 getConfigDir/getUserDataDir/getAppVersion），不依赖 electron。
 */
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModule() {
	const sandbox = { exports: {}, require, setTimeout, clearTimeout };
	vm.runInNewContext(transpile("src/main/config/ConfigBackupManager.ts"), sandbox, {
		filename: "ConfigBackupManager.ts",
	});
	return sandbox.exports;
}

const mod = loadModule();
const { ConfigBackupManager, redactSecrets, MAX_BACKUPS } = mod;

/** 构造一个指向真实临时目录的 manager，并铺好 pi 配置 + pideck 设置。 */
function setup(opts = {}) {
	const root = mkdtempSync(join(tmpdir(), "pideck-backup-test-"));
	const userData = join(root, "userData");
	const configDir = join(root, "pi");
	mkdirSync(userData, { recursive: true });
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "models.json"),
		JSON.stringify({ providers: { alpha: { apiKey: "sk-test-123456789", model: "gpt-4" } } }, null, 2),
	);
	writeFileSync(join(configDir, "auth.json"), JSON.stringify({ alpha: { type: "bearer", key: "sk-auth-abcdefgh" } }, null, 2));
	writeFileSync(join(configDir, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));
	writeFileSync(join(configDir, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2));
	writeFileSync(join(userData, "settings.json"), JSON.stringify({ theme: "light" }, null, 2));
	const manager = new ConfigBackupManager({
		getConfigDir: () => configDir,
		getUserDataDir: () => userData,
		getAppVersion: () => "1.0.0",
		saveDebounceMs: 20,
		...opts,
	});
	return { manager, userData, configDir, root };
}

function cleanup(ctx) {
	rmSync(ctx.root, { recursive: true, force: true });
}

test("create 生成备份文件并记录元数据（files 含 pi/* 与 pideck/* 命名空间）", () => {
	const ctx = setup();
	try {
		const result = ctx.manager.create("manual");
		assert.equal(result.ok, true);
		assert.ok(result.id.endsWith(".json"));

		const listed = ctx.manager.list();
		assert.equal(listed.ok, true);
		assert.equal(listed.backups.length, 1);
		const meta = listed.backups[0];
		assert.equal(meta.appVersion, "1.0.0");
		assert.equal(meta.reason, "manual");
		assert.deepEqual(
			[...meta.files].sort(),
			["pi/auth.json", "pi/mcp.json", "pi/models.json", "pi/settings.json", "pideck/settings.json"],
		);
		assert.ok(meta.size > 0);
		assert.ok(meta.configDir.includes("pi"));
	} finally {
		cleanup(ctx);
	}
});

test("保留策略：超过 MAX_BACKUPS 时删除最旧，只留最近 N 份", () => {
	const ctx = setup();
	try {
		const created = [];
		for (let i = 0; i < MAX_BACKUPS + 5; i++) {
			created.push(ctx.manager.create("on-save").id);
		}
		const listed = ctx.manager.list();
		assert.equal(listed.backups.length, MAX_BACKUPS);
		// 最旧的 5 份被删除（created 数组前 5 个）
		for (const id of created.slice(0, 5)) {
			assert.ok(!readdirSync(join(ctx.userData, "config-backups")).includes(id), `should prune ${id}`);
		}
	} finally {
		cleanup(ctx);
	}
});

test("read 详情脱敏：auth key / models apiKey 替换为 ***，结构保留", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		const detail = ctx.manager.read(id);
		assert.ok(detail);
		const authFile = detail.files.find((f) => f.name === "pi/auth.json");
		const modelsFile = detail.files.find((f) => f.name === "pi/models.json");
		assert.equal(authFile.redacted, true);
		assert.equal(modelsFile.redacted, true);
		assert.ok(!authFile.raw.includes("sk-auth-abcdefgh"));
		assert.ok(authFile.raw.includes('"key": "***"'));
		assert.ok(!modelsFile.raw.includes("sk-test-123456789"));
		assert.ok(modelsFile.raw.includes('"apiKey": "***"'));
		// 非敏感文件不脱敏
		const settingsFile = detail.files.find((f) => f.name === "pi/settings.json");
		assert.equal(settingsFile.redacted, false);
	} finally {
		cleanup(ctx);
	}
});

test("restore：恢复前自动建 pre-restore 保护备份，并把内容写回对应位置", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		// 改坏当前配置，验证恢复能写回
		writeFileSync(join(ctx.configDir, "models.json"), "{}");
		const result = ctx.manager.restore(id);
		assert.equal(result.ok, true);

		// 保护备份已生成
		const listed = ctx.manager.list();
		const reasons = listed.backups.map((b) => b.reason);
		assert.ok(reasons.includes("pre-restore"), `reasons=${reasons.join(",")}`);
		// 恢复后 models.json 回到备份内容
		const restored = JSON.parse(readFileSync(join(ctx.configDir, "models.json"), "utf8"));
		assert.equal(restored.providers.alpha.apiKey, "sk-test-123456789");
		// pideck 设置写回 userData
		const pideck = JSON.parse(readFileSync(join(ctx.userData, "settings.json"), "utf8"));
		assert.equal(pideck.theme, "light");
	} finally {
		cleanup(ctx);
	}
});

test("restore 保护备份失败时拒绝恢复（不留无退路状态）", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		// 让 collectFiles 收集不到任何文件（pi 目录 + pideck 设置都移除）→
		// pre-restore 保护备份必然失败，恢复必须被拒绝。
		rmSync(ctx.configDir, { recursive: true, force: true });
		rmSync(join(ctx.userData, "settings.json"), { force: true });
		const result = ctx.manager.restore(id);
		assert.equal(result.ok, false);
		assert.match(result.error, /pre-restore backup failed/);
	} finally {
		cleanup(ctx);
	}
});

test("restore 单文件：只恢复指定的 key，其它文件保持当前值", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		// 改坏两个文件，然后只恢复 models.json。
		writeFileSync(join(ctx.configDir, "models.json"), "{}");
		writeFileSync(join(ctx.configDir, "auth.json"), "{ \"alpha\": { \"type\": \"bearer\", \"key\": \"changed-123456\" } }");

		const result = ctx.manager.restore(id, ["pi/models.json"]);
		assert.equal(result.ok, true);
		// models.json 已恢复；auth.json 保持改后的值（未被恢复）。
		const models = JSON.parse(readFileSync(join(ctx.configDir, "models.json"), "utf8"));
		assert.equal(models.providers.alpha.apiKey, "sk-test-123456789");
		const auth = JSON.parse(readFileSync(join(ctx.configDir, "auth.json"), "utf8"));
		assert.equal(auth.alpha.key, "changed-123456");
	} finally {
		cleanup(ctx);
	}
});

test("restore 非法 files 白名单：全非法 → 拒绝恢复", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		const result = ctx.manager.restore(id, ["pi/../evil.json", "unknown.txt"]);
		assert.equal(result.ok, false);
		assert.equal(result.error, "no valid files to restore");
	} finally {
		cleanup(ctx);
	}
});

test("restore 只写回白名单 key：未知/路径穿越 key 一律跳过", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		// 篡改备份包：注入路径穿越与未知 key，模拟恶意/损坏备份。
		const filePath = join(ctx.userData, "config-backups", id);
		const pkg = JSON.parse(readFileSync(filePath, "utf8"));
		pkg.files["pi/../evil.json"] = "{\"hacked\":true}";
		pkg.files["unknown/file.txt"] = "x";
		writeFileSync(filePath, JSON.stringify(pkg));

		const result = ctx.manager.restore(id);
		assert.equal(result.ok, true);
		// 恶意 key 未写盘（userData 与 pi 目录外都不应出现 evil.json）。
		assert.equal(existsSync(join(ctx.userData, "evil.json")), false);
		assert.equal(existsSync(join(ctx.root, "evil.json")), false);
	} finally {
		cleanup(ctx);
	}
});

test("delete / deleteAll 删除备份文件", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		assert.equal(ctx.manager.delete(id).ok, true);
		assert.equal(ctx.manager.list().backups.length, 0);

		ctx.manager.create("manual");
		ctx.manager.create("manual");
		assert.equal(ctx.manager.deleteAll().ok, true);
		assert.equal(ctx.manager.list().backups.length, 0);
	} finally {
		cleanup(ctx);
	}
});

test("deleteMany 批量删除：逐项删除，非法 id 跳过且不阻断其余", () => {
	const ctx = setup();
	try {
		const a = ctx.manager.create("manual");
		const b = ctx.manager.create("manual");
		const c = ctx.manager.create("manual");

		// 混合合法 + 非法 + 不存在的 id：合法的删掉，非法/不存在跳过，仍返回 ok。
		const result = ctx.manager.deleteMany([a.id, b.id, "../evil.json", "backup-9999999999999.json"]);
		assert.equal(result.ok, true);
		assert.equal(result.deleted, 2);
		const { backups } = ctx.manager.list();
		assert.equal(backups.length, 1);
		assert.equal(backups[0].id, c.id);
	} finally {
		cleanup(ctx);
	}
});

test("deleteMany 全部非法：一个都没删 → 返回失败", () => {
	const ctx = setup();
	try {
		ctx.manager.create("manual");
		// 全传非法 id → 一个都没删 → 失败。
		const result = ctx.manager.deleteMany(["../evil.json", "foo.txt"]);
		assert.equal(result.ok, false);
		assert.equal(ctx.manager.list().backups.length, 1);
	} finally {
		cleanup(ctx);
	}
});

test("ensureInitialBackups：无备份 → first-run；版本变化 → upgrade；同版本 → 不新增", () => {
	const ctx = setup();
	try {
		// 无备份：首次使用
		const first = ctx.manager.ensureInitialBackups();
		assert.equal(first.ok, true);
		let listed = ctx.manager.list();
		assert.equal(listed.backups.length, 1);
		assert.equal(listed.backups[0].reason, "first-run");

		// 同版本：不新增
		const same = ctx.manager.ensureInitialBackups();
		assert.equal(same.ok, true);
		assert.equal(ctx.manager.list().backups.length, 1);

		// 版本变化：升级备份
		const upgraded = ctx.manager.create("upgrade");
		assert.equal(upgraded.ok, true);
		assert.equal(ctx.manager.list().backups.length, 2);
		assert.equal(ctx.manager.list().backups[0].reason, "upgrade");
	} finally {
		cleanup(ctx);
	}
});

test("路径安全：非法 id（路径穿越/非备份命名）一律拒绝", () => {
	const ctx = setup();
	try {
		for (const bad of ["../evil.json", "backup-1.json/../x", "other.json", "backup-x.json", ""]) {
			assert.equal(ctx.manager.delete(bad).ok, false, `delete(${bad})`);
			assert.equal(ctx.manager.restore(bad).ok, false, `restore(${bad})`);
			assert.equal(ctx.manager.read(bad), null, `read(${bad})`);
		}
	} finally {
		cleanup(ctx);
	}
});

test("notifyConfigSaved 防抖：窗口内多次调用只生成一份 on-save 备份", async () => {
	const ctx = setup();
	try {
		ctx.manager.notifyConfigSaved();
		ctx.manager.notifyConfigSaved();
		ctx.manager.notifyConfigSaved();
		await new Promise((resolve) => setTimeout(resolve, 80));
		const listed = ctx.manager.list();
		assert.equal(listed.backups.length, 1);
		assert.equal(listed.backups[0].reason, "on-save");
	} finally {
		cleanup(ctx);
	}
});

test("redactSecrets：非 JSON 原样返回；短值不误伤", () => {
	// 非 JSON 文本原样
	const nonJson = redactSecrets("not-json", "pi/models.json");
	assert.equal(nonJson.text, "not-json");
	assert.equal(nonJson.redacted, false);
	// 短 key 值不替换（避免误伤 "key": "models" 类标识符）
	const shortKey = redactSecrets(JSON.stringify({ key: "abc" }), "pi/auth.json");
	assert.equal(shortKey.redacted, false);
	// 嵌套数组里的 secret 也脱敏
	const nested = redactSecrets(
		JSON.stringify({ providers: { a: { list: [{ apiKey: "sk-long-enough-123" }] } } }),
		"pi/models.json",
	);
	assert.equal(nested.redacted, true);
	assert.ok(!nested.text.includes("sk-long-enough-123"));
});
