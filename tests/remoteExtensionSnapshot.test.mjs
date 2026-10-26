/**
 * 远端内置扩展镜像表与生效快照（P4.4 扩展面）。
 *
 * 这组用例钉住三件事：
 * 1. **每个内置扩展都必须有一个远端处置**——新增扩展忘记分类时先红在契约测试，而不是线上悄悄少一个；
 * 2. 注入名单的判定顺序与本地一致（noExtensions → hidden → 默认关闭 → removed → 远端处置 → 快照存在 → 标题开关），
 *    且 `remote-needs-env` 只在环境通道可用时进名单；
 * 3. 生效快照**只认整份校验通过的那一份**（覆盖层优先，损坏就回落，两边都不行就不给远端）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const snapshotModule = loadTsCommonJs("src/main/extensions/remoteExtensionSnapshot.ts");
const builtIns = loadTsCommonJs("src/main/extensions/builtInExtensions.ts");

const { REMOTE_EXTENSION_DISPOSITIONS, listRemoteInjectableExtensionNames, readEffectiveExtensionSnapshot, remoteExtensionSnapshotFileNames, hasRemoteExtensionDependencies } = snapshotModule;
const { BUILT_IN_EXTENSIONS, INTERNAL_BUILT_IN_EXTENSIONS } = builtIns;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function makeDir(t, prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** 一份通过 `readVerifiedArtifact` 的目录：清单 + 每个文件的真实字节。 */
function writeArtifact(t, files) {
	const dir = makeDir(t, "pideck-ext-snapshot-");
	const manifestFiles = [];
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content);
		manifestFiles.push({ name, sha256: sha256(content), bytes: Buffer.byteLength(content, "utf8") });
	}
	writeFileSync(join(dir, "extensions-manifest.json"), JSON.stringify({ schemaVersion: 1, version: "1.0.0", bundleSha256: sha256(JSON.stringify(manifestFiles)), fileCount: manifestFiles.length, files: manifestFiles }));
	return dir;
}

test("每一份内置扩展都在镜像表里有明确处置", () => {
	const names = [...BUILT_IN_EXTENSIONS, ...INTERNAL_BUILT_IN_EXTENSIONS];
	for (const name of names) {
		const disposition = REMOTE_EXTENSION_DISPOSITIONS[name];
		assert.ok(["remote", "remote-needs-env", "local-only", "not-applicable"].includes(disposition), `${name} 缺少远端处置`);
	}
	assert.equal(Object.keys(REMOTE_EXTENSION_DISPOSITIONS).length, names.length, "镜像表不得出现已删除的扩展名");
});

test("注入名单：顺序与本地一致，local-only/not-applicable 都不进远端", () => {
	const available = new Set([...BUILT_IN_EXTENSIONS, ...INTERNAL_BUILT_IN_EXTENSIONS]);
	const names = listRemoteInjectableExtensionNames({ available, envAvailable: true });
	// 顺序来自 BUILT_IN_EXTENSIONS：request-size 在 ask 之前、plan 在 todo 之前。
	assert.ok(names.indexOf("pi-deck-request-size-recovery.ts") < names.indexOf("pi-deck-ask-question.ts"));
	assert.ok(names.indexOf("pi-deck-plan-mode.ts") < names.indexOf("pi-deck-todo.ts"));
	// 注：dev 已下线「已隐藏 / 默认关闭（opt-in）」两组内置扩展（GUI 桥与扩展点面板随之下线），
	// 那两道判据不再存在；这里只验证处置表与顺序，以及 local-only/not-applicable 的排除。
	for (const localOnly of Object.entries(REMOTE_EXTENSION_DISPOSITIONS).filter(([, value]) => value === "local-only" || value === "not-applicable")) assert.equal(names.includes(localOnly[0]), false);
	assert.equal(names.includes("pi-deck-trash-guard.ts"), false);
	assert.equal(names.includes("pi-deck-vision.ts"), false);
	assert.equal(names.includes("pi-deck-shell-proxy.ts"), false);
});

test("注入名单：安全门只有 env 通道可用时才进名单", () => {
	const available = new Set([...BUILT_IN_EXTENSIONS, ...INTERNAL_BUILT_IN_EXTENSIONS]);
	const withoutEnv = listRemoteInjectableExtensionNames({ available, envAvailable: false });
	const withEnv = listRemoteInjectableExtensionNames({ available, envAvailable: true });
	assert.equal(withoutEnv.includes("pi-deck-security-gate.ts"), false);
	assert.equal(withEnv.includes("pi-deck-security-gate.ts"), true);
	// 其余扩展不受 env 通道影响。
	for (const name of withEnv) if (name !== "pi-deck-security-gate.ts") assert.ok(withoutEnv.includes(name), `${name} 不应依赖 env`);
});

test("注入名单：noExtensions / removed / 自动标题开关逐个生效", () => {
	const available = new Set([...BUILT_IN_EXTENSIONS, ...INTERNAL_BUILT_IN_EXTENSIONS]);
	assert.deepEqual([...listRemoteInjectableExtensionNames({ available, noExtensions: true })], []);
	const withoutTodo = listRemoteInjectableExtensionNames({ available, removedBuiltInExtensions: ["pi-deck-todo.ts"] });
	assert.equal(withoutTodo.includes("pi-deck-todo.ts"), false);
	assert.equal(withoutTodo.includes("pi-deck-plan-mode.ts"), true);
	const noTitle = listRemoteInjectableExtensionNames({ available, autoSessionTitle: false });
	assert.equal(noTitle.includes("pi-deck-session-title.ts"), false);
	// 快照里不存在（旧/半截快照）就跳过，绝不凭“应该存在”注入。
	const partial = listRemoteInjectableExtensionNames({ available: new Set(["pi-deck-plan-mode.ts"]) });
	assert.deepEqual([...partial], ["pi-deck-plan-mode.ts"]);
});

test("生效快照：覆盖层优先，整份校验通过才算数", (t) => {
	const files = { "pi-deck-plan-mode.ts": "export default function () {}\n", "pi-deck-todo.ts": "export default function () {}\n", "pi-deck-todo-state.ts": "export const state = 1;\n" };
	const overlay = writeArtifact(t, files);
	const base = writeArtifact(t, files);
	const snapshot = readEffectiveExtensionSnapshot({ appPath: "/unused", resourcesPath: "/unused", isDev: false, overlayDir: overlay });
	assert.ok(snapshot);
	assert.equal(snapshot.dir, overlay);
	assert.deepEqual([...remoteExtensionSnapshotFileNames(snapshot.manifest)].sort(), Object.keys(files).sort());
	assert.equal(hasRemoteExtensionDependencies(new Set(remoteExtensionSnapshotFileNames(snapshot.manifest))), true);
	assert.ok(base);

	// 覆盖层被篡改 ⇒ 整份校验失败 ⇒ 回落随包 base，而不是把坏字节传远端。
	writeFileSync(join(overlay, "pi-deck-plan-mode.ts"), "export default function () { /* tampered */ }\n");
	const fallback = readEffectiveExtensionSnapshot({ appPath: "/unused", resourcesPath: "/unused", isDev: false, overlayDir: overlay });
	assert.equal(fallback, undefined, "测试里 base 路径不存在：损坏的覆盖层必须被拒绝而不是被当成有效");
});

test("生效快照：没有覆盖层时读随包目录", (t) => {
	const files = { "pi-deck-ask-question.ts": "export default function () {}\n" };
	const baseDir = writeArtifact(t, files);
	const snapshot = readEffectiveExtensionSnapshot({ appPath: join(baseDir, ".."), resourcesPath: join(baseDir, ".."), isDev: true, overlayDir: join(baseDir, "missing-overlay") });
	assert.equal(snapshot, undefined, "目录布局不符时不得凭空构造快照");
	const resourcesDir = join(baseDir, "resources", "extensions");
	mkdirSync(resourcesDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(resourcesDir, name), content);
	const manifest = {
		schemaVersion: 1,
		version: "1.0.0",
		bundleSha256: "c".repeat(64),
		fileCount: 1,
		files: [{ name: "pi-deck-ask-question.ts", sha256: sha256(files["pi-deck-ask-question.ts"]), bytes: Buffer.byteLength(files["pi-deck-ask-question.ts"], "utf8") }],
	};
	writeFileSync(join(resourcesDir, "extensions-manifest.json"), JSON.stringify(manifest));
	const fromBase = readEffectiveExtensionSnapshot({ appPath: baseDir, resourcesPath: baseDir, isDev: true, overlayDir: join(baseDir, "missing-overlay") });
	assert.ok(fromBase);
	assert.equal(fromBase.dir, resourcesDir);
});

test("依赖文件必须随快照上传，缺了就不能声称快照可用", () => {
	assert.equal(hasRemoteExtensionDependencies(new Set(["pi-deck-todo.ts"])), false);
	assert.equal(hasRemoteExtensionDependencies(new Set(["pi-deck-todo.ts", "pi-deck-todo-state.ts"])), true);
});
